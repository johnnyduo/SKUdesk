import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSerpApi, serpapiFeed, serpapiSearchUrl } from '../feeds/serpapi.ts';
import { HttpError } from '../http.ts';
import { quotaRemainingMonthly, tryConsumeMonthly, utcMonth } from '../feeds/quota.ts';
import { FIXED_NOW_MS, baseEnv, jsonResponse, memKV, scriptedFetch } from './helpers/fakes.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/feeds/' + name, import.meta.url), 'utf8'));
const Q = { gtin: '036000291452', query: 'iPhone 16 Pro Clear MagSafe Case', country: 'US' as const };
const ctx = (e: unknown, f: unknown) => ({ env: e as any, fetch: f as any, signal: AbortSignal.timeout(5000), nowMs: FIXED_NOW_MS });

test('serpapiSearchUrl: google_shopping, gl=us, hl=en; title preferred over GTIN; never bypasses SerpApi cache', () => {
  const p = new URL(serpapiSearchUrl(Q, 'skey')).searchParams;
  assert.deepEqual([p.get('engine'), p.get('q'), p.get('gl'), p.get('hl'), p.get('api_key')], ['google_shopping', 'iPhone 16 Pro Clear MagSafe Case', 'us', 'en', 'skey']);
  assert.equal(p.has('no_cache'), false);
  assert.equal(new URL(serpapiSearchUrl({ ...Q, query: '' }, 'k')).searchParams.get('q'), '036000291452');
});

test('parseSerpApi: extracted_price to cents, $ only, delivery parsed, used flagged, never GTIN-matched', () => {
  const offers = parseSerpApi(fx('serpapi-shopping.json'), '2026-10-02T12:00:00.000Z');
  assert.deepEqual(offers.map((o) => [o.sourceProductId, o.priceCents, o.shipCents, o.condition, o.seller]), [
    ['7366082511916788769', 1049, 0, 'UNKNOWN', 'Example Store'],
    ['111', 899, 599, 'UNKNOWN', 'Other Store'],
    ['222', 400, null, 'USED', 'Used Store'],
  ]);
  assert.ok(offers.every((o) => o.gtinMatched === false && o.gtin === null));
  assert.ok(offers[0].url.startsWith('https://www.google.com/search'));
});

test('parseSerpApi: "no results" error is empty, other errors throw FEED_UPSTREAM', () => {
  assert.deepEqual(parseSerpApi(fx('serpapi-no-results.json'), 'x'), []);
  assert.throws(() => parseSerpApi(fx('serpapi-bad-key.json'), 'x'), (e: unknown) => e instanceof HttpError && e.code === 'FEED_UPSTREAM');
});

test('serpapiFeed: configured by SERPAPI_KEY, default budget 8/day, HTTP errors without the key', async () => {
  assert.equal(serpapiFeed.configured(baseEnv() as any), false);
  assert.equal(serpapiFeed.dailyBudget(baseEnv() as any), 8);
  const net = scriptedFetch([() => jsonResponse(fx('serpapi-shopping.json')), () => jsonResponse(fx('serpapi-bad-key.json'), 401)]);
  const e = baseEnv({ SERPAPI_KEY: 'skey' });
  assert.equal((await serpapiFeed.search(Q, ctx(e, net.fetch))).length, 3);
  await assert.rejects(serpapiFeed.search(Q, ctx(e, net.fetch)), (err: unknown) => err instanceof HttpError && !err.message.includes('skey'));
});

test('serpapiFeed is frugal: fresh for 24 h, stale copy kept at most 24 h, monthly cap 240 of the 250 free searches', () => {
  assert.equal(serpapiFeed.freshMs, 24 * 60 * 60 * 1000);
  assert.equal(serpapiFeed.maxStaleMs, 24 * 60 * 60 * 1000);
  assert.equal(serpapiFeed.monthlyBudget?.(baseEnv() as any), 240);
  assert.equal(serpapiFeed.monthlyBudget?.(baseEnv({ QUOTA_SERPAPI_MONTHLY: '100' }) as any), 100);
  assert.equal(serpapiFeed.monthlyBudget?.(baseEnv({ QUOTA_SERPAPI_MONTHLY: 'junk' }) as any), 240);
});

