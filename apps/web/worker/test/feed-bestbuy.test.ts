import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bestbuyFeed, bestbuySearchUrl, parseBestBuy, toUpcA } from '../feeds/bestbuy.ts';
import { HttpError } from '../http.ts';
import { FIXED_NOW_MS, baseEnv, jsonResponse, scriptedFetch } from './helpers/fakes.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/feeds/' + name, import.meta.url), 'utf8'));
const Q = { gtin: '036000291452', query: 'iPhone 16 Pro Clear MagSafe Case', country: 'US' as const };
const env = (over: Record<string, unknown> = {}) => baseEnv({ BESTBUY_API_KEY: 'bbkey', QUOTA_BESTBUY_DAILY: '2000', ...over });
const ctx = (e: unknown, f: unknown) => ({ env: e as any, fetch: f as any, signal: AbortSignal.timeout(5000), nowMs: FIXED_NOW_MS });

test('toUpcA: UPC-A as is, EAN-13 with leading zero reduced, true EAN-13 not expressible', () => {
  assert.equal(toUpcA('036000291452'), '036000291452');
  assert.equal(toUpcA('0036000291452'), '036000291452');
  assert.equal(toUpcA('4006381333931'), null);
  assert.equal(toUpcA(null), null);
});

test('bestbuySearchUrl: upc selector, keyword fallback, empty when nothing to search', () => {
  const u = bestbuySearchUrl(Q, 'bbkey');
  assert.ok(u.startsWith('https://api.bestbuy.com/v1/products(upc=036000291452)?'));
  const params = new URL(u).searchParams;
  assert.equal(params.get('format'), 'json');
  assert.equal(params.get('apiKey'), 'bbkey');
  assert.ok(bestbuySearchUrl({ ...Q, gtin: null }, 'k').startsWith('https://api.bestbuy.com/v1/products(search=iphone&search=16&search=pro&search=clear&search=magsafe&search=case)?'));
  assert.equal(bestbuySearchUrl({ gtin: null, query: '!!', country: 'US' }, 'k'), '');
});

test('parseBestBuy: numeric prices to cents, offline items skipped, condition mapped, GTIN matched by UPC', () => {
  const offers = parseBestBuy(fx('bestbuy-upc.json'), Q, '2026-10-02T12:00:00.000Z');
  assert.deepEqual(offers.map((o) => [o.sourceProductId, o.priceCents, o.shipCents, o.condition, o.gtinMatched]), [
    ['6501234', 1099, 0, 'NEW', true],
    ['6501235', 749, null, 'USED', true],
  ]);
  assert.equal(offers[0].seller, 'Best Buy');
  assert.deepEqual(parseBestBuy(fx('bestbuy-empty.json'), Q, 'x'), []);
  assert.equal(parseBestBuy(fx('bestbuy-upc.json'), { ...Q, gtin: '4006381333931' }, 'x')[0].gtinMatched, false);
});

test('parseBestBuy: gtinMatched never set for keyword searches; non-positive and malformed prices dropped', () => {
  const upcJson = fx('bestbuy-upc.json');
  assert.ok(parseBestBuy(upcJson, { ...Q, gtin: null }, 'x').every((o) => o.gtinMatched === false));
  assert.ok(parseBestBuy(upcJson, { ...Q, gtin: '' }, 'x').every((o) => o.gtinMatched === false));
  const mk = (salePrice: unknown) => ({ products: [{ sku: 1, name: 'n', salePrice, url: 'https://x/y', upc: '036000291452', onlineAvailability: true }] });
  assert.equal(parseBestBuy(mk(0), Q, 'x').length, 0);
  assert.equal(parseBestBuy(mk(-3), Q, 'x').length, 0);
  assert.equal(parseBestBuy(mk('abc'), Q, 'x').length, 0);
  assert.equal(parseBestBuy(mk(null), Q, 'x').length, 0);
  assert.equal(parseBestBuy(mk(0.29), Q, 'x')[0].priceCents, 29);
  assert.equal(parseBestBuy(mk(1299.99), Q, 'x')[0].priceCents, 129999);
  assert.equal(parseBestBuy(null, Q, 'x').length, 0);
});

test('bestbuyFeed.search: one GET, errors -> FEED_UPSTREAM without the api key', async () => {
  const net = scriptedFetch([() => jsonResponse(fx('bestbuy-upc.json'))]);
  const offers = await bestbuyFeed.search(Q, ctx(env(), net.fetch));
  assert.equal(offers.length, 2);
  assert.equal(net.calls.length, 1);
  const denied = scriptedFetch([() => jsonResponse(fx('bestbuy-403.json'), 403)]);
  await assert.rejects(bestbuyFeed.search(Q, ctx(env(), denied.fetch)), (e: unknown) => e instanceof HttpError && e.code === 'FEED_UPSTREAM' && !e.message.includes('bbkey'));
  assert.equal(bestbuyFeed.configured(env({ BESTBUY_API_KEY: undefined }) as any), false);
  assert.equal(bestbuyFeed.dailyBudget(env() as any), 2000);
  assert.equal(bestbuyFeed.maxStaleMs, 72 * 60 * 60 * 1000);
  assert.equal(bestbuyFeed.attribution, 'Best Buy');
});

