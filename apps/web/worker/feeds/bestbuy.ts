// Best Buy Products API adapter (exact UPC lookup, keyword fallback). Prices are JSON numbers in USD.
// Docs: https://bestbuyapis.github.io/api-documentation/  Terms: https://developer.bestbuy.com/legal
// Terms: cache <= 72 h (maxStaleMs + D1 retention), attribute "Best Buy" wherever its data is shown.
// The API requires the key in the QUERY STRING, so the request URL is secret-bearing: it is never logged,
// never placed in an error message, and upstream bodies/exceptions are summarized, never echoed.
import { normalizeGtin, sameGtin } from '../gtin.ts';
import { HttpError } from '../http.ts';
import { parseMoneyToCents } from './money.ts';
import { intVar } from './types.ts';
import type { FeedOffer, FeedQuery, OfferCondition, PriceFeed } from './types.ts';

const SHOW = 'sku,name,salePrice,regularPrice,upc,url,image,onlineAvailability,condition,shippingCost';

// Best Buy indexes 12-digit UPC-A. GTIN-14/EAN-13 with leading zeros reduce to UPC-A; others cannot be looked up.
export function toUpcA(gtin: string | null): string | null {
  const g14 = normalizeGtin(gtin);
  // '000000' prefix = a zero-padded EAN-8, which is not a UPC-A.
  if (!g14 || !g14.startsWith('00') || g14.startsWith('000000')) return null;
  return g14.slice(2);
}

export function bestbuySearchUrl(q: FeedQuery, apiKey: string): string {
  const upc = toUpcA(q.gtin);
  let selector: string;
  if (upc) {
    selector = 'upc=' + upc;
  } else {
    const words = q.query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
    if (!words.length) return '';
    selector = words.map((w) => 'search=' + w).join('&');
  }
  const params = new URLSearchParams({ apiKey, format: 'json', show: SHOW, pageSize: '10' });
  return 'https://api.bestbuy.com/v1/products(' + selector + ')?' + params.toString();
}

const httpsOrNull = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null);

function conditionOf(c: unknown): OfferCondition {
  if (typeof c !== 'string' || /^new$/i.test(c)) return 'NEW';
  if (/refurb/i.test(c)) return 'REFURB';
  if (/pre-?owned|used|open.?box/i.test(c)) return 'USED';
  return 'UNKNOWN';
}

// Best Buy returns JSON numbers; stringify first so parseMoneyToCents works on the decimal string, never x*100.
function centsOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? parseMoneyToCents(String(v)) : null;
}

export function parseBestBuy(json: unknown, q: FeedQuery, observedAt: string): FeedOffer[] {
  const items = (json as { products?: unknown } | null)?.products;
  if (!Array.isArray(items)) return [];
  // Identity evidence exists only when this query was the exact-UPC search (not a keyword fallback).
  const exactUpcSearch = Boolean(q.gtin) && toUpcA(q.gtin) !== null;
  const out: FeedOffer[] = [];
  for (const p of items as Record<string, any>[]) {
    if (!p || p.onlineAvailability === false) continue;
    const priceCents = centsOf(p.salePrice ?? p.regularPrice);
    if (priceCents === null || priceCents <= 0) continue;
    if ((typeof p.sku !== 'number' && typeof p.sku !== 'string') || typeof p.name !== 'string') continue;
    const url = httpsOrNull(p.url);
    if (!url) continue;
    const upc = typeof p.upc === 'string' ? p.upc : null;
    out.push({
      source: 'bestbuy', sourceProductId: String(p.sku), title: p.name.slice(0, 200), priceCents, currency: 'USD',
      shipCents: centsOf(p.shippingCost),
      url, imageUrl: httpsOrNull(p.image), seller: 'Best Buy', gtin: upc,
      condition: conditionOf(p.condition), observedAt, gtinMatched: exactUpcSearch && sameGtin(upc, q.gtin),
    });
  }
  return out;
}

export const bestbuyFeed: PriceFeed = {
  id: 'bestbuy',
  label: 'Best Buy Products API',
  attribution: 'Best Buy',
  searchesByGtin: true,
  maxStaleMs: 72 * 60 * 60 * 1000,
  configured: (env) => Boolean(env.BESTBUY_API_KEY),
  dailyBudget: (env) => intVar(env.QUOTA_BESTBUY_DAILY, 2000),
  async search(q, ctx) {
    const url = bestbuySearchUrl(q, ctx.env.BESTBUY_API_KEY ?? '');
    if (!url) return [];
    let res: Response;
    try {
      res = await ctx.fetch(url, { headers: { accept: 'application/json' }, signal: ctx.signal });
    } catch {
      // Runtime fetch errors can embed the request URL (which carries the key): replace with a static message.
      throw new HttpError(502, 'FEED_UPSTREAM', 'bestbuy request failed');
    }
    if (!res.ok) {
      // Release the connection without reading (or echoing) the upstream body.
      try { await res.body?.cancel(); } catch { /* ignore: the static error below is what matters */ }
      throw new HttpError(502, 'FEED_UPSTREAM', 'bestbuy HTTP ' + res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new HttpError(502, 'FEED_UPSTREAM', 'bestbuy response not JSON');
    }
    return parseBestBuy(body, q, new Date(ctx.nowMs).toISOString());
  },
};
