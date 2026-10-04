// Listing routes: publish (dry-run by default), read status, delete. Live writes need X-Admin-Token AND dryRun:false.
import type { DeleteResponse, DryRunResponse, Issue, ListingStatusResponse, PublishResponse } from '../api-types.ts';
import { getListing, saveListing, setListingStatus, setRefreshedListingStatus } from '../db/listings.ts';
import type { ListingRow } from '../db/listings.ts';
import type { AppEnv, Deps } from '../env.ts';
import { sameGtin } from '../gtin.ts';
import { HttpError, json } from '../http.ts';
import { checkListingAgainstManifest, loadManifest } from '../manifest.ts';
import type { Ctx } from '../router.ts';
import { assertOrigin, enforceRateLimit, isAdmin, rateKey, readJsonBody } from '../security.ts';
import { dataSourceName, merchantClientFor, merchantConfig, missingMerchantSecrets } from './config.ts';
import { centsToMicros, insertPath, payloadHash, productInputPath, productPath, toProductInput, validateListingRequest } from './mapping.ts';
import { deriveStatus } from './productStatus.ts';
import type { DerivedStatus } from './productStatus.ts';

const OFFER_ID = /^[A-Za-z0-9._-]{1,50}$/;
const STATUS_STALE_MS = 5 * 60 * 1000;
const LIVE_STATUSES = ['SUBMITTED', 'PROCESSING', 'APPROVED'];

function offerIdParam(c: Ctx): string {
  const id = c.params.offerId ?? '';
  if (!OFFER_ID.test(id)) throw new HttpError(400, 'BAD_REQUEST', 'offerId must match [A-Za-z0-9._-]{1,50}');
  return id;
}

export async function publishListing(c: Ctx): Promise<Response> {
  assertOrigin(c.req, c.env.PUBLIC_SITE_ORIGIN);
  const admin = await isAdmin(c.req, c.env.ADMIN_TOKEN);
  await enforceRateLimit(c.env.RL_WRITE, await rateKey(c.req, 'POST /api/merchant/listing', admin));
  const req = validateListingRequest(await readJsonBody(c.req), c.env.PUBLIC_SITE_ORIGIN);
  const check = checkListingAgainstManifest(await loadManifest(c.env.ASSETS, c.req.url), req.link, req.imageLink, req.priceCents);
  if (!check.ok) throw new HttpError(422, 'LINK_NOT_IN_MANIFEST', check.reason);
  // Only a GTIN the landing page carries may be sent: the example catalog's placeholder GTINs are never published.
  if (req.gtin !== null && !sameGtin(req.gtin, check.entry.gtin)) throw new HttpError(422, 'LINK_NOT_IN_MANIFEST', 'gtin must equal the landing page GTIN (' + (check.entry.gtin ?? 'none assigned') + ')');
  if (req.availability !== check.entry.availability) throw new HttpError(422, 'LINK_NOT_IN_MANIFEST', 'availability must equal the landing page availability (' + check.entry.availability + ')');
  const cfg = merchantConfig(c.env);
  const body = toProductInput(req, cfg);
  const missing = missingMerchantSecrets(c.env, true);

  if (req.dryRun) {
    c.log.mode = 'DRY_RUN';
    const acct = admin && missing.length === 0 ? cfg.accountId : '{MERCHANT_ACCOUNT_ID}';
    const ds = admin && missing.length === 0 ? cfg.dataSourceId : '{MERCHANT_DATA_SOURCE_ID}';
    const out: DryRunResponse = {
      mode: 'DRY_RUN', offerId: req.offerId, configured: missing.length === 0,
      wouldSend: { method: 'POST', path: insertPath(acct), query: { dataSource: 'accounts/' + acct + '/dataSources/' + ds }, body },
    };
    return json(out, c.requestId);
  }
  if (!admin) throw new HttpError(401, 'UNAUTHORIZED', 'live publish requires a valid X-Admin-Token');
  if (missing.length) throw new HttpError(503, 'NOT_CONFIGURED', 'missing secrets: ' + missing.join(', '));

  // The hash covers the target data source too: changing MERCHANT_DATA_SOURCE_ID must re-insert.
  const hash = await payloadHash(body, dataSourceName(cfg));
  const existing = await getListing(c.env.DB, req.offerId);
  c.log.mode = 'REAL';
  if (existing && existing.payload_hash === hash && LIVE_STATUSES.includes(existing.status)) {
    const out: PublishResponse = { mode: 'REAL', offerId: req.offerId, name: existing.product_name, status: existing.status, idempotent: true, updated: false };
    return json(out, c.requestId);
  }
  const r = await merchantClientFor(c.env, c.deps).request<{ name?: unknown }>({
    method: 'POST', path: insertPath(cfg.accountId), query: { dataSource: dataSourceName(cfg) }, body,
  });
  const name = typeof r.data.name === 'string' ? r.data.name : null;
  await saveListing(c.env.DB, {
    offer_id: req.offerId, lot_id: req.lotId, product_name: name, status: 'SUBMITTED', issues_json: null,
    price_micros: Number(centsToMicros(req.priceCents)), currency: 'USD', payload_hash: hash,
  }, c.deps.nowMs());
  const out: PublishResponse = { mode: 'REAL', offerId: req.offerId, name, status: 'SUBMITTED', idempotent: false, updated: existing !== null };
  return json(out, c.requestId, existing ? 200 : 201);
}

