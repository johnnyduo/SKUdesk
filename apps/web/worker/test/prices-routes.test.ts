import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleFetch } from '../app.ts';
import { parseManifest } from '../manifest.ts';
import { parseCompareQuery } from '../routes/prices.ts';
import { HttpError } from '../http.ts';
import { FIXED_NOW_MS, baseEnv, fakeAssets, fakeExec, jsonResponse, limiter, memKV, testDeps } from './helpers/fakes.ts';
import { sqliteD1 } from './helpers/d1.ts';
import { quotaKey } from '../feeds/quota.ts';

// Routes by URL, so the test does not depend on the order in which sources run concurrently.
function routedFetch(routes: [RegExp, () => Response][]) {
  const calls: string[] = [];
  const fetchFn = async (input: Request | string | URL): Promise<Response> => {
    const u = String(input instanceof Request ? input.url : input);
    calls.push(u);
    const hit = routes.find(([re]) => re.test(u));
    if (!hit) throw new Error('unrouted call ' + u);
    return hit[1]();
  };
  return { fetch: fetchFn, calls };
}

const MANIFEST_RAW = readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8');
const MANIFEST = parseManifest(JSON.parse(MANIFEST_RAW));
const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/feeds/' + name, import.meta.url), 'utf8'));
const SITE = 'https://robinize.agent-dong.workers.dev';
const env = (over: Record<string, unknown> = {}) => baseEnv({ ASSETS: fakeAssets({ '/p/manifest.json': MANIFEST_RAW }), DB: sqliteD1(), CACHE: memKV(() => FIXED_NOW_MS), EBAY_API_BASE: 'https://api.ebay.com', QUOTA_SERPAPI_DAILY: '8', QUOTA_SERPAPI_MONTHLY: '240', QUOTA_EBAY_DAILY: '1000', QUOTA_BESTBUY_DAILY: '2000', ADMIN_TOKEN: ADMIN, ...over });
const ADMIN = 'adm-' + 'x'.repeat(40);
const SERP_URL = /serpapi\.com\/search/;
const SEARCHAPI_URL = /searchapi\.io/;
const HERO = '/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001';
const getAs = (token: string | null, path: string, e: unknown, deps: unknown = testDeps(), exec = fakeExec()) =>
  handleFetch(new Request(SITE + path, token === null ? undefined : { headers: { 'x-admin-token': token } }), e as any, exec as any, deps as any);
const get = (path: string, e: unknown, deps: unknown = testDeps(), exec = fakeExec()) => handleFetch(new Request(SITE + path), e as any, exec as any, deps as any);
const getAdmin = (path: string, e: unknown, deps: unknown = testDeps(), exec = fakeExec()) => getAs(ADMIN, path, e, deps, exec); // paid SerpApi/SearchApi calls need the operator token
const url = (qs: string) => new URL(SITE + '/api/prices/compare?' + qs);
const isCode = (status: number, code: string) => (e: unknown) => e instanceof HttpError && e.status === status && e.code === code;

test('parseCompareQuery: sku resolves canon; catalog gtin used only when checksum-valid; q fallback to title', () => {
  const bySku = parseCompareQuery(url('sku=SKU-TEST-GTIN'), MANIFEST);
  assert.deepEqual(bySku.q, { gtin: '036000291452', query: 'iPhone 16 Pro Black MagSafe Case', country: 'US' });
  const hero = parseCompareQuery(url('sku=CASE-IP16PRO-CLEAR-MAG-001'), MANIFEST);
  assert.equal(hero.q.gtin, null);
  assert.equal(parseCompareQuery(url('gtin=0036000291452'), MANIFEST).entry?.sku, 'SKU-TEST-GTIN');
  assert.equal(parseCompareQuery(url('gtin=4006381333931'), MANIFEST).entry, null);
  assert.equal(parseCompareQuery(url('q=%20clear%0Acase%20'), null).q.query, 'clear case');
});