test('monthly quota: hard stop at the cap, resets on the 1st (UTC)', async () => {
  const kv = memKV(() => 0);
  const lastDay = Date.UTC(2026, 9, 31, 23, 59, 59);
  const firstDay = Date.UTC(2026, 10, 1, 0, 0, 0);
  assert.equal(utcMonth(lastDay), '2026-10');
  assert.deepEqual(await tryConsumeMonthly(kv, 'serpapi', 2, lastDay), { allowed: true, used: 1, remaining: 1 });
  assert.deepEqual(await tryConsumeMonthly(kv, 'serpapi', 2, lastDay), { allowed: true, used: 2, remaining: 0 });
  assert.deepEqual(await tryConsumeMonthly(kv, 'serpapi', 2, lastDay), { allowed: false, used: 2, remaining: 0 });
  assert.equal(await quotaRemainingMonthly(kv, 'serpapi', 2, firstDay), 2);
});

test('parseSerpApi: zero or negative prices are never emitted', () => {
  const body = { shopping_results: [
    { title: 'Free', product_id: '1', product_link: 'https://www.google.com/x', price: '$0.00', extracted_price: 0 },
    { title: 'Ok', product_id: '2', product_link: 'https://www.google.com/y', price: '$1.00', extracted_price: 1 },
  ] };
  assert.deepEqual(parseSerpApi(body, 'x').map((o) => o.priceCents), [100]);
});

test('serpapiFeed.search: a network error that echoes the URL never leaks the api key', async () => {
  const leaky = async (url: unknown) => { throw new TypeError('fetch failed: ' + String(url)); };
  await assert.rejects(serpapiFeed.search(Q, ctx(baseEnv({ SERPAPI_KEY: 'skey-secret' }), leaky)), (e: unknown) => e instanceof HttpError && e.code === 'FEED_UPSTREAM' && !e.message.includes('skey-secret'));
});

test('parseSerpApi: only https product links and images; others are skipped or nulled', () => {
  const item = (over: Record<string, unknown>) => ({ title: 'T', product_id: 'p', price: '$1.00', extracted_price: 1, product_link: 'https://www.google.com/x', ...over });
  const body = { shopping_results: [
    item({ product_id: 'ok', thumbnail: 'https://img.test/a.webp' }),
    item({ product_id: 'http', product_link: 'http://www.google.com/x' }),
    item({ product_id: 'js', product_link: 'javascript:alert(1)' }),
    item({ product_id: 'data', product_link: 'data:text/html,<b>x</b>' }),
    item({ product_id: 'legacy', product_link: undefined, link: 'https://www.google.com/legacy' }),
    item({ product_id: 'badimg', thumbnail: 'http://img.test/a.webp' }),
    item({ product_id: 'jsimg', thumbnail: 'javascript:alert(1)' }),
  ] };
  const offers = parseSerpApi(body, 'x');
  assert.deepEqual(offers.map((o) => [o.sourceProductId, o.imageUrl]), [['ok', 'https://img.test/a.webp'], ['badimg', null], ['jsimg', null]]);
});

test('parseSerpApi: USD evidence needs a $-prefixed price string; a bare extracted_price is not enough', () => {
  const body = { shopping_results: [
    { title: 'NoPriceText', product_id: '1', product_link: 'https://www.google.com/a', extracted_price: 5 },
    { title: 'NumericPrice', product_id: '2', product_link: 'https://www.google.com/b', price: 5, extracted_price: 5 },
    { title: 'Ok', product_id: '3', product_link: 'https://www.google.com/c', price: '$5.00', extracted_price: 5 },
  ] };
  assert.deepEqual(parseSerpApi(body, 'x').map((o) => o.sourceProductId), ['3']);
});

test('serpapiFeed.search: a 200 with a non-JSON body throws a static FEED_UPSTREAM without upstream text', async () => {
  const net = scriptedFetch([() => new Response('<html>secret-upstream-text skey</html>', { status: 200, headers: { 'content-type': 'text/html' } })]);
  await assert.rejects(serpapiFeed.search(Q, ctx(baseEnv({ SERPAPI_KEY: 'skey' }), net.fetch)), (e: unknown) =>
    e instanceof HttpError && e.status === 502 && e.code === 'FEED_UPSTREAM' && e.message === 'serpapi bad response');
});

