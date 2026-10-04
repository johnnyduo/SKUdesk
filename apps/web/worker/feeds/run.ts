// Runs every registered source for one query: MOCK when unconfigured, else fresh cache -> quota -> live call,
// falling back to a STALE cached copy (within the source's terms) on quota stop or upstream failure.
// One failing source never fails the compare call. Scarce sources (SerpApi) set freshMs and monthlyBudget; a backup (SearchApi.io)
// answers only after the primary's upstream failure.
import type { AppEnv, Fetch } from '../env.ts';
import { HttpError } from '../http.ts';
import type { ManifestEntry } from '../manifest.ts';
import { FRESH_MS, feedCacheKey, readFeedCache, writeFeedCache } from './cache.ts';
import { buildCompare } from './compare.ts';
import type { CompareResult } from '../api-types.ts';
import type { SourceRun } from './compare.ts';
import { testOffers } from './testdata.ts';
import { QuotaWriteError, quotaRemaining, quotaRemainingMonthly, quotaRemainingTotal, tryConsume, tryConsumeMonthly, tryConsumeTotal } from './quota.ts';
import type { QuotaResult } from './quota.ts';
import type { CacheKV } from './cache.ts';
import type { FeedQuery, PriceFeed } from './types.ts';

export const FEED_TIMEOUT_MS = 8000;
// `allowPaid: false` (the public, non-operator path) never spends a paid feed's plan: a paid source is answered from the KV cache
// only (fresh HIT, or a usable STALE copy) and otherwise reports `refresh_requires_operator`. Default true: only callers that
// act for the operator (valid X-Admin-Token) or the cron warm-up reach a paid call. `refreshAfterMs` makes a cached copy older
// than that count as not fresh (the cron warm-up refreshes the hero entry at 12 h instead of waiting for the 24 h expiry).
export type RunDeps = { env: AppEnv; fetch: Fetch; nowMs: number; feeds: PriceFeed[]; timeoutMs?: number; allowPaid?: boolean; refreshAfterMs?: number };
export const REFRESH_REQUIRES_OPERATOR = 'refresh_requires_operator';

// Calls left today, capped by the month's (and the plan's lifetime) remaining calls when the source has those caps.
export async function feedQuotaRemaining(feed: PriceFeed, env: AppEnv, kv: CacheKV, nowMs: number): Promise<number> {
  let left = await quotaRemaining(kv, feed.id, feed.dailyBudget(env), nowMs);
  if (feed.monthlyBudget) left = Math.min(left, await quotaRemainingMonthly(kv, feed.id, feed.monthlyBudget(env), nowMs));
  if (feed.totalBudget) left = Math.min(left, await quotaRemainingTotal(kv, feed.id, feed.totalBudget(env), nowMs));
  return left;
}