test('parseCompareQuery: rejects bad gtin, non-US, unknown sku, empty, long q', () => {
  assert.throws(() => parseCompareQuery(url('gtin=850063102441'), MANIFEST), isCode(400, 'BAD_REQUEST'));
  assert.throws(() => parseCompareQuery(url('gtin=12ab'), MANIFEST), isCode(400, 'BAD_REQUEST'));
  assert.throws(() => parseCompareQuery(url('q=x&country=TH'), MANIFEST), isCode(400, 'BAD_REQUEST'));
  assert.throws(() => parseCompareQuery(url('sku=NOPE'), MANIFEST), isCode(404, 'UNKNOWN_SKU'));
  assert.throws(() => parseCompareQuery(url('sku=CASE-IP16PRO-CLEAR-MAG-001'), null), isCode(404, 'UNKNOWN_SKU'));
  assert.throws(() => parseCompareQuery(url(''), MANIFEST), isCode(400, 'BAD_REQUEST'));
  assert.throws(() => parseCompareQuery(url('q=' + 'x'.repeat(121)), MANIFEST), isCode(400, 'BAD_REQUEST'));
});

test('GET /api/prices/sources: all MOCK without keys; REAL + quota when configured; never echoes keys', async () => {
  const noKeys = await (await get('/api/prices/sources', env())).json() as any;
  assert.deepEqual(noKeys.sources.map((s: any) => [s.id, s.mode, s.configured, s.quotaRemaining]), [['ebay', 'MOCK', false, null], ['bestbuy', 'MOCK', false, null], ['serpapi', 'MOCK', false, null]]);
  const res = await get('/api/prices/sources', env({ SERPAPI_KEY: 'skey-123', BESTBUY_API_KEY: 'bb-456' }));
  const text = await res.text();
  assert.ok(!text.includes('skey-123') && !text.includes('bb-456'));
  assert.deepEqual(JSON.parse(text).sources.map((s: any) => [s.id, s.mode, s.quotaRemaining]), [['ebay', 'MOCK', null], ['bestbuy', 'REAL', 2000], ['serpapi', 'REAL', 8]]);
  const tight = await (await get('/api/prices/sources', env({ SERPAPI_KEY: 'skey-123', QUOTA_SERPAPI_MONTHLY: '3' }))).json() as any;
  assert.equal(tight.sources[2].quotaRemaining, 3);
});

test('GET /api/prices/sources: SerpApi carries its SearchApi.io backup (MOCK/not configured shown honestly, quota from the lifetime counter); others have none', async () => {
  const off = await (await get('/api/prices/sources', env())).json() as any;
  assert.deepEqual(off.sources.map((s: any) => s.backup), [undefined, undefined, { id: 'searchapi', label: 'SearchApi.io Google Shopping', configured: false, quotaRemaining: null }]);
  const kv = memKV(() => FIXED_NOW_MS);
  await kv.put('quota:v1t:searchapi', '88');
  const on = await get('/api/prices/sources', env({ CACHE: kv, SERPAPI_KEY: 'skey-123', SEARCH_API_KEY: 'sak-789' }));
  const text = await on.text();
  assert.ok(!text.includes('sak-789') && !text.includes('skey-123'));
  assert.deepEqual(JSON.parse(text).sources[2].backup, { id: 'searchapi', label: 'SearchApi.io Google Shopping', configured: true, quotaRemaining: 2 }); // min(3/day, 90 - 88 lifetime)
  assert.equal(JSON.parse(text).sources[2].id, 'serpapi');
  assert.equal(JSON.parse(text).sources.length, 3);
  const spent = memKV(() => FIXED_NOW_MS);
  await spent.put('quota:v1t:searchapi', '90');
  const none = await (await get('/api/prices/sources', env({ CACHE: spent, SEARCH_API_KEY: 'sak-789' }))).json() as any;
  assert.deepEqual([none.sources[2].backup.configured, none.sources[2].backup.quotaRemaining, none.sources[2].mode], [true, 0, 'MOCK']);
  const broken = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } };
  const kvDown = await (await get('/api/prices/sources', env({ CACHE: broken, SEARCH_API_KEY: 'sak-789' }))).json() as any;
  assert.deepEqual([kvDown.sources[2].backup.configured, kvDown.sources[2].backup.quotaRemaining], [true, null]);
});

