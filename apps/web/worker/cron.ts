// Cron (minutes 0/15/30/45 of the "* * * * *" trigger; other minutes run the market ingest, see handleScheduled): reconcile Merchant processing status for recent listings (bounded batch), apply retention, and keep the hero
// SKU's SerpApi price warm (public visitors can only read the cache, see feeds/run.ts `allowPaid`).
// Idempotent: re-running only re-reads status and re-deletes already-expired rows.
// Each step is isolated: a reconcile failure never skips the purge (the purge is the only enforcement of the
// eBay 6 h limit in D1) and vice versa. Failures are logged by error code only, never by message.
import { listDueForReconcile, purgeObservations, touchListingChecked } from './db/listings.ts';
import type { ListingRow } from './db/listings.ts';
import type { AppEnv, Deps } from './env.ts';
import { missingMerchantSecrets } from './google/config.ts';
import { refreshListingStatus } from './google/listing.ts';
import { FEEDS } from './feeds/registry.ts';
import { utcDay } from './feeds/quota.ts';
import { REFRESH_REQUIRES_OPERATOR, runSource } from './feeds/run.ts';
import { HttpError } from './http.ts';
import { log } from './log.ts';
import { runMarketIngest } from './market/ingest.ts';
import { findBySku, loadManifest } from './manifest.ts';
import { parseCompareQuery } from './routes/prices.ts';

export const RECONCILE_BATCH = 25;
export type CronSummary = { checked: number; updated: number; errors: number; purged: number; merchantConfigured: boolean };

function errorCode(err: unknown): string {
  return err instanceof HttpError ? err.code : 'INTERNAL';
}

// Account-wide failures: every remaining row would fail the same way, so the batch stops at the first one.
const GLOBAL_ERRORS: ReadonlySet<string> = new Set(['MERCHANT_UNAUTHORIZED', 'MERCHANT_NOT_REGISTERED', 'MERCHANT_QUOTA', 'MERCHANT_UPSTREAM', 'NOT_CONFIGURED']);

// hero price warm-up
// Anonymous /api/prices/compare never spends the paid plans, so the one catalog item the site features is refreshed here, by
// the operator's own scheduler. On each tick, if the hero's SerpApi cache entry is missing or at least 12 h old, run exactly one
// paid refresh through the normal runSource path (daily/monthly caps and fail-closed rules intact). Steady state is two paid
// calls a day (the entry is rewritten with a 24 h life every 12 h). Never more than one paid call per tick, never another SKU,
// and never SearchApi.io: the backup is detached so an outage cannot turn one tick into two paid calls.
// A sustained outage (or a revoked key) must not drain the monthly plan: consecutive failures back off exponentially
// (1, 2, 4, 8, then 12 h) and at most WARM_MAX_FAILURES_PER_DAY failed attempts are made per UTC day.
export const HERO_SKU = 'CASE-IP16PRO-CLEAR-MAG-001';
export const WARM_REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;
export const WARM_RETRY_KEY = 'warm:v1:serpapi:retry'; // JSON {n: consecutive failures, until: epoch ms before which no attempt is made}
export const WARM_RETRY_TTL_SECONDS = 2 * 24 * 60 * 60; // outlives the longest backoff so the failure count survives it
export const WARM_FAIL_KEY_PREFIX = 'warm:v1:serpapi:fail:'; // + UTC day: failed attempts that day
export const WARM_FAIL_TTL_SECONDS = 2 * 24 * 60 * 60;
export const WARM_MAX_FAILURES_PER_DAY = 3;
export const WARM_BACKOFF_BASE_MS = 60 * 60 * 1000;
export const WARM_BACKOFF_MAX_MS = 12 * 60 * 60 * 1000;

