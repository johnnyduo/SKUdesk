import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EBAY_TOKEN_KEY, ebayFeed, ebaySearchUrl, parseEbay } from '../feeds/ebay.ts';
import { HttpError } from '../http.ts';
import { FIXED_NOW_MS, baseEnv, jsonResponse, memKV, scriptedFetch } from './helpers/fakes.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/feeds/' + name, import.meta.url), 'utf8'));
const Q = { gtin: '036000291452', query: 'iPhone 16 Pro Clear MagSafe Case', country: 'US' as const };
const env = (over: Record<string, unknown> = {}) => baseEnv({ EBAY_API_BASE: 'https://api.ebay.com', EBAY_CLIENT_ID: 'cid', EBAY_CLIENT_SECRET: 'csecret', QUOTA_EBAY_DAILY: '1000', CACHE: memKV(() => FIXED_NOW_MS), ...over });
const ctx = (e: unknown, f: unknown) => ({ env: e as any, fetch: f as any, signal: AbortSignal.timeout(5000), nowMs: FIXED_NOW_MS });

test('ebaySearchUrl: gtin search without q, NEW + FIXED_PRICE + US/USD filter; keyword fallback', () => {
  const u = new URL(ebaySearchUrl('https://api.ebay.com', Q));
  assert.equal(u.pathname, '/buy/browse/v1/item_summary/search');
  assert.equal(u.searchParams.get('gtin'), '036000291452');
  assert.equal(u.searchParams.get('q'), null);
  assert.equal(u.searchParams.get('filter'), 'conditions:{NEW},buyingOptions:{FIXED_PRICE},deliveryCountry:US,priceCurrency:USD');
  const k = new URL(ebaySearchUrl('https://api.sandbox.ebay.com', { ...Q, gtin: null }));
  assert.equal(k.searchParams.get('q'), 'iPhone 16 Pro Clear MagSafe Case');
  assert.equal(k.host, 'api.sandbox.ebay.com');
});

test('parseEbay: string prices to cents, USD only, shipping FIXED vs CALCULATED, conditions', () => {
  const offers = parseEbay(fx('ebay-search.json'), Q, '2026-10-02T12:00:00.000Z');
  assert.deepEqual(offers.map((o) => [o.sourceProductId, o.priceCents, o.shipCents, o.condition]), [
    ['v1|111111111111|0', 989, 0, 'NEW'],
    ['v1|222222222222|0', 1149, 150, 'NEW'],
    ['v1|333333333333|0', 400, null, 'USED'],
  ]);
  assert.equal(offers[0].gtinMatched, true);
  assert.equal(offers[0].gtin, null);
  assert.equal(offers[0].imageUrl, 'https://i.ebayimg.com/images/g/a/s-l225.jpg');
  assert.equal(parseEbay(fx('ebay-search.json'), { ...Q, gtin: null }, 'x')[0].gtinMatched, false);
  assert.deepEqual(parseEbay(fx('ebay-empty.json'), Q, 'x'), []);
  assert.deepEqual(parseEbay(null, Q, 'x'), []);
});

test('parseEbay: drops zero/invalid prices; non-USD shipping stays unknown; conditionId bands', () => {
  const mk = (over: Record<string, unknown>) => ({ itemId: 'v1|9|0', title: 't', itemWebUrl: 'https://www.ebay.com/itm/9', price: { value: '5.00', currency: 'USD' }, ...over });
  const json = { itemSummaries: [
    mk({ itemId: 'zero', price: { value: '0.00', currency: 'USD' } }),
    mk({ itemId: 'comma', price: { value: '5,00', currency: 'USD' } }),
    mk({ itemId: 'nocur', price: { value: '5.00' } }),
    mk({ itemId: 'gbpship', shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '3.00', currency: 'GBP' } }] }),
    mk({ itemId: 'refurb', conditionId: '2500' }),
    mk({ itemId: 'badship', shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: 'abc', currency: 'USD' } }] }),
  ] };
  const offers = parseEbay(json, Q, 'x');
  assert.deepEqual(offers.map((o) => [o.sourceProductId, o.priceCents, o.shipCents, o.condition]), [
    ['gbpship', 500, null, 'UNKNOWN'],
    ['refurb', 500, null, 'REFURB'],
    ['badship', 500, null, 'UNKNOWN'],
  ]);
  assert.ok(offers.every((o) => o.priceCents > 0 && o.currency === 'USD'));
});

