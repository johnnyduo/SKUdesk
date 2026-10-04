// Per-source, per-UTC-day call budget in KV. KV is not atomic: concurrent requests can overshoot by a few calls.
// It is a cost brake, not an exact meter.
import type { CacheKV } from './cache.ts';

export const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60;
export type QuotaResult = { allowed: boolean; used: number; remaining: number };

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function quotaKey(feedId: string, nowMs: number): string {
  return 'quota:v1:' + feedId + ':' + utcDay(nowMs);
}

// Fail-safe counter reads: an absent key is 0 used; a stored value that is not a plain non-negative integer ("abc", "-5",
// "12abc") is corrupt and counts as EXHAUSTED, because we can no longer tell how much was spent. A budget that is not a finite
// number is exhausted too. A paid-per-call source must never get a free pass from bad data.
export const CORRUPT_COUNT = Number.MAX_SAFE_INTEGER;

async function readCount(kv: CacheKV, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (raw === null) return 0;
  if (!/^\d{1,15}$/.test(raw)) return CORRUPT_COUNT;
  return Number.parseInt(raw, 10);
}

function leftOf(budget: number, used: number): number {
  return Number.isFinite(budget) ? Math.max(0, budget - used) : 0;
}

// Decide one increment against the budget; null = allowed (the caller writes the new count).
function refusal(budget: number, used: number): QuotaResult | null {
  return Number.isFinite(budget) && used < budget ? null : { allowed: false, used, remaining: 0 };
}

export async function quotaUsed(kv: CacheKV, feedId: string, nowMs: number): Promise<number> {
  return readCount(kv, quotaKey(feedId, nowMs));
}

export async function quotaRemaining(kv: CacheKV, feedId: string, budget: number, nowMs: number): Promise<number> {
  return leftOf(budget, await quotaUsed(kv, feedId, nowMs));
}

// Thrown when the counter was READ (and is under budget) but the increment could not be WRITTEN, so callers can
// tell "KV unreadable" (always fail closed) from "KV write failed" (their policy decides).
export class QuotaWriteError extends Error {
  used: number;
  constructor(used: number) {
    super('quota counter write failed');
    this.name = 'QuotaWriteError';
    this.used = used;
  }
}

export async function tryConsume(kv: CacheKV, feedId: string, budget: number, nowMs: number): Promise<QuotaResult> {
  const used = await quotaUsed(kv, feedId, nowMs);
  const no = refusal(budget, used);
  if (no) return no;
  try {
    await kv.put(quotaKey(feedId, nowMs), String(used + 1), { expirationTtl: QUOTA_TTL_SECONDS });
  } catch {
    throw new QuotaWriteError(used);
  }
  return { allowed: true, used: used + 1, remaining: budget - used - 1 };
}

// Monthly hard cap for sources whose free plan is metered per month (SerpApi: 250/month).
export const QUOTA_MONTH_TTL_SECONDS = 35 * 24 * 60 * 60;

export function utcMonth(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export function monthlyQuotaKey(feedId: string, nowMs: number): string {
  return 'quota:v1m:' + feedId + ':' + utcMonth(nowMs);
}

async function monthlyUsed(kv: CacheKV, feedId: string, nowMs: number): Promise<number> {
  return readCount(kv, monthlyQuotaKey(feedId, nowMs));
}

export async function quotaRemainingMonthly(kv: CacheKV, feedId: string, budget: number, nowMs: number): Promise<number> {
  return leftOf(budget, await monthlyUsed(kv, feedId, nowMs));
}

export async function tryConsumeMonthly(kv: CacheKV, feedId: string, budget: number, nowMs: number): Promise<QuotaResult> {
  const used = await monthlyUsed(kv, feedId, nowMs);
  const no = refusal(budget, used);
  if (no) return no;
  await kv.put(monthlyQuotaKey(feedId, nowMs), String(used + 1), { expirationTtl: QUOTA_MONTH_TTL_SECONDS });
  return { allowed: true, used: used + 1, remaining: budget - used - 1 };
}

// Lifetime hard cap for plans whose credits never refill (SearchApi.io free plan: 100 credits in total).
// No TTL and no period in the key: the count survives month and year changes until the plan or the key is replaced.
export function totalQuotaKey(feedId: string): string {
  return 'quota:v1t:' + feedId;
}

async function totalUsed(kv: CacheKV, feedId: string): Promise<number> {
  return readCount(kv, totalQuotaKey(feedId));
}

export async function quotaRemainingTotal(kv: CacheKV, feedId: string, budget: number, _nowMs?: number): Promise<number> {
  return leftOf(budget, await totalUsed(kv, feedId));
}

export async function tryConsumeTotal(kv: CacheKV, feedId: string, budget: number, _nowMs?: number): Promise<QuotaResult> {
  const used = await totalUsed(kv, feedId);
  const no = refusal(budget, used);
  if (no) return no;
  await kv.put(totalQuotaKey(feedId), String(used + 1));
  return { allowed: true, used: used + 1, remaining: budget - used - 1 };
}