test('GET /api/prices/compare without keys: 200, all MOCK, no network, nothing persisted', async () => {
  const e = env();
  const exec = fakeExec();
  const res = await get('/api/prices/compare?sku=SKU-TEST-GTIN', e, testDeps(), exec);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.deepEqual(body.sources.map((s: any) => s.mode), ['MOCK', 'MOCK', 'MOCK']);
  assert.ok(body.flags.includes('all_mock'));
  assert.equal(exec.waits.length, 0);
});

test('GET /api/prices/compare with eBay live: GTIN search, per-source best, observations persisted', async () => {
  const e = env({ EBAY_CLIENT_ID: 'cid', EBAY_CLIENT_SECRET: 'cs' });
  const net = routedFetch([[/oauth2\/token/, () => jsonResponse(fx('ebay-token.json'))], [/item_summary\/search/, () => jsonResponse(fx('ebay-search.json'))]]);
  const exec = fakeExec();
  const res = await get('/api/prices/compare?sku=SKU-TEST-GTIN', e, testDeps({ fetch: net.fetch }), exec);
  const body = await res.json() as any;
  assert.deepEqual(body.sources.slice(0, 1).map((s: any) => [s.id, s.mode, s.cache, s.bestCents, s.locked, s.offers]), [['ebay', 'REAL', 'MISS', 989, 2, 3]]);
  assert.deepEqual(body.sources.slice(1).map((s: any) => s.mode), ['MOCK', 'MOCK']);
  assert.equal(new URL(net.calls.find((u) => u.includes('item_summary'))!).searchParams.get('gtin'), '036000291452');
  await Promise.all(exec.waits);
  const sources = (e.DB as any).raw.prepare('SELECT DISTINCT source FROM price_observations ORDER BY source').all().map((r: any) => r.source);
  assert.deepEqual(sources, ['ebay']);
});

