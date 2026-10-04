import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearchApi, searchapiFeed, searchapiSearchUrl } from '../feeds/searchapi.ts';
import { HttpError } from '../http.ts';
import { FIXED_NOW_MS, baseEnv, jsonResponse, scriptedFetch } from './helpers/fakes.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/feeds/' + name, import.meta.url), 'utf8'));
const Q = { gtin: null, query: 'iPhone 16 Pro Clear MagSafe Case', country: 'US' as const };
const ctx = (e: unknown, f: unknown) => ({ env: e as any, fetch: f as any, signal: AbortSignal.timeout(5000), nowMs: FIXED_NOW_MS });

test('searchapiSearchUrl: google_shopping, gl=us, hl=en, and no api_key anywhere in the URL', () => {
  const u = new URL(searchapiSearchUrl(Q));
  assert.equal(u.origin + u.pathname, 'https://www.searchapi.io/api/v1/search');
  assert.deepEqual([u.searchParams.get('engine'), u.searchParams.get('q'), u.searchParams.get('gl'), u.searchParams.get('hl')], ['google_shopping', 'iPhone 16 Pro Clear MagSafe Case', 'us', 'en']);
  assert.equal(u.search.includes('api_key'), false);
});

test('parseSearchApi: $ prices to cents, seller kept, return policy is NOT shipping, pre-owned flagged, GBP skipped', () => {
  const offers = parseSearchApi(fx('searchapi-shopping.json'), '2026-10-02T12:00:00.000Z');
  assert.deepEqual(offers.map((o) => [o.source, o.priceCents, o.shipCents, o.condition, o.seller]), [
    ['searchapi', 1099, null, 'UNKNOWN', 'Best Buy'],
    ['searchapi', 1425, null, 'UNKNOWN', 'Walmart'], // "Free 90-day returns" must not read as free delivery
    ['searchapi', 400, 599, 'USED', 'Used Store'],
  ]);
  assert.ok(offers.every((o) => o.gtinMatched === false && o.gtin === null && o.currency === 'USD' && o.priceCents > 0));
  assert.ok(offers.every((o) => o.url.startsWith('https://')));
});

test('parseSearchApi: empty results are [], other errors throw FEED_UPSTREAM', () => {
  assert.deepEqual(parseSearchApi(fx('searchapi-no-results.json'), 'x'), []);
  assert.throws(() => parseSearchApi(fx('searchapi-bad-key.json'), 'x'), (e: unknown) => e instanceof HttpError && e.code === 'FEED_UPSTREAM');
});

test('searchapiFeed: key travels in the Authorization header, never the URL; errors never echo the key', async () => {
  assert.equal(searchapiFeed.configured(baseEnv() as any), false);
  const e = baseEnv({ SEARCH_API_KEY: 'sakey-secret' });
  assert.equal(searchapiFeed.configured(e as any), true);
  const net = scriptedFetch([() => jsonResponse(fx('searchapi-shopping.json')), () => jsonResponse(fx('searchapi-bad-key.json'), 401)]);
  assert.equal((await searchapiFeed.search(Q, ctx(e, net.fetch))).length, 3);
  assert.equal(net.calls[0].headers.authorization, 'Bearer sakey-secret');
  assert.equal(net.calls[0].url.includes('sakey-secret'), false);
  await assert.rejects(searchapiFeed.search(Q, ctx(e, net.fetch)), (err: unknown) => err instanceof HttpError && !err.message.includes('sakey-secret'));
  const leaky = async (url: unknown) => { throw new TypeError('fetch failed: ' + String(url)); };
  await assert.rejects(searchapiFeed.search(Q, ctx(e, leaky)), (err: unknown) => err instanceof HttpError && err.code === 'FEED_UPSTREAM' && !err.message.includes('sakey-secret'));
});

test('searchapiFeed spends nothing on an empty query', async () => {
  const net = scriptedFetch([]);
  assert.deepEqual(await searchapiFeed.search({ gtin: null, query: '  ', country: 'US' }, ctx(baseEnv({ SEARCH_API_KEY: 'k' }), net.fetch)), []);
  assert.equal(net.calls.length, 0);
});

test('searchapiFeed is frugal: 24 h cache (the Google Shopping limit), 3/day, 90 credits for the whole plan, vars override', () => {
  assert.equal(searchapiFeed.freshMs, 24 * 60 * 60 * 1000);
  assert.equal(searchapiFeed.maxStaleMs, 24 * 60 * 60 * 1000);
  assert.equal(searchapiFeed.dailyBudget(baseEnv() as any), 3);
  assert.equal(searchapiFeed.monthlyBudget, undefined);
  assert.equal(searchapiFeed.totalBudget?.(baseEnv() as any), 90);
  assert.equal(searchapiFeed.dailyBudget(baseEnv({ QUOTA_SEARCHAPI_DAILY: '1' }) as any), 1);
  assert.equal(searchapiFeed.totalBudget?.(baseEnv({ QUOTA_SEARCHAPI_TOTAL: 'junk' }) as any), 90);
});

