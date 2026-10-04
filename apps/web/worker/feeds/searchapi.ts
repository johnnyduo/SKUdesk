// SearchApi.io Google Shopping adapter: the BACKUP for SerpApi (registry.ts attaches it as serpapi.fallback).
// Free plan = 100 credits in TOTAL (account.monthly_allowance is 0, they never refill), so it is called only after SerpApi's
// UPSTREAM failure (HTTP error, timeout, bad response) when nothing cached exists; never on SerpApi's own quota stops.
// 24 h cache (the Google Shopping data limit, same as SerpApi), 3/day and a lifetime cap of 90 calls. GET /api/v1/me shows credits left (free).
// The key travels in the Authorization header, never the URL. Docs: https://www.searchapi.io/docs/google-shopping
import { HttpError } from '../http.ts';
import { titleCondition } from './condition.ts';
import { parseMoneyToCents, parseShippingText } from './money.ts';
import { intVar } from './types.ts';
import type { FeedOffer, FeedQuery, PriceFeed } from './types.ts';

const searchTerm = (q: FeedQuery): string => (q.query || q.gtin || '').trim().slice(0, 120).trim();
const httpsOrNull = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null);

export function searchapiSearchUrl(q: FeedQuery): string {
  const params = new URLSearchParams({ engine: 'google_shopping', q: searchTerm(q), gl: 'us', hl: 'en' });
  return 'https://www.searchapi.io/api/v1/search?' + params.toString();
}

const badResponse = () => new HttpError(502, 'FEED_UPSTREAM', 'searchapi bad response');

// `durability` ("Pre-owned") is documented but was not present in the one live response checked, so that mapping is docs-only. When it
// does not settle the condition, the shared conservative title check keeps a cheaper used/refurbished listing from being a "best" price.
function conditionOf(durability: string, title: string): FeedOffer['condition'] {
  if (/refurb/i.test(durability)) return 'REFURB';
  if (/pre-?owned|used|second.?hand/i.test(durability)) return 'USED';
  return titleCondition(title) ?? 'UNKNOWN';
}

export function parseSearchApi(json: unknown, observedAt: string): FeedOffer[] {
  // Only a recognisable answer may be returned (and so cached): a 200 body that is neither a result list nor an error
  // (e.g. "Processing", or a changed shape) is an upstream failure, not "no offers".
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw badResponse();
  const body = json as { shopping_results?: unknown; error?: unknown };
  const items = body.shopping_results;
  if (!Array.isArray(items)) {
    if (!('error' in body)) throw badResponse();
    if (typeof body.error === 'string' && /no results|any results/i.test(body.error)) return [];
    throw new HttpError(502, 'FEED_UPSTREAM', 'searchapi error');
  }
  const out: FeedOffer[] = [];
  for (const r of items as Record<string, any>[]) {
    // USD evidence: the displayed price text must be a "$" amount; a bare numeric extracted_price carries no currency.
    if (typeof r?.price !== 'string' || !r.price.trim().startsWith('$')) continue;
    const priceCents = parseMoneyToCents(r.extracted_price ?? r.price);
    const url = httpsOrNull(r.product_link);
    if (priceCents === null || priceCents <= 0 || typeof r.title !== 'string' || !url) continue;
    const durability = typeof r.durability === 'string' ? r.durability : '';
    out.push({
      source: 'searchapi', sourceProductId: String(r.product_id ?? r.position ?? out.length), title: r.title.slice(0, 200), priceCents, currency: 'USD',
      // Only `delivery` is a shipping cost. `delivery_return` is the RETURN policy ("Free 90-day returns"): never read it as shipping.
      shipCents: parseShippingText(r.delivery), url, imageUrl: httpsOrNull(r.thumbnail),
      seller: typeof r.seller === 'string' ? r.seller : null, gtin: null,
      condition: conditionOf(durability, r.title), observedAt, gtinMatched: false,
    });
  }
  return out;
}

export const searchapiFeed: PriceFeed = {
  id: 'searchapi',
  label: 'SearchApi.io Google Shopping',
  attribution: 'Google Shopping via SearchApi.io',
  searchesByGtin: false,
  paid: true,
  freshMs: 24 * 60 * 60 * 1000,
  maxStaleMs: 24 * 60 * 60 * 1000,
  configured: (env) => Boolean(env.SEARCH_API_KEY),
  dailyBudget: (env) => intVar(env.QUOTA_SEARCHAPI_DAILY, 3),
  // The real credits are a one-time pool, so the cap is a lifetime counter. It is an app-side brake: /me is the truth.
  totalBudget: (env) => intVar(env.QUOTA_SEARCHAPI_TOTAL, 90),
  async search(q, ctx) {
    if (!searchTerm(q)) return []; // nothing to search for: never spend a metered credit on an empty query
    let res: Response;
    try {
      res = await ctx.fetch(searchapiSearchUrl(q), { headers: { accept: 'application/json', authorization: 'Bearer ' + (ctx.env.SEARCH_API_KEY ?? '') }, signal: ctx.signal });
    } catch {
      throw new HttpError(502, 'FEED_UPSTREAM', 'searchapi request failed'); // never let a network error message escape
    }
    if (!res.ok) throw new HttpError(502, 'FEED_UPSTREAM', 'searchapi HTTP ' + res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw badResponse();
    }
    return parseSearchApi(body, new Date(ctx.nowMs).toISOString());
  },
};