test('GET /api/prices/compare with eBay + Best Buy live: per-source best, REAL spread, observations persisted', async () => {
  const e = env({ EBAY_CLIENT_ID: 'cid', EBAY_CLIENT_SECRET: 'cs', BESTBUY_API_KEY: 'bb' });
  // Sources run in parallel, so the script routes by URL, never by call order.
  const net = routedFetch([
    [/oauth2\/token/, () => jsonResponse(fx('ebay-token.json'))],
    [/buy\/browse\//, () => jsonResponse(fx('ebay-search.json'))],
    [/api\.bestbuy\.com/, () => jsonResponse(fx('bestbuy-upc.json'))],
  ]);
  const exec = fakeExec();
  const res = await get('/api/prices/compare?sku=SKU-TEST-GTIN', e, testDeps({ fetch: net.fetch }), exec);
  const body = await res.json() as any;
  assert.deepEqual(body.sources.map((s: any) => [s.id, s.mode, s.cache, s.bestCents, s.locked, s.offers]), [
    ['ebay', 'REAL', 'MISS', 989, 2, 3],
    ['bestbuy', 'REAL', 'MISS', 1099, 1, 2],
    ['serpapi', 'MOCK', 'NONE', body.sources[2].bestCents, 3, 3],
  ]);
  assert.deepEqual(body.spread, { minCents: 989, maxCents: 1099, deltaCents: 110, deltaBps: 1112, basis: 'REAL', sources: 2 });
  assert.deepEqual(body.flags, []);
  assert.equal(new URL(net.calls.find((u) => /buy\/browse\//.test(u))!).searchParams.get('gtin'), '036000291452');
  assert.ok(net.calls.find((u) => u.startsWith('https://api.bestbuy.com/v1/products(upc=036000291452)?')));
  await Promise.all(exec.waits);
  const n = (e.DB as any).raw.prepare('SELECT COUNT(*) AS n FROM price_observations').get().n;
  assert.equal(n, 5);
  const sources = (e.DB as any).raw.prepare('SELECT DISTINCT source FROM price_observations ORDER BY source').all().map((r: any) => r.source);
  assert.deepEqual(sources, ['bestbuy', 'ebay']);
});

test('GET /api/prices/compare with SerpApi: one live search, repeat request is a cache HIT with zero extra calls and quota', async () => {
  const e = env({ SERPAPI_KEY: 'skey' });
  const net = routedFetch([[/serpapi\.com\/search/, () => jsonResponse(fx('serpapi-shopping.json'))]]);
  const exec = fakeExec();
  const path = '/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001';
  const first = await (await getAdmin(path, e, testDeps({ fetch: net.fetch }), exec)).json() as any;
  const serp = first.sources.find((s: any) => s.id === 'serpapi');
  assert.deepEqual([serp.mode, serp.cache, serp.offers, serp.quotaRemaining], ['REAL', 'MISS', 3, 7]);
  assert.equal(new URL(net.calls[0]).searchParams.get('q'), 'iPhone 16 Pro Clear MagSafe Case');
  const again = await (await getAdmin(path, e, testDeps({ fetch: net.fetch }), fakeExec())).json() as any;
  const serp2 = again.sources.find((s: any) => s.id === 'serpapi');
  assert.deepEqual([serp2.cache, serp2.quotaRemaining, net.calls.length], ['HIT', 7, 1]);
  await Promise.all(exec.waits);
  const rows = (e.DB as any).raw.prepare("SELECT COUNT(*) AS n FROM price_observations WHERE source = 'serpapi'").get().n;
  assert.equal(rows, 3);
});

test('GET /api/prices/compare with SerpApi: a cheaper hard-shell keyword title is returned unlocked and never sets the best price', async () => {
  const e = env({ SERPAPI_KEY: 'skey' });
  const net = routedFetch([[/serpapi\.com\/search/, () => jsonResponse(fx('serpapi-shopping-hardshell.json'))]]);
  const body = await (await getAdmin('/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001', e, testDeps({ fetch: net.fetch }), fakeExec())).json() as any;
  const serp = body.sources.find((s: any) => s.id === 'serpapi');
  assert.deepEqual([serp.offers, serp.locked, serp.bestCents], [4, 2, 1049]);
  const serpOffers = body.offers.filter((o: any) => o.source === 'serpapi');
  const hard = serpOffers.find((o: any) => o.priceCents === 699);
  assert.equal(hard.locked, false);
  assert.match(hard.rejectReasons.join(' | '), /form: title says hard-shell/);
  assert.deepEqual(serpOffers.filter((o: any) => o.locked).map((o: any) => o.priceCents), [1049, 1499]);
});

test('GET /api/prices/compare with SerpApi: a PopSockets PopCase package at 26.98 is returned unlocked and never sets the best price', async () => {
  const e = env({ SERPAPI_KEY: 'skey' });
  const net = routedFetch([[/serpapi\.com\/search/, () => jsonResponse(fx('serpapi-shopping-popcase.json'))]]);
  const body = await (await getAdmin('/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001', e, testDeps({ fetch: net.fetch }), fakeExec())).json() as any;
  const serp = body.sources.find((s: any) => s.id === 'serpapi');
  assert.deepEqual([serp.offers, serp.locked, serp.bestCents], [3, 0, null]);
  const pop = body.offers.find((o: any) => o.source === 'serpapi' && o.priceCents === 2698);
  assert.equal(pop.locked, false);
  assert.match(pop.rejectReasons.join(' | '), /form: title says popsockets/);
});

test('GET /api/prices/compare: a free-text q (no manifest entry) never calls SerpApi; a known sku still may', async () => {
  const e = env({ SERPAPI_KEY: 'skey' });
  const net = routedFetch([[/serpapi\.com\/search/, () => jsonResponse(fx('serpapi-shopping.json'))]]);
  const free = await (await getAdmin('/api/prices/compare?q=' + encodeURIComponent('some random thing'), e, testDeps({ fetch: net.fetch }))).json() as any;
  assert.equal(net.calls.length, 0);
  assert.equal(free.sources.some((s: any) => s.id === 'serpapi'), false);
  assert.equal(await (e.CACHE as any).get(quotaKey('serpapi', FIXED_NOW_MS)), null); // no daily slot burned
  const unknownGtin = await getAdmin('/api/prices/compare?gtin=4006381333931', e, testDeps({ fetch: net.fetch }));
  assert.equal(unknownGtin.status, 200);
  assert.equal(net.calls.length, 0);
  await getAdmin('/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001', e, testDeps({ fetch: net.fetch }));
  assert.equal(net.calls.length, 1);
});

test('GET /api/prices/sources: a KV failure degrades quotaRemaining to null, never a 500', async () => {
  const broken = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } };
  const res = await get('/api/prices/sources', env({ CACHE: broken, BESTBUY_API_KEY: 'bb', SERPAPI_KEY: 'sk' }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as any).sources.map((s: any) => [s.id, s.mode, s.quotaRemaining]), [['ebay', 'MOCK', null], ['bestbuy', 'REAL', null], ['serpapi', 'REAL', null]]);
});

test('GET /api/prices/compare: a failing D1 insert still returns 200 and logs a warning (code only, no secrets)', async () => {
  const e = env({ SERPAPI_KEY: 'skey-secret', DB: { prepare: () => { throw new Error('d1 down skey-secret'); } } });
  const net = routedFetch([[/serpapi\.com\/search/, () => jsonResponse(fx('serpapi-shopping.json'))]]);
  const exec = fakeExec();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    const res = await getAdmin('/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001', e, testDeps({ fetch: net.fetch }), exec);
    assert.equal(res.status, 200);
    await Promise.all(exec.waits);
  } finally { console.log = orig; }
  const warn = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.event === 'observations_insert_failed');
  assert.ok(warn);
  assert.deepEqual([warn.level, warn.code], ['warn', 'D1_INSERT_FAILED']);
  assert.ok(!lines.join('\n').includes('skey-secret'));
});

