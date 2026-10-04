// SerpApi Google Shopping adapter (keyword search; results carry no GTIN, so identity relies on catalog gates).
// Docs: https://serpapi.com/google-shopping-api  Free plan: 250 searches/month. Frugal by design: 24 h fresh cache,
// 24 h stale fallback, 8/day and 240/month caps. We never send no_cache, so SerpApi's own 1 h cache can serve repeats.
import { HttpError } from '../http.ts';
import { titleCondition } from './condition.ts';
import { parseMoneyToCents, parseShippingText } from './money.ts';
import { intVar } from './types.ts';
import type { FeedOffer, FeedQuery, PriceFeed } from './types.ts';

const searchTerm = (q: FeedQuery): string => (q.query || q.gtin || '').trim().slice(0, 120).trim();
const httpsOrNull = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null);

export function serpapiSearchUrl(q: FeedQuery, apiKey: string): string {
  const term = searchTerm(q);
  const params = new URLSearchParams({ engine: 'google_shopping', q: term, gl: 'us', hl: 'en', api_key: apiKey });
  return 'https://serpapi.com/search.json?' + params.toString();
}

export function parseSerpApi(json: unknown, observedAt: string): FeedOffer[] {
  // Only a recognisable answer may be returned (and so cached): a 200 body that is neither a result list nor an error
  // (e.g. "Processing", or a changed shape) is an upstream failure, not "no offers".
  const badResponse = () => new HttpError(502, 'FEED_UPSTREAM', 'serpapi bad response');
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw badResponse();
  const body = json as { shopping_results?: unknown; error?: unknown };
  const items = body.shopping_results;
  if (!Array.isArray(items)) {
    if (!('error' in body)) throw badResponse();
    if (typeof body.error === 'string' && /returned any results/i.test(body.error)) return [];
    throw new HttpError(502, 'FEED_UPSTREAM', 'serpapi error');
  }
  const out: FeedOffer[] = [];
  for (const r of items as Record<string, any>[]) {
    // USD evidence: the displayed price text must be a "$" amount; a bare numeric extracted_price carries no currency.
    if (typeof r?.price !== 'string' || !r.price.trim().startsWith('$')) continue;
    const priceCents = parseMoneyToCents(r.extracted_price ?? r.price);
    const url = httpsOrNull(r.product_link);
    if (priceCents === null || priceCents <= 0 || typeof r.title !== 'string' || !url) continue;
    out.push({
      source: 'serpapi', sourceProductId: String(r.product_id ?? r.position ?? out.length), title: r.title.slice(0, 200), priceCents, currency: 'USD',
      shipCents: parseShippingText(r.delivery), url, imageUrl: httpsOrNull(r.thumbnail),
      seller: typeof r.source === 'string' ? r.source : null, gtin: null,
      condition: r.second_hand_condition ? 'USED' : (titleCondition(r.title) ?? 'UNKNOWN'), observedAt, gtinMatched: false,
    });
  }
  return out;
}

export const serpapiFeed: PriceFeed = {
  id: 'serpapi',
  label: 'SerpApi Google Shopping',
  attribution: 'Google Shopping via SerpApi',
  searchesByGtin: false,
  paid: true,
  freshMs: 24 * 60 * 60 * 1000,
  maxStaleMs: 24 * 60 * 60 * 1000,
  configured: (env) => Boolean(env.SERPAPI_KEY),
  dailyBudget: (env) => intVar(env.QUOTA_SERPAPI_DAILY, 8),
  monthlyBudget: (env) => intVar(env.QUOTA_SERPAPI_MONTHLY, 240),
  async search(q, ctx) {
    if (!searchTerm(q)) return []; // nothing to search for: never spend a metered call on an empty query
    let res: Response;
    try {
      res = await ctx.fetch(serpapiSearchUrl(q, ctx.env.SERPAPI_KEY ?? ''), { headers: { accept: 'application/json' }, signal: ctx.signal });
    } catch {
      // The request URL carries api_key; never let a network error message (which may echo the URL) escape.
      throw new HttpError(502, 'FEED_UPSTREAM', 'serpapi request failed');
    }
    if (!res.ok) throw new HttpError(502, 'FEED_UPSTREAM', 'serpapi HTTP ' + res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new HttpError(502, 'FEED_UPSTREAM', 'serpapi bad response');
    }
    return parseSerpApi(body, new Date(ctx.nowMs).toISOString());
  },
};