test('ebayFeed: configured only with both secrets; budget from var; 6h staleness', () => {
  assert.equal(ebayFeed.configured(env() as any), true);
  assert.equal(ebayFeed.configured(env({ EBAY_CLIENT_SECRET: undefined }) as any), false);
  assert.equal(ebayFeed.dailyBudget(env({ QUOTA_EBAY_DAILY: '7' }) as any), 7);
  assert.equal(ebayFeed.maxStaleMs, 6 * 60 * 60 * 1000);
  assert.equal(ebayFeed.searchesByGtin, true);
});

test('ebayFeed.search: client-credentials token (Basic auth, api_scope), cached; marketplace header', async () => {
  const e = env();
  const net = scriptedFetch([() => jsonResponse(fx('ebay-token.json')), () => jsonResponse(fx('ebay-search.json')), () => jsonResponse(fx('ebay-empty.json'))]);
  const offers = await ebayFeed.search(Q, ctx(e, net.fetch));
  assert.equal(offers.length, 3);
  assert.equal(net.calls[0].url, 'https://api.ebay.com/identity/v1/oauth2/token');
  assert.equal(net.calls[0].headers.authorization, 'Basic ' + btoa('cid:csecret'));
  assert.equal(new URLSearchParams(net.calls[0].body ?? '').get('scope'), 'https://api.ebay.com/oauth/api_scope');
  assert.equal(net.calls[1].headers.authorization, 'Bearer v^1.1#i^1#FAKE-TEST-TOKEN');
  assert.equal(net.calls[1].headers['x-ebay-c-marketplace-id'], 'EBAY_US');
  assert.equal((e.CACHE as any).puts.find((p: any) => p.key === EBAY_TOKEN_KEY).ttl, 6900);
  await ebayFeed.search(Q, ctx(e, net.fetch));
  assert.equal(net.calls.length, 3);
});

test('ebayFeed.search: 401 refreshes token once; other errors -> FEED_UPSTREAM without secrets', async () => {
  const e = env();
  const net = scriptedFetch([() => jsonResponse(fx('ebay-token.json')), () => jsonResponse({}, 401), () => jsonResponse(fx('ebay-token.json')), () => jsonResponse(fx('ebay-empty.json'))]);
  assert.deepEqual(await ebayFeed.search(Q, ctx(e, net.fetch)), []);
  assert.equal(net.calls.length, 4);
  const bad = scriptedFetch([() => jsonResponse(fx('ebay-token.json')), () => jsonResponse({ errors: [{ message: 'x' }] }, 500)]);
  await assert.rejects(ebayFeed.search(Q, ctx(env(), bad.fetch)), (err: unknown) => err instanceof HttpError && err.code === 'FEED_UPSTREAM' && !err.message.includes('csecret'));
});

test('parseEbay: gtinMatched follows Boolean(q.gtin) (empty string is not a GTIN query); non-https url skips, image nulls', () => {
  assert.equal(parseEbay(fx('ebay-search.json'), { ...Q, gtin: '' }, 'x')[0].gtinMatched, false);
  assert.equal(new URL(ebaySearchUrl('https://api.ebay.com', { ...Q, gtin: '' })).searchParams.get('gtin'), null);
  const mk = (itemWebUrl: unknown, imageUrl: unknown) => ({ itemSummaries: [{ itemId: 'a', title: 't', itemWebUrl, image: { imageUrl }, price: { value: '5.00', currency: 'USD' } }] });
  assert.equal(parseEbay(mk('http://www.ebay.com/itm/1', 'https://i/x.jpg'), Q, 'x').length, 0);
  assert.equal(parseEbay(mk('https://www.ebay.com/itm/1', 'http://i/x.jpg'), Q, 'x')[0].imageUrl, null);
});

test('ebayFeed.search: a failing KV put does not fail the call; the token fetch honors the caller signal', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  kv.put = async () => { throw new Error('KV down'); };
  const net = scriptedFetch([() => jsonResponse(fx('ebay-token.json')), () => jsonResponse(fx('ebay-search.json'))]);
  assert.equal((await ebayFeed.search(Q, ctx(env({ CACHE: kv }), net.fetch))).length, 3);

  const seen: AbortSignal[] = [];
  const hang = ((_url: string, init?: RequestInit) => {
    seen.push(init!.signal as AbortSignal);
    return new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
  }) as any;
  const ac = new AbortController();
  const p = ebayFeed.search(Q, { env: env() as any, fetch: hang, signal: ac.signal, nowMs: FIXED_NOW_MS });
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await assert.rejects(p);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].aborted, true);
});