// used / refurbished detection when `durability` is absent (unverified live): conservative title fallback
const row = (title: string, extra: Record<string, unknown> = {}) => ({ position: 1, product_id: 'p1', title, product_link: 'https://www.google.com/search?x=1', price: '$9.99', extracted_price: 9.99, seller: 'S', ...extra });
const conditionOf = (title: string, extra: Record<string, unknown> = {}) => parseSearchApi({ shopping_results: [row(title, extra)] }, 'x')[0].condition;

test('parseSearchApi: title words used / pre-owned / refurbished / renewed / open-box are never NEW when durability is absent', () => {
  assert.equal(conditionOf('Used Insignia Case for iPhone 16 Pro'), 'USED');
  assert.equal(conditionOf('Insignia Case iPhone 16 Pro - USED - good'), 'USED');
  assert.equal(conditionOf('Pre-owned Insignia Case for iPhone 16 Pro'), 'USED');
  assert.equal(conditionOf('Preowned Insignia Case for iPhone 16 Pro'), 'USED');
  assert.equal(conditionOf('Pre owned Insignia Case'), 'UNKNOWN'); // not a conservative match: only the documented spellings
  assert.equal(conditionOf('Insignia Case iPhone 16 Pro (Open Box)'), 'USED');
  assert.equal(conditionOf('Open-box Insignia Case iPhone 16 Pro'), 'USED');
  assert.equal(conditionOf('Refurbished Insignia Case for iPhone 16 Pro'), 'REFURB');
  assert.equal(conditionOf('Insignia Case iPhone 16 Pro Refurb.'), 'REFURB');
  assert.equal(conditionOf('Renewed Insignia Case for iPhone 16 Pro'), 'REFURB');
});

test('parseSearchApi: title fallback is word-bounded (no false positives) and never overrides a recognised durability', () => {
  assert.equal(conditionOf('Insignia Reused-Resistant Case'), 'UNKNOWN');
  assert.equal(conditionOf('Unused Insignia Case'), 'UNKNOWN'); // "unused" is not the word "used"
  assert.equal(conditionOf('Insignia Case for iPhone 16 Pro'), 'UNKNOWN');
  assert.equal(conditionOf('Insignia Case', { durability: 'Refurbished' }), 'REFURB');
  assert.equal(conditionOf('Used Insignia Case', { durability: 'Refurbished' }), 'REFURB');
  assert.equal(conditionOf('Insignia Case', { durability: 'Pre-owned' }), 'USED');
});

test('parseSearchApi: a cheaper used listing found only by its title cannot lock as the best price', () => {
  const offers = parseSearchApi({ shopping_results: [row('Insignia Case', { product_id: 'a', extracted_price: 12.5, price: '$12.50' }), row('Renewed Insignia Case', { product_id: 'b', extracted_price: 3, price: '$3.00' })] }, 'x');
  assert.deepEqual(offers.map((o) => [o.priceCents, o.condition]), [[1250, 'UNKNOWN'], [300, 'REFURB']]);
});

// shape check: only a real answer may be cached
const bad502 = (e: unknown) => e instanceof HttpError && e.status === 502 && e.code === 'FEED_UPSTREAM' && e.message === 'searchapi bad response';

test('parseSearchApi: a 200 body with neither shopping_results nor error ("Processing", shape change, junk) is an upstream error', () => {
  for (const body of [{ search_metadata: { status: 'Processing' } }, {}, [], null, 'ok', 42, { shopping_results: null }, { shopping_results: 'x' }, { shopping_results: {} }]) {
    assert.throws(() => parseSearchApi(body, 'x'), bad502, JSON.stringify(body));
  }
});

test('parseSearchApi: a genuine empty shopping_results (and the documented no-results error) stay valid empty answers', () => {
  assert.deepEqual(parseSearchApi({ shopping_results: [] }, 'x'), []);
  assert.deepEqual(parseSearchApi({ search_metadata: { status: 'Success' }, shopping_results: [] }, 'x'), []);
  assert.deepEqual(parseSearchApi({ error: 'Google hasn\'t returned any results for this query.' }, 'x'), []);
  assert.throws(() => parseSearchApi({ error: 42 }, 'x'), (e: unknown) => e instanceof HttpError && e.code === 'FEED_UPSTREAM');
});

test('searchapiFeed.search: a 200 "Processing" body throws instead of returning an empty answer (so nothing empty is cached)', async () => {
  const net = scriptedFetch([() => jsonResponse({ search_metadata: { status: 'Processing' } })]);
  await assert.rejects(searchapiFeed.search(Q, ctx(baseEnv({ SEARCH_API_KEY: 'k' }), net.fetch)), bad502);
});
