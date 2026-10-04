// GET /api/merchant/status — MOCK without secrets, REAL after a cheap authenticated read, DEGRADED on failure.
import type { MerchantStatus } from '../api-types.ts';
import { HttpError, json } from '../http.ts';
import { log } from '../log.ts';
import type { ErrorCode } from '../http.ts';
import type { Ctx } from '../router.ts';
import { enforceRateLimit, isAdmin, rateKey } from '../security.ts';
import { dataSourceName, merchantClientFor, merchantConfig, missingMerchantSecrets } from './config.ts';

// Two entries, never one: the public shape carries no account identifiers; the admin shape does.
// v2 also orphans any v1 entry written before the split (those may hold ids).
export const STATUS_CACHE_KEY = 'mstatus:v2';
export const STATUS_CACHE_KEY_ADMIN = 'mstatus:v2:adm';
const STATUS_TTL_SECONDS = 60;

const HINTS: Partial<Record<ErrorCode, string>> = {
  MERCHANT_NOT_REGISTERED: 'Run the setup script register step, then wait 5 minutes.',
  MERCHANT_UNAUTHORIZED: 'Add the service account as an Admin user in Merchant Center and check GOOGLE_SA_JSON.',
  MERCHANT_QUOTA: 'Merchant API quota exhausted; retry later.',
  MERCHANT_UPSTREAM: 'Merchant API unavailable; retry later.',
  NOT_CONFIGURED: 'GOOGLE_SA_JSON is malformed.',
};

// The caller-facing shape: account id, account name and data source name are admin-only.
function publicShape(body: MerchantStatus): MerchantStatus {
  if (body.mode !== 'REAL') return body;
  const { accountId: _a, accountName: _n, dataSource: _d, ...rest } = body;
  return { ...rest, hasDataSource: body.hasDataSource ?? Boolean(body.dataSource) };
}

export async function merchantStatus(c: Ctx): Promise<Response> {
  const admin = await isAdmin(c.req, c.env.ADMIN_TOKEN);
  await enforceRateLimit(c.env.RL_READ, await rateKey(c.req, 'GET /api/merchant/status', admin));
  const missing = missingMerchantSecrets(c.env, false);
  if (missing.length) {
    c.log.mode = 'MOCK';
    const body: MerchantStatus = { mode: 'MOCK', configured: false, missing };
    return json(body, c.requestId);
  }
  const cached = await c.env.CACHE.get(admin ? STATUS_CACHE_KEY_ADMIN : STATUS_CACHE_KEY);
  if (cached) {
    const stored = JSON.parse(cached) as MerchantStatus;
    // Defence in depth: a non-admin never gets more than the public shape, whatever the entry holds.
    const body = admin ? stored : publicShape(stored);
    c.log.mode = body.mode;
    return json({ ...body, cached: true }, c.requestId);
  }
  const cfg = merchantConfig(c.env);
  const checkedAt = new Date(c.deps.nowMs()).toISOString();
  let body: MerchantStatus;
  try {
    const r = await merchantClientFor(c.env, c.deps).request<{ accountName?: string }>({ method: 'GET', path: '/accounts/v1/accounts/' + cfg.accountId });
    const hasDs = missingMerchantSecrets(c.env, true).length === 0;
    body = { mode: 'REAL', configured: true, accountId: cfg.accountId, accountName: r.data.accountName ?? null, dataSource: hasDs ? dataSourceName(cfg) : null, hasDataSource: hasDs, registered: true, latencyMs: r.latencyMs, checkedAt };
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 'INTERNAL';
    // Code and error class only: never the message (it may carry upstream text).
    log({ event: 'merchant_status_error', requestId: c.requestId, code, name: err instanceof Error ? err.name : 'unknown' });
    body = { mode: 'DEGRADED', configured: true, registered: code !== 'MERCHANT_NOT_REGISTERED', error: { code, hint: (err instanceof HttpError && HINTS[err.code]) || 'See Workers logs for the request id.' }, checkedAt };
  }
  // A failed cache write must not fail a status check that already succeeded.
  const pub = publicShape(body);
  try {
    await c.env.CACHE.put(STATUS_CACHE_KEY, JSON.stringify(pub), { expirationTtl: STATUS_TTL_SECONDS });
    await c.env.CACHE.put(STATUS_CACHE_KEY_ADMIN, JSON.stringify(body), { expirationTtl: STATUS_TTL_SECONDS });
  } catch {
    // ignore: the next request re-checks
  }
  c.log.mode = body.mode;
  return json(admin ? body : pub, c.requestId);
}