test('GET /api/prices/compare: RL_COMPARE refusal -> 429; bad input -> 400 envelope', async () => {
  assert.equal((await get('/api/prices/compare?q=x', env({ RL_COMPARE: limiter(0) }))).status, 429);
  const bad = await get('/api/prices/compare?gtin=123', env());
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as any).error.code, 'BAD_REQUEST');
});

test('parseCompareQuery: a sku rejects a GTIN for another product; the catalog title replaces caller q', () => {
  assert.throws(() => parseCompareQuery(url('sku=SKU-TEST-GTIN&gtin=4006381333931'), MANIFEST), isCode(400, 'BAD_REQUEST'));
  assert.equal(parseCompareQuery(url('sku=SKU-TEST-GTIN&gtin=0036000291452'), MANIFEST).q.gtin, '0036000291452');
  const withQ = parseCompareQuery(url('sku=SKU-TEST-GTIN&q=arbitrary%20text'), MANIFEST);
  assert.equal(withQ.q.query, 'iPhone 16 Pro Black MagSafe Case');
  const viaGtin = parseCompareQuery(url('gtin=0036000291452&q=arbitrary%20text'), MANIFEST);
  assert.equal(viaGtin.q.query, 'iPhone 16 Pro Black MagSafe Case');
  assert.equal(parseCompareQuery(url('gtin=4006381333931&q=free%20text'), MANIFEST).q.query, 'free text');
});

