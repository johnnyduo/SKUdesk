// GET /api/prices/sources and GET /api/prices/compare?sku=&gtin=&q=&country=US
import type { CompareResult, SourceInfo, SourcesResponse } from '../api-types.ts';
import { insertObservations } from '../db/listings.ts';
import type { ObservationRow } from '../db/listings.ts';
import type { SourceRun } from '../feeds/compare.ts';
import { FEEDS } from '../feeds/registry.ts';
import { feedQuotaRemaining, runCompare } from '../feeds/run.ts';
import type { FeedQuery, PriceFeed } from '../feeds/types.ts';
import { isValidGtin, sameGtin } from '../gtin.ts';
import { HttpError, json } from '../http.ts';
import { log } from '../log.ts';
import { findByGtin, findBySku, loadManifest } from '../manifest.ts';
import type { ManifestEntry, SkuManifest } from '../manifest.ts';
import type { Ctx } from '../router.ts';
import { enforceRateLimit, isAdmin, rateKey } from '../security.ts';

export type ParsedCompare = { q: FeedQuery; entry: ManifestEntry | null };

const SKU = /^[A-Za-z0-9._-]{1,64}$/;

export function parseCompareQuery(url: URL, manifest: SkuManifest | null): ParsedCompare {
  const p = url.searchParams;
  const country = p.get('country') ?? 'US';
  if (country !== 'US') throw new HttpError(400, 'BAD_REQUEST', 'country must be US (USD only in v1)');
  const sku = p.get('sku');
  let entry: ManifestEntry | null = null;
  if (sku !== null) {
    if (!SKU.test(sku)) throw new HttpError(400, 'BAD_REQUEST', 'sku is malformed');
    entry = (manifest && findBySku(manifest, sku)) || null;
    if (!entry) throw new HttpError(404, 'UNKNOWN_SKU', 'sku is not in the build manifest');
  }
  const rawGtin = p.get('gtin');
  if (rawGtin !== null && !isValidGtin(rawGtin)) throw new HttpError(400, 'BAD_REQUEST', 'gtin must be 8, 12, 13 or 14 digits with a valid check digit');
  // A known sku pins the item: a caller-supplied GTIN for a different product is refused outright. An entry without a
  // GTIN accepts none: any valid-but-unrelated GTIN would otherwise mint a fresh metered cache key per distinct value.
  if (entry && rawGtin && (!entry.gtin || !sameGtin(rawGtin, entry.gtin))) throw new HttpError(400, 'BAD_REQUEST', 'gtin does not match the sku');
  if (!entry && rawGtin && manifest) entry = findByGtin(manifest, rawGtin) ?? null;
  const query = (p.get('q') ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (query.length > 120) throw new HttpError(400, 'BAD_REQUEST', 'q must be at most 120 characters');
  const gtin = rawGtin ?? entry?.gtin ?? null;
  // Once the request resolves to a catalog item (by sku or by its GTIN) the keyword is the catalog title, never caller text:
  // metered keyword sources (SerpApi) must not be usable to spend slots on arbitrary strings.
  const finalQuery = entry ? entry.title : query;
  if (!gtin && !finalQuery) throw new HttpError(400, 'BAD_REQUEST', 'provide sku, gtin or q');
  return { q: { gtin, query: finalQuery, country: 'US' }, entry };
}

export function observationsFrom(result: CompareResult, runs: SourceRun[], nowMs: number): ObservationRow[] {
  const fresh = new Set(runs.filter((r) => r.mode === 'REAL' && r.cache === 'MISS').map((r) => r.id));
  return result.offers
    .filter((o) => fresh.has(o.source))
    .map((o) => ({ source: o.source, gtin: result.query.gtin, query: result.query.query, price_cents: o.totalCents, currency: 'USD' as const, locked: (o.locked ? 1 : 0) as 0 | 1, title: o.title.slice(0, 200), url: o.url || null, observed_at: nowMs }));
}

export async function priceSources(c: Ctx): Promise<Response> {
  await enforceRateLimit(c.env.RL_READ, await rateKey(c.req, 'GET /api/prices/sources', false));
  const now = c.deps.nowMs();
  const sources: SourceInfo[] = [];
  for (const f of FEEDS) {
    const configured = f.configured(c.env);
    const remaining = (feed: PriceFeed, on: boolean) => (on ? feedQuotaRemaining(feed, c.env, c.env.CACHE, now).catch(() => null) : Promise.resolve(null)); // KV is a brake, not a dependency
    const info: SourceInfo = {
      id: f.id, label: f.label, attribution: f.attribution, mode: configured ? 'REAL' : 'MOCK', configured, searchesByGtin: f.searchesByGtin,
      dailyBudget: f.dailyBudget(c.env), quotaRemaining: await remaining(f, configured),
    };
    if (f.fallback) {
      const on = f.fallback.configured(c.env);
      info.backup = { id: f.fallback.id, label: f.fallback.label, configured: on, quotaRemaining: await remaining(f.fallback, on) };
    }
    sources.push(info);
  }
  const out: SourcesResponse = { sources };
  return json(out, c.requestId);
}

export async function priceCompare(c: Ctx): Promise<Response> {
  // Only a verified operator (constant-time X-Admin-Token check) may cause a paid upstream call; everyone else reads the cache.
  const admin = await isAdmin(c.req, c.env.ADMIN_TOKEN);
  await enforceRateLimit(c.env.RL_COMPARE, await rateKey(c.req, 'GET /api/prices/compare', admin));
  const manifest = await loadManifest(c.env.ASSETS, c.req.url);
  const { q, entry } = parseCompareQuery(c.url, manifest);
  const now = c.deps.nowMs();
  // Keyword-only sources (SerpApi) can never lock on a free-text query and are metered: only ask them about catalog items.
  const feeds = entry ? FEEDS : FEEDS.filter((f) => f.searchesByGtin);
  const { result, runs } = await runCompare(q, entry, { env: c.env, fetch: c.deps.fetch, nowMs: now, feeds, allowPaid: admin });
  const rows = observationsFrom(result, runs, now);
  if (rows.length) c.exec.waitUntil(insertObservations(c.env.DB, rows).catch(() => {
    log({ level: 'warn', event: 'observations_insert_failed', code: 'D1_INSERT_FAILED', requestId: c.requestId });
    return 0;
  }));
  const modes = result.sources.map((s) => s.mode);
  c.log.mode = modes.includes('REAL') ? 'REAL' : modes.includes('DEGRADED') ? 'DEGRADED' : 'MOCK';
  c.log.sources = result.sources.map((s) => s.id + ':' + s.mode).join(',');
  return json(result, c.requestId);
}