async function runOne(feed: PriceFeed, q: FeedQuery, entry: ManifestEntry | null, d: RunDeps): Promise<SourceRun> {
  const head = { id: feed.id, label: feed.label, attribution: feed.attribution };
  if (!feed.configured(d.env)) {
    const offers = testOffers(feed.id, q, entry?.priceCents ?? 999, entry?.title ?? (q.query || 'GTIN ' + (q.gtin ?? '')), d.nowMs);
    return { ...head, configured: false, mode: 'MOCK', cache: 'NONE', offers, error: null, quotaRemaining: null };
  }
  const kv = d.env.CACHE;
  const key = await feedCacheKey(feed.id, q);
  // KV is a cache and a cost brake, not a dependency: a read failure means "no cached copy", never a 500.
  const read = await readFeedCache(kv, key).catch(() => null);
  // An entry stamped in the future (clock skew or tampering) is neither fresh nor usable as stale: treat it as no cache.
  const cached = read && read.fetchedAtMs <= d.nowMs ? read : null;
  const age = cached ? d.nowMs - cached.fetchedAtMs : Number.POSITIVE_INFINITY;
  if (cached && age < Math.min(feed.freshMs ?? FRESH_MS, d.refreshAfterMs ?? Number.POSITIVE_INFINITY)) {
    return { ...head, configured: true, mode: 'REAL', cache: 'HIT', offers: cached.offers, error: null, quotaRemaining: await feedQuotaRemaining(feed, d.env, kv, d.nowMs).catch(() => null) };
  }
  const usable = cached && age <= feed.maxStaleMs ? cached : null;
  const fallback = (error: string, remaining: number | null): SourceRun => ({
    ...head, configured: true, mode: 'DEGRADED', cache: usable ? 'STALE' : 'NONE', offers: usable ? usable.offers : [], error, quotaRemaining: remaining,
  });
  // Public (non-operator) request for a paid source: never reaches the quota counters or the network. Nothing usable cached
  // -> the source is configured and REAL but has nothing to show; a usable STALE copy is still served (labeled DEGRADED).
  if (feed.paid && d.allowPaid === false) {
    if (usable) return fallback(REFRESH_REQUIRES_OPERATOR, null);
    return { ...head, configured: true, mode: 'REAL', cache: 'NONE', offers: [], error: REFRESH_REQUIRES_OPERATOR, quotaRemaining: null };
  }
  // Check the monthly cap first so a month-exhausted source never burns a daily slot.
  // Policy when KV misbehaves:
  //  - a counter READ failure always fails closed (quota_unavailable): we cannot tell whether we are under budget;
  //  - a counter WRITE failure after a successful read that was under budget still allows the call for sources WITHOUT
  //    a monthly cap (eBay, Best Buy: generous daily budgets, a missed increment only under-counts), so a KV blip does
  //    not take a healthy source down; sources WITH a monthly or lifetime cap (SerpApi, SearchApi.io: hard-metered free plans) keep failing closed.
  let remaining: number;
  try {
    if (feed.monthlyBudget && (await quotaRemainingMonthly(kv, feed.id, feed.monthlyBudget(d.env), d.nowMs)) <= 0) return fallback('quota_exhausted', 0);
    if (feed.totalBudget && (await quotaRemainingTotal(kv, feed.id, feed.totalBudget(d.env), d.nowMs)) <= 0) return fallback('quota_exhausted', 0);
    const dailyBudget = feed.dailyBudget(d.env);
    let quota: QuotaResult;
    try {
      quota = await tryConsume(kv, feed.id, dailyBudget, d.nowMs);
    } catch (err) {
      if (!(err instanceof QuotaWriteError) || feed.monthlyBudget || feed.totalBudget) throw err;
      quota = { allowed: true, used: err.used, remaining: Math.max(0, dailyBudget - err.used - 1) };
    }
    if (!quota.allowed) return fallback('quota_exhausted', 0);
    remaining = quota.remaining;
    if (feed.monthlyBudget) {
      const month = await tryConsumeMonthly(kv, feed.id, feed.monthlyBudget(d.env), d.nowMs);
      if (!month.allowed) return fallback('quota_exhausted', 0);
      remaining = Math.min(remaining, month.remaining);
    }
    if (feed.totalBudget) {
      const total = await tryConsumeTotal(kv, feed.id, feed.totalBudget(d.env), d.nowMs);
      if (!total.allowed) return fallback('quota_exhausted', 0);
      remaining = Math.min(remaining, total.remaining);
    }
  } catch {
    return fallback('quota_unavailable', null);
  }
  try {
    const offers = await feed.search(q, { env: d.env, fetch: d.fetch, signal: AbortSignal.timeout(d.timeoutMs ?? FEED_TIMEOUT_MS), nowMs: d.nowMs });
    await writeFeedCache(kv, key, { fetchedAtMs: d.nowMs, offers }, feed.maxStaleMs).catch(() => undefined); // the live result is still good
    return { ...head, configured: true, mode: 'REAL', cache: 'MISS', offers, error: null, quotaRemaining: remaining };
  } catch (err) {
    return fallback(err instanceof HttpError ? err.code : 'FEED_UPSTREAM', remaining);
  }
}

// Provenance carried by a run that a backup source answered: whom it stands in for and why that source did not serve.
export type FedRun = SourceRun & { fallbackFor?: string; primaryError?: string };

// A source with a `fallback` hands over to it only on a real UPSTREAM failure (FEED_UPSTREAM: HTTP error, timeout, network or
// bad response) with nothing cached to show. A STALE copy is preferred to spending a scarce backup credit; a backup that is
// unconfigured or also fails leaves the primary's own result. The primary's own quota stops (quota_exhausted: daily or
// monthly cap, quota_unavailable: counter unreadable or unwritable) are app-side brakes, not outages: they never reach the
// backup, otherwise the backup would bypass the rationing, raise spend on the same Google Shopping data and drain its pool.
// refresh_requires_operator (public request, paid source, nothing cached) is a brake of the same kind: it makes no call at all.
const isAppBrake = (error: string | null): boolean => error === 'quota_exhausted' || error === 'quota_unavailable' || error === REFRESH_REQUIRES_OPERATOR;

export async function runSource(feed: PriceFeed, q: FeedQuery, entry: ManifestEntry | null, d: RunDeps): Promise<FedRun> {
  const run = await runOne(feed, q, entry, d);
  const backup = feed.fallback;
  if (backup && run.mode === 'DEGRADED' && run.cache === 'NONE' && !isAppBrake(run.error) && backup.configured(d.env) && !(backup.paid && d.allowPaid === false)) {
    const alt = await runOne(backup, q, entry, d);
    if (alt.mode === 'REAL') return { ...alt, fallbackFor: feed.id, ...(run.error ? { primaryError: run.error } : {}) };
  }
  return run;
}

export async function runCompare(q: FeedQuery, entry: ManifestEntry | null, d: RunDeps): Promise<{ result: CompareResult; runs: FedRun[] }> {
  const runs = await Promise.all(d.feeds.map((f) => runSource(f, q, entry, d)));
  const result = buildCompare(q, entry, runs, d.nowMs);
  // buildCompare emits one summary per run, in order: carry the provenance onto the summary the browser sees.
  result.sources = result.sources.map((s, i) => (runs[i].fallbackFor ? { ...s, fallbackFor: runs[i].fallbackFor, ...(runs[i].primaryError ? { primaryError: runs[i].primaryError } : {}) } : s));
  return { result, runs };
}