test('bestbuyFeed.search: non-JSON 200, network failure and error bodies never leak the key or URL', async () => {
  const html = scriptedFetch([() => new Response('<html>maintenance</html>', { status: 200 })]);
  await assert.rejects(bestbuyFeed.search(Q, ctx(env(), html.fetch)), (e: unknown) =>
    e instanceof HttpError && e.code === 'FEED_UPSTREAM' && !e.message.includes('bbkey') && !e.message.includes('apiKey') && !e.message.includes('maintenance'));
  const boom = async () => { throw new TypeError('fetch failed for https://api.bestbuy.com/v1/products?apiKey=bbkey'); };
  await assert.rejects(bestbuyFeed.search(Q, ctx(env(), boom)), (e: unknown) =>
    e instanceof HttpError && e.code === 'FEED_UPSTREAM' && !e.message.includes('bbkey') && !e.message.includes('apiKey'));
  const echo = scriptedFetch([() => new Response('bad apiKey=bbkey', { status: 500 })]);
  await assert.rejects(bestbuyFeed.search(Q, ctx(env(), echo.fetch)), (e: unknown) => e instanceof HttpError && !e.message.includes('bbkey'));
  const none = scriptedFetch([]);
  assert.deepEqual(await bestbuyFeed.search({ gtin: null, query: '!!', country: 'US' }, ctx(env(), none.fetch)), []);
  assert.equal(none.calls.length, 0);
});

test('toUpcA: EAN-8 zero padding is rejected, a 14-digit zero-padded UPC-A still reduces', () => {
  assert.equal(toUpcA('96385074'), null);
  assert.equal(toUpcA('00036000291452'), '036000291452');
});

test('bestbuySearchUrl: hostile keyword text cannot alter the selector', () => {
  for (const query of ['a&b)(search=x', 'iphone)&apiKey=evil(upc=1', 'x%26upc%3D1 case', '")(sku=1']) {
    const u = bestbuySearchUrl({ gtin: null, query, country: 'US' }, 'k');
    const selector = /^https:\/\/api\.bestbuy\.com\/v1\/products\(([^?]*)\)\?/.exec(u)?.[1] ?? '';
    assert.match(selector, /^search=[a-z0-9]+(&search=[a-z0-9]+)*$/, query);
    assert.equal(new URL(u).searchParams.get('apiKey'), 'k');
  }
  assert.equal(bestbuySearchUrl({ gtin: '96385074', query: '!!', country: 'US' }, 'k'), '');
});

test('parseBestBuy: non-https url skips the offer; non-https image becomes null', () => {
  const mk = (url: unknown, image: unknown) => ({ products: [{ sku: 1, name: 'n', salePrice: 5, url, image, upc: '036000291452', onlineAvailability: true }] });
  assert.equal(parseBestBuy(mk('http://x/y', 'https://i/x.jpg'), Q, 'x').length, 0);
  assert.equal(parseBestBuy(mk('javascript:alert(1)', null), Q, 'x').length, 0);
  assert.equal(parseBestBuy(mk('https://x/y', 'http://i/x.jpg'), Q, 'x')[0].imageUrl, null);
  assert.equal(parseBestBuy(mk('https://x/y', 'https://i/x.jpg'), Q, 'x')[0].imageUrl, 'https://i/x.jpg');
});

test('bestbuyFeed.search: a non-OK response is released with body.cancel() (body never read), static error kept', async () => {
  let cancels = 0;
  let reads = 0;
  const fake = {
    ok: false, status: 503,
    body: { cancel: async () => { cancels++; } },
    text: async () => { reads++; return 'SENTINEL apiKey=bbkey'; },
    json: async () => { reads++; return {}; },
    arrayBuffer: async () => { reads++; return new ArrayBuffer(0); },
  };
  const f = async () => fake as unknown as Response;
  await assert.rejects(bestbuyFeed.search(Q, ctx(env(), f)), (e: unknown) => e instanceof HttpError && e.code === 'FEED_UPSTREAM' && e.message === 'bestbuy HTTP 503');
  assert.equal(cancels, 1);
  assert.equal(reads, 0);
  // A failing cancel (or a null body) never changes the error.
  const bad = async () => ({ ok: false, status: 500, body: { cancel: async () => { throw new Error('boom'); } } }) as unknown as Response;
  await assert.rejects(bestbuyFeed.search(Q, ctx(env(), bad)), (e: unknown) => e instanceof HttpError && e.message === 'bestbuy HTTP 500');
  const nobody = async () => ({ ok: false, status: 502, body: null }) as unknown as Response;
  await assert.rejects(bestbuyFeed.search(Q, ctx(env(), nobody)), (e: unknown) => e instanceof HttpError && e.message === 'bestbuy HTTP 502');
});