type RetryState = { n: number; until: number };
// null = key absent or KV unreadable (today's behavior: carry on, the quota counters still fail closed); 'corrupt' = skip the tick.
async function readRetry(kv: AppEnv['CACHE']): Promise<RetryState | null | 'corrupt'> {
  let raw: string | null;
  try { raw = await kv.get(WARM_RETRY_KEY); } catch { return null; }
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<RetryState> | null;
    if (v && typeof v === 'object' && Number.isInteger(v.n) && (v.n as number) >= 0 && typeof v.until === 'number' && Number.isFinite(v.until)) return { n: v.n as number, until: v.until };
  } catch { /* corrupt */ }
  return 'corrupt';
}

async function readFailuresToday(kv: AppEnv['CACHE'], nowMs: number): Promise<number | null> {
  let raw: string | null;
  try { raw = await kv.get(WARM_FAIL_KEY_PREFIX + utcDay(nowMs)); } catch { return 0; }
  if (raw === null) return 0;
  return /^\d{1,15}$/.test(raw) ? Number.parseInt(raw, 10) : null; // corrupt: worst case
}

async function recordFailure(env: AppEnv, state: RetryState | null, nowMs: number, failuresToday: number): Promise<void> {
  const n = (state?.n ?? 0) + 1;
  const delay = Math.min(WARM_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 10), WARM_BACKOFF_MAX_MS);
  await env.CACHE.put(WARM_RETRY_KEY, JSON.stringify({ n, until: nowMs + delay }), { expirationTtl: WARM_RETRY_TTL_SECONDS }).catch(() => undefined);
  await env.CACHE.put(WARM_FAIL_KEY_PREFIX + utcDay(nowMs), String(failuresToday + 1), { expirationTtl: WARM_FAIL_TTL_SECONDS }).catch(() => undefined);
}

async function clearRetry(env: AppEnv): Promise<void> {
  try { await env.CACHE.delete(WARM_RETRY_KEY); } catch { /* best effort: the key expires on its own */ }
}

export async function warmHeroPrice(env: AppEnv, deps: Deps): Promise<string> {
  const serp = FEEDS.find((f) => f.id === 'serpapi');
  if (!serp || !serp.configured(env)) return 'unconfigured';
  const manifest = await loadManifest(env.ASSETS, env.PUBLIC_SITE_ORIGIN);
  const entry = manifest ? findBySku(manifest, HERO_SKU) : undefined;
  if (!manifest || !entry) return 'no_hero';
  // Same query (and so the same cache key) the compare route builds for this sku.
  const { q } = parseCompareQuery(new URL('https://cron.invalid/?sku=' + HERO_SKU), manifest);
  const now = deps.nowMs();
  // A failed refresh is not retried every 15 minutes: each attempt burns a daily and a monthly slot.
  const failuresToday = await readFailuresToday(env.CACHE, now);
  if (failuresToday === null || failuresToday >= WARM_MAX_FAILURES_PER_DAY) return 'daily_cap';
  const retry = await readRetry(env.CACHE);
  if (retry === 'corrupt' || (retry && now < retry.until)) return 'cooldown';
  const run = await runSource({ ...serp, fallback: undefined }, q, entry, { env, fetch: deps.fetch, nowMs: now, feeds: [serp], allowPaid: true, refreshAfterMs: WARM_REFRESH_AFTER_MS });
  if (run.mode === 'REAL' && run.cache === 'HIT') return 'fresh';
  if (run.mode === 'REAL' && run.cache === 'MISS') {
    if (retry) await clearRetry(env);
    return 'refreshed';
  }
  const code = run.error ?? 'unknown';
  if (code !== 'quota_exhausted' && code !== 'quota_unavailable' && code !== REFRESH_REQUIRES_OPERATOR) await recordFailure(env, retry, now, failuresToday);
  return code;
}