test('GET /api/prices/compare: sku + arbitrary q makes SerpApi search the catalog title; mismatched gtin -> 400 with no calls', async () => {
  const e = env({ SERPAPI_KEY: 'skey' });
  const net = routedFetch([[/serpapi\.com\/search/, () => jsonResponse(fx('serpapi-shopping.json'))]]);
  const res = await getAdmin('/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001&q=' + encodeURIComponent('buy bitcoin now'), e, testDeps({ fetch: net.fetch }));
  assert.equal(res.status, 200);
  assert.equal(new URL(net.calls[0]).searchParams.get('q'), 'iPhone 16 Pro Clear MagSafe Case');
  const bad = await getAdmin('/api/prices/compare?sku=SKU-TEST-GTIN&gtin=4006381333931', e, testDeps({ fetch: net.fetch }));
  assert.equal(bad.status, 400);
  assert.equal(net.calls.length, 1);
});

test('GET /api/prices/compare: log.mode is REAL / DEGRADED / MOCK from the sources', async () => {
  const run = async (e: unknown, deps: unknown) => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try { await get('/api/prices/compare?sku=SKU-TEST-GTIN', e, deps); } finally { console.log = orig; }
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.route === '/api/prices/compare').mode;
  };
  assert.equal(await run(env(), testDeps()), 'MOCK');
  const down = routedFetch([[/./, () => jsonResponse({}, 500)]]);
  assert.equal(await run(env({ BESTBUY_API_KEY: 'bb' }), testDeps({ fetch: down.fetch })), 'DEGRADED');
  const up = routedFetch([[/api\.bestbuy\.com/, () => jsonResponse(fx('bestbuy-upc.json'))]]);
  assert.equal(await run(env({ BESTBUY_API_KEY: 'bb' }), testDeps({ fetch: up.fetch })), 'REAL');
});

test('parseCompareQuery: a sku whose entry has no GTIN refuses any caller-supplied gtin; sku-only and gtin-only still work', () => {
  assert.throws(() => parseCompareQuery(url('sku=CASE-IP16PRO-CLEAR-MAG-001&gtin=4006381333931'), MANIFEST), isCode(400, 'BAD_REQUEST'));
  assert.throws(() => parseCompareQuery(url('sku=CASE-IP16PRO-CLEAR-MAG-001&gtin=0036000291452'), MANIFEST), isCode(400, 'BAD_REQUEST'));
  const skuOnly = parseCompareQuery(url('sku=CASE-IP16PRO-CLEAR-MAG-001'), MANIFEST);
  assert.equal(skuOnly.q.gtin, null);
  assert.equal(skuOnly.entry?.sku, 'CASE-IP16PRO-CLEAR-MAG-001');
  assert.equal(parseCompareQuery(url('gtin=4006381333931&q=free%20text'), MANIFEST).q.gtin, '4006381333931');
});

test('GET /api/prices/compare: sku (no GTIN in catalog) + any valid gtin -> 400 with zero upstream calls; sku-only and gtin-only still 200', async () => {
  const e = env({ SERPAPI_KEY: 'skey' });
  const net = routedFetch([[/serpapi\.com\/search/, () => jsonResponse(fx('serpapi-shopping.json'))]]);
  const bad = await getAdmin('/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001&gtin=4006381333931', e, testDeps({ fetch: net.fetch }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as any).error.code, 'BAD_REQUEST');
  assert.equal(net.calls.length, 0);
  assert.equal(await (e.CACHE as any).get(quotaKey('serpapi', FIXED_NOW_MS)), null);
  const skuOnly = await getAdmin('/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001', e, testDeps({ fetch: net.fetch }));
  assert.equal(skuOnly.status, 200);
  assert.equal(net.calls.length, 1);
  const gtinOnly = await getAdmin('/api/prices/compare?gtin=4006381333931&q=free%20text', e, testDeps({ fetch: net.fetch }));
  assert.equal(gtinOnly.status, 200);
});

