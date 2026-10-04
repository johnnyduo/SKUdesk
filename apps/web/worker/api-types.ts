// The /api contract: every request/response shape shared by the Worker and the browser client (src/lib/api.ts).
// Dependency-free on purpose (no Workers globals), so the site can type-check against it.
import type { ErrorCode } from './http.ts';

// The 'MOCK' enum value is a stable JSON API value, never shown to visitors: the site renders it as NOT CONNECTED (a connector
// without credentials) or TEST DATA (offers the Worker generated). See src/lib/labels.ts.
export type Mode = 'REAL' | 'MOCK' | 'DRY_RUN' | 'DEGRADED';
export type ApiErrorBody = { error: { code: ErrorCode; message: string; requestId: string } };
export type HealthResponse = { ok: true; service: 'robinize-api'; apiVersion: 1; time: string; requestId: string };

// Google Merchant
export type MerchantStatus =
  | { mode: 'MOCK'; configured: false; missing: string[] }
  // accountId / accountName / dataSource are sent only to a caller with a valid admin token; everyone else gets hasDataSource.
  | { mode: 'REAL'; configured: true; accountId?: string; accountName?: string | null; dataSource?: string | null; hasDataSource?: boolean; registered: true; latencyMs: number; checkedAt: string; cached?: true }
  | { mode: 'DEGRADED'; configured: true; registered: boolean; error: { code: ErrorCode | 'INTERNAL'; hint: string }; checkedAt: string; cached?: true };

export type Condition = 'NEW' | 'USED' | 'REFURBISHED';
export type Availability = 'IN_STOCK' | 'OUT_OF_STOCK' | 'PREORDER' | 'BACKORDER' | 'LIMITED_AVAILABILITY';
// Merchant API v1 ProductAttributes subset: https://developers.google.com/merchant/api/reference/rest/products_v1/ProductAttributes
export type ProductAttributes = {
  title: string;
  description?: string;
  link: string;
  imageLink: string;
  price: { amountMicros: string; currencyCode: 'USD' };
  availability: Availability;
  condition: Condition;
  brand?: string;
  gtins?: string[];
  identifierExists?: boolean;
};
export type ProductInputBody = { offerId: string; contentLanguage: string; feedLabel: string; productAttributes: ProductAttributes };

export type ListingStatus = 'DRY_RUN' | 'SUBMITTED' | 'PROCESSING' | 'APPROVED' | 'DISAPPROVED' | 'DELETED' | 'ERROR';
export type Issue = { code: string; severity: string; attribute: string | null; description: string; detail: string | null };
export type DryRunResponse = {
  mode: 'DRY_RUN';
  offerId: string;
  configured: boolean;
  wouldSend: { method: 'POST'; path: string; query: { dataSource: string }; body: ProductInputBody };
};
export type PublishResponse = { mode: 'REAL'; offerId: string; name: string | null; status: ListingStatus; idempotent: boolean; updated: boolean };
export type ListingStatusResponse = {
  mode: 'REAL';
  offerId: string;
  status: ListingStatus;
  issues: Issue[];
  lastCheckedAt: string | null;
  // Admin-only: the Merchant product resource name embeds the account id, so public callers get no productName.
  productName?: string | null;
  refreshError?: string;
};
export type DeleteResponse = { mode: 'REAL'; offerId: string; status: 'DELETED' };

// Price feeds
export type FeedMode = 'REAL' | 'MOCK' | 'DEGRADED';
export type FeedQuery = { gtin: string | null; query: string; country: 'US' };
export type OfferCondition = 'NEW' | 'USED' | 'REFURB' | 'UNKNOWN';
export type FeedOffer = {
  source: string;
  sourceProductId: string;
  title: string;
  priceCents: number;
  currency: 'USD';
  shipCents: number | null;
  url: string;
  imageUrl: string | null;
  seller: string | null;
  gtin: string | null;
  condition: OfferCondition;
  observedAt: string;
  // true when the source matched this offer by exact GTIN/UPC (lookup by code, or a response GTIN equal to the query)
  gtinMatched: boolean;
};
export type GatedOffer = FeedOffer & { locked: boolean; rejectReasons: string[]; totalCents: number };
export type CacheState = 'MISS' | 'HIT' | 'STALE' | 'NONE';
export type SourceSummary = {
  id: string;
  label: string;
  attribution: string;
  configured: boolean;
  mode: FeedMode;
  cache: CacheState;
  offers: number;
  locked: number;
  bestCents: number | null;
  bestUrl: string | null;
  observedAt: string | null;
  error: string | null;
  quotaRemaining: number | null;
  // Provenance when a backup source answered in place of its primary: the primary feed id and why it did not serve.
  fallbackFor?: string;
  primaryError?: string;
};
export type Spread = { minCents: number; maxCents: number; deltaCents: number; deltaBps: number; basis: 'REAL' | 'MOCK'; sources: number };
export type CompareFlag = 'single_source' | 'gtin_unavailable' | 'stale_cache' | 'quota_exhausted' | 'no_canonical' | 'all_mock' | 'no_locked_offers';
export type CompareResult = {
  query: FeedQuery;
  canonical: { sku: string; title: string; priceCents: number } | null;
  sources: SourceSummary[];
  spread: Spread | null;
  flags: CompareFlag[];
  offers: GatedOffer[];
  generatedAt: string;
};
// A source's failover-only backup (SerpApi -> SearchApi.io). Never a separate price source; shown so the operator can see it.
export type SourceBackupInfo = { id: string; label: string; configured: boolean; quotaRemaining: number | null };
export type SourceInfo = { id: string; label: string; attribution: string; mode: FeedMode; configured: boolean; searchesByGtin: boolean; dailyBudget: number; quotaRemaining: number | null; backup?: SourceBackupInfo };
export type SourcesResponse = { sources: SourceInfo[] };
// GET /api/v4/pool: read-only Uniswap v4 reference pool (tIP16P / stable test token; mUSDG by default) on Robinhood Chain Testnet.
// On RPC failure mode is DEGRADED, the chain fields are null and `error.code` is a static code (never upstream text).
export type V4PoolToken = { address: string; symbol: string; decimals: number };
export type V4PoolRole = 'token0' | 'token1';
export type V4PoolResponse = {
  mode: 'REAL' | 'DEGRADED';
  chainId: number;
  poolManager: string;
  poolId: string;
  token0: V4PoolToken;
  token1: V4PoolToken;
  /** Symbol of the stable token (mUSDG by default; whichever stable after a re-pool), whichever currency it is. */
  stableSymbol: string;
  unitSymbol: string;
  /** Which of token0 / token1 is the unit token and which is the stable token. */
  roles: { unit: V4PoolRole; stable: V4PoolRole };
  fee: number;
  tickSpacing: number;
  hooks: null;
  tick: number | null;
  sqrtPriceX96: string | null;
  /** Stable per unit (name kept for compatibility; it is not mUSDC-specific). Same value as priceStablePerUnit. */
  priceMusdcPerUnit: string | null;
  priceStablePerUnit: string | null;
  liquidity: string | null;
  tickLower: number;
  tickUpper: number;
  inRange: boolean | null;
  blockNumber: number | null;
  updatedAt: string;
  note: string;
  explorer: { poolManager: string; token0: string; token1: string };
  error?: { code: 'RPC_UNAVAILABLE' | 'RPC_BAD_RESPONSE' | 'POOL_NOT_INITIALIZED' };
};