// Reads the processed product and stores the derived status. 404 (not processed yet) counts as PROCESSING.
export async function refreshListingStatus(env: AppEnv, deps: Deps, row: ListingRow): Promise<ListingRow> {
  const cfg = merchantConfig(env);
  let derived: DerivedStatus;
  try {
    const r = await merchantClientFor(env, deps).request<unknown>({ method: 'GET', path: productPath(cfg.accountId, cfg.language, cfg.feedLabel, row.offer_id) });
    derived = deriveStatus(r.data, cfg.country);
  } catch (err) {
    if (err instanceof HttpError && err.code === 'MERCHANT_NOT_FOUND') derived = { status: 'PROCESSING', issues: [] };
    else throw err;
  }
  const now = deps.nowMs();
  const issuesJson = JSON.stringify(derived.issues);
  await setRefreshedListingStatus(env.DB, row.offer_id, derived.status, issuesJson, now);
  // Re-read: the guarded UPDATE is a no-op when a delete (or re-publish) won the race, and the caller must see what is stored.
  return (await getListing(env.DB, row.offer_id)) ?? row;
}

export async function getListingStatus(c: Ctx): Promise<Response> {
  const admin = await isAdmin(c.req, c.env.ADMIN_TOKEN);
  await enforceRateLimit(c.env.RL_READ, await rateKey(c.req, 'GET /api/merchant/listing/:offerId', admin));
  const offerId = offerIdParam(c);
  const row = await getListing(c.env.DB, offerId);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'no listing for this offerId');
  let current = row;
  let refreshError: string | undefined;
  const stale = row.last_checked_at === null || c.deps.nowMs() - row.last_checked_at > STATUS_STALE_MS;
  if ((row.status === 'SUBMITTED' || row.status === 'PROCESSING') && stale && missingMerchantSecrets(c.env, false).length === 0) {
    try {
      current = await refreshListingStatus(c.env, c.deps, row);
    } catch (err) {
      refreshError = err instanceof HttpError ? err.code : 'INTERNAL';
    }
  }
  c.log.mode = 'REAL';
  const out: ListingStatusResponse = {
    mode: 'REAL', offerId, status: current.status, issues: current.issues_json ? (JSON.parse(current.issues_json) as Issue[]) : [],
    lastCheckedAt: current.last_checked_at === null ? null : new Date(current.last_checked_at).toISOString(),
  };
  // The Merchant product resource name embeds the account id: only a verified admin sees it.
  if (admin) out.productName = current.product_name;
  if (refreshError) out.refreshError = refreshError;
  return json(out, c.requestId);
}

export async function deleteListing(c: Ctx): Promise<Response> {
  assertOrigin(c.req, c.env.PUBLIC_SITE_ORIGIN);
  const admin = await isAdmin(c.req, c.env.ADMIN_TOKEN);
  await enforceRateLimit(c.env.RL_WRITE, await rateKey(c.req, 'DELETE /api/merchant/listing/:offerId', admin));
  if (!admin) throw new HttpError(401, 'UNAUTHORIZED', 'delete requires a valid X-Admin-Token');
  const offerId = offerIdParam(c);
  const missing = missingMerchantSecrets(c.env, true);
  if (missing.length) throw new HttpError(503, 'NOT_CONFIGURED', 'missing secrets: ' + missing.join(', '));
  const cfg = merchantConfig(c.env);
  try {
    await merchantClientFor(c.env, c.deps).request<unknown>({
      method: 'DELETE', path: productInputPath(cfg.accountId, cfg.language, cfg.feedLabel, offerId), query: { dataSource: dataSourceName(cfg) },
    });
  } catch (err) {
    if (!(err instanceof HttpError && err.code === 'MERCHANT_NOT_FOUND')) throw err;
  }
  const row = await getListing(c.env.DB, offerId);
  if (row) await setListingStatus(c.env.DB, offerId, 'DELETED', row.issues_json, c.deps.nowMs());
  c.log.mode = 'REAL';
  const out: DeleteResponse = { mode: 'REAL', offerId, status: 'DELETED' };
  return json(out, c.requestId);
}