// Anonymous visitors must never spend the paid SerpApi / SearchApi.io plans
const serpOf = (body: any) => body.sources.find((s: any) => s.id === 'serpapi');
const paidNet = () => routedFetch([[SERP_URL, () => jsonResponse(fx('serpapi-shopping.json'))], [SEARCHAPI_URL, () => jsonResponse(fx('serpapi-shopping.json'))]]);

test('compare, non-admin, paid feed, cache miss: zero serpapi/searchapi calls, error refresh_requires_operator, no counters touched', async () => {
  const e = env({ SERPAPI_KEY: 'skey', SEARCH_API_KEY: 'sak', ADMIN_TOKEN: ADMIN });
  const net = paidNet();
  const res = await getAs(null, HERO, e, testDeps({ fetch: net.fetch }));
  assert.equal(res.status, 200);
  const serp = serpOf(await res.json());
  assert.deepEqual([serp.mode, serp.cache, serp.offers, serp.error, serp.configured, serp.locked], ['REAL', 'NONE', 0, 'refresh_requires_operator', true, 0]);
  assert.equal(net.calls.length, 0);
  const kv = e.CACHE as any;
  assert.equal(await kv.get(quotaKey('serpapi', FIXED_NOW_MS)), null);
  assert.equal(await kv.get('quota:v1m:serpapi:2026-10'), null);
  assert.equal(await kv.get('quota:v1:searchapi:2026-10-02'), null);
  assert.equal(await kv.get('quota:v1t:searchapi'), null);
  assert.deepEqual(kv.puts, []);
});

test('compare, non-admin, every catalog sku: still zero paid calls (different skus cannot spend the plan)', async () => {
  const e = env({ SERPAPI_KEY: 'skey', SEARCH_API_KEY: 'sak', ADMIN_TOKEN: ADMIN });
  const net = paidNet();
  for (const sku of ['CASE-IP16PRO-CLEAR-MAG-001', 'SKU-TEST-GTIN']) await getAs(null, '/api/prices/compare?sku=' + sku, e, testDeps({ fetch: net.fetch }));
  assert.equal(net.calls.length, 0);
});

test('compare, non-admin, paid feed with a fresh cached copy: HIT from KV, zero calls', async () => {
  const e = env({ SERPAPI_KEY: 'skey', ADMIN_TOKEN: ADMIN });
  const net = paidNet();
  const first = serpOf(await (await getAs(ADMIN, HERO, e, testDeps({ fetch: net.fetch }))).json());
  assert.deepEqual([first.cache, first.offers], ['MISS', 3]);
  assert.equal(net.calls.length, 1);
  const again = serpOf(await (await getAs(null, HERO, e, testDeps({ fetch: net.fetch }))).json());
  assert.deepEqual([again.mode, again.cache, again.offers, again.error], ['REAL', 'HIT', 3, null]);
  assert.equal(net.calls.length, 1);
});

test('compare, admin token, paid feed, cache miss: exactly one paid call, daily and monthly counters incremented once', async () => {
  const e = env({ SERPAPI_KEY: 'skey', ADMIN_TOKEN: ADMIN });
  const net = paidNet();
  const serp = serpOf(await (await getAs(ADMIN, HERO, e, testDeps({ fetch: net.fetch }))).json());
  assert.deepEqual([serp.mode, serp.cache, serp.error, serp.quotaRemaining], ['REAL', 'MISS', null, 7]);
  assert.equal(net.calls.length, 1);
  assert.equal(await (e.CACHE as any).get(quotaKey('serpapi', FIXED_NOW_MS)), '1');
  assert.equal(await (e.CACHE as any).get('quota:v1m:serpapi:2026-10'), '1');
});