test('serpapiFeed.search: the term is trimmed, and an empty term makes no upstream call', async () => {
  assert.equal(new URL(serpapiSearchUrl({ gtin: null, query: '   padded title  ', country: 'US' }, 'k')).searchParams.get('q'), 'padded title');
  const net = scriptedFetch([]);
  const e = baseEnv({ SERPAPI_KEY: 'skey' });
  assert.deepEqual(await serpapiFeed.search({ gtin: null, query: '   ', country: 'US' }, ctx(e, net.fetch)), []);
  assert.deepEqual(await serpapiFeed.search({ gtin: null, query: '', country: 'US' }, ctx(e, net.fetch)), []);
  assert.equal(net.calls.length, 0);
});

test('parseSerpApi: a 200 body with neither shopping_results nor error is a static FEED_UPSTREAM, never an empty REAL answer', () => {
  const bad = (e: unknown) => e instanceof HttpError && e.status === 502 && e.code === 'FEED_UPSTREAM' && e.message === 'serpapi bad response';
  for (const body of [{ search_metadata: { status: 'Processing' } }, {}, null, [], 'ok', 7]) {
    assert.throws(() => parseSerpApi(body, 'x'), bad, JSON.stringify(body));
  }
  assert.deepEqual(parseSerpApi({ shopping_results: [] }, 'x'), []); // a genuine empty answer stays valid
  assert.deepEqual(parseSerpApi(fx('serpapi-no-results.json'), 'x'), []);
});

test('serpapiFeed.search: a "Processing" 200 body throws a static FEED_UPSTREAM', async () => {
  const net = scriptedFetch([() => jsonResponse({ search_metadata: { status: 'Processing', id: 'abc' } })]);
  await assert.rejects(serpapiFeed.search(Q, ctx(baseEnv({ SERPAPI_KEY: 'skey' }), net.fetch)), (e: unknown) =>
    e instanceof HttpError && e.status === 502 && e.code === 'FEED_UPSTREAM' && e.message === 'serpapi bad response');
});

test('parseSerpApi: conservative word-bounded title fallback marks used/refurbished/pre-owned/renewed/open-box when second_hand_condition is absent', () => {
  const row = (title: string, extra: Record<string, unknown> = {}) => ({ title, product_id: 'p', price: '$5.00', extracted_price: 5, product_link: 'https://www.google.com/x', ...extra });
  const conditionOf = (title: string, extra: Record<string, unknown> = {}) => parseSerpApi({ shopping_results: [row(title, extra)] }, 'x')[0].condition;
  assert.equal(conditionOf('Used Insignia Case for iPhone 16 Pro'), 'USED');
  assert.equal(conditionOf('Insignia Case iPhone 16 Pro - USED - good'), 'USED');
  assert.equal(conditionOf('Pre-owned Insignia Case'), 'USED');
  assert.equal(conditionOf('Preowned Insignia Case'), 'USED');
  assert.equal(conditionOf('Insignia Case (Open Box)'), 'USED');
  assert.equal(conditionOf('Open-box Insignia Case'), 'USED');
  assert.equal(conditionOf('Refurbished Insignia Case'), 'REFURB');
  assert.equal(conditionOf('Renewed Insignia Case'), 'REFURB');
  assert.equal(conditionOf('Insignia Case for iPhone 16 Pro'), 'UNKNOWN');
  assert.equal(conditionOf('Misused Reuseable Case'), 'UNKNOWN'); // word-bounded: no substring matches
  assert.equal(conditionOf('Pre owned Insignia Case'), 'UNKNOWN');
  assert.equal(conditionOf('Insignia Case', { second_hand_condition: 'pre-owned' }), 'USED');
});

test('parseSerpApi: a non-string error is an upstream failure, not an empty answer', () => {
  assert.throws(() => parseSerpApi({ error: { code: 1 } }, 'x'), (e: unknown) => e instanceof HttpError && e.code === 'FEED_UPSTREAM' && e.message === 'serpapi error');
  assert.throws(() => parseSerpApi({ error: null }, 'x'), (e: unknown) => e instanceof HttpError && e.code === 'FEED_UPSTREAM');
});
