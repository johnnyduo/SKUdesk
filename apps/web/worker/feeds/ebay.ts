// eBay Browse API adapter (GTIN-exact). OAuth client-credentials token cached in KV.
// Search: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
// Token:  https://developer.ebay.com/api-docs/static/oauth-client-credentials-grant.html
// Terms: show data no older than 6 h (maxStaleMs); do not persist eBay user data (we never store seller names).
import type { AppEnv, Fetch } from '../env.ts';
import { HttpError } from '../http.ts';
import { parseMoneyToCents } from './money.ts';
import { intVar } from './types.ts';
import type { FeedOffer, FeedQuery, OfferCondition, PriceFeed } from './types.ts';

export const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope';
export const EBAY_TOKEN_KEY = 'ebaytoken:v1';
const FILTER = 'conditions:{NEW},buyingOptions:{FIXED_PRICE},deliveryCountry:US,priceCurrency:USD';

type TokenKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export function ebaySearchUrl(base: string, q: FeedQuery): string {
  const url = new URL(base.replace(/\/+$/, '') + '/buy/browse/v1/item_summary/search');
  if (q.gtin) url.searchParams.set('gtin', q.gtin);
  else url.searchParams.set('q', q.query.slice(0, 100));
  url.searchParams.set('filter', FILTER);
  url.searchParams.set('limit', '50');
  return url.toString();
}

const httpsOrNull = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null);

// The token fetch keeps its own 10 s timeout and also stops when the caller's signal aborts.
export async function getEbayToken(env: AppEnv, fetchFn: Fetch, kv: TokenKV, forceRefresh: boolean, signal?: AbortSignal): Promise<string> {
  if (!forceRefresh) {
    const cached = await kv.get(EBAY_TOKEN_KEY);
    if (cached) return cached;
  }
  const basic = btoa((env.EBAY_CLIENT_ID ?? '') + ':' + (env.EBAY_CLIENT_SECRET ?? ''));
  const res = await fetchFn(env.EBAY_API_BASE.replace(/\/+$/, '') + '/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + basic },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: EBAY_SCOPE }).toString(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpError(502, 'FEED_UPSTREAM', 'ebay token HTTP ' + res.status);
  const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') throw new HttpError(502, 'FEED_UPSTREAM', 'ebay token response malformed');
  // A failed cache write must not fail a call whose token exchange already succeeded.
  try {
    await kv.put(EBAY_TOKEN_KEY, body.access_token, { expirationTtl: Math.max(60, Math.floor(body.expires_in) - 300) });
  } catch {
    // ignore: the next call re-exchanges
  }
  return body.access_token;
}

function conditionOf(conditionId: unknown, condition: unknown): OfferCondition {
  const id = typeof conditionId === 'string' ? Number(conditionId) : NaN;
  if (id === 1000) return 'NEW';
  if (id >= 2000 && id < 3000) return 'REFURB';
  if (id >= 3000) return 'USED';
  if (typeof condition === 'string' && /^new$/i.test(condition)) return 'NEW';
  return 'UNKNOWN';
}

export function parseEbay(json: unknown, q: FeedQuery, observedAt: string): FeedOffer[] {
  const items = (json as { itemSummaries?: unknown } | null)?.itemSummaries;
  if (!Array.isArray(items)) return [];
  const out: FeedOffer[] = [];
  for (const it of items as Record<string, any>[]) {
    if (it?.price?.currency !== 'USD') continue;
    const priceCents = parseMoneyToCents(it.price.value);
    if (priceCents === null || priceCents <= 0) continue;
    if (typeof it.itemId !== 'string' || typeof it.title !== 'string') continue;
    const url = httpsOrNull(it.itemWebUrl);
    if (!url) continue;
    const ship = Array.isArray(it.shippingOptions) ? it.shippingOptions[0] : undefined;
    const shipCents = ship && ship.shippingCostType !== 'CALCULATED' && ship.shippingCost?.currency === 'USD' ? parseMoneyToCents(ship.shippingCost.value) : null;
    out.push({
      source: 'ebay', sourceProductId: it.itemId, title: it.title.slice(0, 200), priceCents, currency: 'USD', shipCents,
      url, imageUrl: httpsOrNull(it.image?.imageUrl),
      seller: typeof it.seller?.username === 'string' ? it.seller.username : null,
      // The gtin= search is the identity evidence: true only when this query was a GTIN query.
      gtin: null, condition: conditionOf(it.conditionId, it.condition), observedAt, gtinMatched: Boolean(q.gtin),
    });
  }
  return out;
}

export const ebayFeed: PriceFeed = {
  id: 'ebay',
  label: 'eBay Browse API',
  attribution: 'eBay',
  searchesByGtin: true,
  maxStaleMs: 6 * 60 * 60 * 1000,
  configured: (env) => Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
  dailyBudget: (env) => intVar(env.QUOTA_EBAY_DAILY, 1000),
  async search(q, ctx) {
    const url = ebaySearchUrl(ctx.env.EBAY_API_BASE, q);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getEbayToken(ctx.env, ctx.fetch, ctx.env.CACHE, attempt > 0, ctx.signal);
      const res = await ctx.fetch(url, { headers: { authorization: 'Bearer ' + token, 'x-ebay-c-marketplace-id': 'EBAY_US', accept: 'application/json' }, signal: ctx.signal });
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw new HttpError(502, 'FEED_UPSTREAM', 'ebay HTTP ' + res.status);
      return parseEbay(await res.json(), q, new Date(ctx.nowMs).toISOString());
    }
    throw new HttpError(502, 'FEED_UPSTREAM', 'ebay unauthorized');
  },
};
