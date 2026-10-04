// Price-feed adapter contract. Adding a source = one file implementing PriceFeed + one line in registry.ts.
import type { FeedMode, FeedOffer, FeedQuery, OfferCondition } from '../api-types.ts';
import type { AppEnv, Fetch } from '../env.ts';

export type { FeedMode, FeedOffer, FeedQuery, OfferCondition };

export type FeedContext = { env: AppEnv; fetch: Fetch; signal: AbortSignal; nowMs: number };

export interface PriceFeed {
  id: string;
  label: string;
  attribution: string;
  searchesByGtin: boolean;
  maxStaleMs: number;
  // Optional per-source overrides for scarce quotas: how long a cached copy counts as fresh (default FRESH_MS),
  // and a hard per-UTC-month call cap (null/absent = no monthly cap).
  freshMs?: number;
  monthlyBudget?(env: AppEnv): number;
  // Lifetime call cap for plans whose credits never refill (counter has no TTL and no period).
  totalBudget?(env: AppEnv): number;
  // Metered, plan-limited source (SerpApi, SearchApi.io). A request that is not from the operator never triggers a paid
  // upstream call for it: it may only be served from the KV cache (see run.ts `allowPaid`). Absent = free to call.
  paid?: boolean;
  // Backup source, used only after this one's UPSTREAM failure with no cached copy to show (see run.ts). Its own quota stops never trigger it.
  fallback?: PriceFeed;
  configured(env: AppEnv): boolean;
  dailyBudget(env: AppEnv): number;
  search(q: FeedQuery, ctx: FeedContext): Promise<FeedOffer[]>;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