test('compare: a wrong, short or empty admin token behaves as non-admin (no paid call)', async () => {
  for (const token of ['wrong-' + 'y'.repeat(40), 'short', '', ADMIN.slice(0, -1)]) {
    const e = env({ SERPAPI_KEY: 'skey', ADMIN_TOKEN: ADMIN });
    const net = paidNet();
    const serp = serpOf(await (await getAs(token, HERO, e, testDeps({ fetch: net.fetch }))).json());
    assert.equal(serp.error, 'refresh_requires_operator', 'token ' + JSON.stringify(token));
    assert.equal(net.calls.length, 0);
  }
  // A configured ADMIN_TOKEN shorter than 32 chars can never authenticate anyone, not even a matching header.
  const weak = env({ SERPAPI_KEY: 'skey', ADMIN_TOKEN: 'short-secret' });
  const net = paidNet();
  assert.equal(serpOf(await (await getAs('short-secret', HERO, weak, testDeps({ fetch: net.fetch }))).json()).error, 'refresh_requires_operator');
  assert.equal(net.calls.length, 0);
});

test('compare, non-admin: eBay and Best Buy still call upstream (only the paid feed is cache-only)', async () => {
  const e = env({ EBAY_CLIENT_ID: 'cid', EBAY_CLIENT_SECRET: 'cs', BESTBUY_API_KEY: 'bb', SERPAPI_KEY: 'skey', ADMIN_TOKEN: ADMIN });
  const net = routedFetch([
    [/oauth2\/token/, () => jsonResponse(fx('ebay-token.json'))],
    [/buy\/browse\//, () => jsonResponse(fx('ebay-search.json'))],
    [/api\.bestbuy\.com/, () => jsonResponse(fx('bestbuy-upc.json'))],
  ]);
  const body = await (await getAs(null, '/api/prices/compare?sku=SKU-TEST-GTIN', e, testDeps({ fetch: net.fetch }))).json() as any;
  assert.deepEqual(body.sources.map((s: any) => [s.id, s.mode, s.cache, s.error]), [['ebay', 'REAL', 'MISS', null], ['bestbuy', 'REAL', 'MISS', null], ['serpapi', 'REAL', 'NONE', 'refresh_requires_operator']]);
  assert.ok(net.calls.some((u) => /buy\/browse\//.test(u)) && net.calls.some((u) => /api\.bestbuy\.com/.test(u)));
  assert.ok(!net.calls.some((u) => SERP_URL.test(u) || SEARCHAPI_URL.test(u)));
});

test('compare: the operator-required condition never triggers the SearchApi.io fallback; an admin outage of SerpApi still does', async () => {
  const e = env({ SERPAPI_KEY: 'skey', SEARCH_API_KEY: 'sak', ADMIN_TOKEN: ADMIN });
  const down = routedFetch([[SERP_URL, () => jsonResponse({}, 503)], [SEARCHAPI_URL, () => jsonResponse(fx('searchapi-shopping.json'))]]);
  await getAs(null, HERO, e, testDeps({ fetch: down.fetch }));
  assert.equal(down.calls.length, 0);
  const viaAdmin = serpOf(await (await getAs(ADMIN, HERO, e, testDeps({ fetch: down.fetch }))).json());
  assert.equal(viaAdmin, undefined); // the backup answered as source "searchapi"
  assert.deepEqual(down.calls.map((u) => (SERP_URL.test(u) ? 'serpapi' : 'searchapi')), ['serpapi', 'searchapi']);
});

test('compare: the rate-limit key is the verified admin hash for a valid token and the IP for anything else', async () => {
  const rl = limiter();
  const e = env({ SERPAPI_KEY: 'skey', ADMIN_TOKEN: ADMIN, RL_COMPARE: rl });
  await getAs(ADMIN, HERO, e, testDeps({ fetch: paidNet().fetch }));
  await getAs('forged-' + 'z'.repeat(40), HERO, e, testDeps({ fetch: paidNet().fetch }));
  assert.match(rl.keys[0], /^GET \/api\/prices\/compare:adm:[0-9a-f]{16}$/);
  assert.match(rl.keys[1], /^GET \/api\/prices\/compare:ip:/);
});