export async function runCron(env: AppEnv, deps: Deps): Promise<CronSummary> {
  const now = deps.nowMs();
  const summary: CronSummary = { checked: 0, updated: 0, errors: 0, purged: 0, merchantConfigured: missingMerchantSecrets(env, false).length === 0 };
  if (summary.merchantConfigured) {
    let due: ListingRow[] = [];
    try {
      due = await listDueForReconcile(env.DB, now, RECONCILE_BATCH);
    } catch (err) {
      summary.errors++;
      log({ event: 'cron_error', step: 'select', code: errorCode(err) });
    }
    for (const row of due) {
      summary.checked++;
      try {
        const next = await refreshListingStatus(env, deps, row);
        if (next.status !== row.status) summary.updated++;
      } catch (err) {
        summary.errors++;
        const code = errorCode(err);
        log({ event: 'cron_error', step: 'reconcile', code });
        // Push the failing row behind the unchecked ones so it cannot starve the batch. A global error bumps the row that
        // triggered it too, otherwise one persistently failing row would sort first on every tick.
        try { await touchListingChecked(env.DB, row.offer_id, now); } catch { /* best effort */ }
        if (GLOBAL_ERRORS.has(code)) break;
      }
    }
  }
  try {
    log({ event: 'cron_warm', code: await warmHeroPrice(env, deps) });
  } catch (err) {
    log({ event: 'cron_warm', code: 'WARM_FAILED', step: errorCode(err) });
  }
  try {
    summary.purged = await purgeObservations(env.DB, now);
  } catch (err) {
    summary.errors++;
    log({ event: 'cron_error', step: 'purge', code: errorCode(err) });
  }
  return summary;
}

// One deployed trigger, "* * * * *" (the Free plan allows 5 Cron Triggers per ACCOUNT, and this account is shared, so we do not add
// a second one). Minutes 0, 15, 30 and 45 run the existing reconcile/warm/purge job exactly as the old "*/15" trigger did; every
// other minute runs the market ingest. The two never share an invocation, so each keeps its own 50-subrequest budget.
// "*/15 * * * *" (tests, manual runs) still means reconcile.
export type ScheduledTask = 'reconcile' | 'ingest';
export function planScheduled(cron: string, scheduledTimeMs: number): ScheduledTask {
  if (cron === '*/15 * * * *') return 'reconcile';
  return new Date(scheduledTimeMs).getUTCMinutes() % 15 === 0 ? 'reconcile' : 'ingest';
}

// Codes are fixed short identifiers from our own code; anything else (it should not happen) is not logged verbatim.
const shortCode = (v: string | undefined): string | undefined => (v === undefined ? undefined : /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : 'INVALID');

// Never throws: a failed run is logged and retried on the next tick rather than raising a scheduled-event error. Each invocation runs
// exactly one task, so a failure in one can never skip the other.
export async function handleScheduled(controller: { cron: string; scheduledTime?: number }, env: AppEnv, deps: Deps): Promise<void> {
  const started = deps.nowMs();
  const task = planScheduled(controller.cron, controller.scheduledTime ?? started);
  try {
    if (task === 'ingest') {
      const s = await runMarketIngest(env, deps);
      // 'busy' (another run holds the lease) and the other reasons are normal outcomes: info level. Only a code means a failed run.
      log({ event: 'market_ingest', level: s.code ? 'error' : 'info', cron: controller.cron, durationMs: deps.nowMs() - started, ran: s.ran, reason: shortCode(s.reason), code: shortCode(s.code), rpcCode: s.rpcCode, reorg: s.reorg, calls: s.calls, logs: s.logs, books: s.books, trimmed: s.trimmed, skipped: s.skipped, capped: s.capped, from: s.from, to: s.to, cursor: s.cursor, head: s.head, rebuilt: s.rebuilt, graduated: s.graduated });
      return;
    }
    const s = await runCron(env, deps);
    log({ event: 'cron', cron: controller.cron, durationMs: deps.nowMs() - started, ...s });
  } catch (err) {
    log({ event: task === 'ingest' ? 'market_ingest' : 'cron', level: 'error', cron: controller.cron, durationMs: deps.nowMs() - started, fatal: true, code: errorCode(err) });
  }
}
