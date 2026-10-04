import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { FRESH_MS, feedCacheKey, writeFeedCache } from '../feeds/cache.ts';
import { testOffers, seedOf } from '../feeds/testdata.ts';
import { FEEDS } from '../feeds/registry.ts';
import { runCompare, runSource } from '../feeds/run.ts';
import { monthlyQuotaKey, quotaKey, totalQuotaKey } from '../feeds/quota.ts';
import type { FeedOffer, PriceFeed } from '../feeds/types.ts';
import { HttpError } from '../http.ts';
import { FIXED_NOW_MS, baseEnv, memKV } from './helpers/fakes.ts';

const Q = { gtin: '036000291452', query: 'iPhone 16 Pro Clear MagSafe Case', country: 'US' as const };
const offer = (priceCents: number): FeedOffer => ({ source: 'fake', sourceProductId: 'p' + priceCents, title: 'Clear MagSafe Case for iPhone 16 Pro', priceCents, currency: 'USD', shipCents: 0, url: 'https://x.test/' + priceCents, imageUrl: null, seller: null, gtin: null, condition: 'NEW', observedAt: 'now', gtinMatched: true });

function fakeFeed(over: Partial<PriceFeed> & { calls?: { n: number } } = {}): PriceFeed & { calls: { n: number } } {
  const calls = over.calls ?? { n: 0 };
  return {
    id: 'fake', label: 'Fake', attribution: 'Fake', searchesByGtin: true, maxStaleMs: 6 * 3600_000,
    configured: () => true, dailyBudget: () => 5,
    search: async () => { calls.n++; return [offer(1000)]; },
    ...over, calls,
  };
}
const deps = (feeds: PriceFeed[], env = baseEnv({ CACHE: memKV(() => FIXED_NOW_MS) })) => ({ env: env as any, fetch: (async () => { throw new Error('no net'); }) as any, nowMs: FIXED_NOW_MS, feeds });

test('registry lists the registered sources in display order', () => {
  assert.deepEqual(FEEDS.map((f) => f.id), ['ebay', 'bestbuy', 'serpapi']);
});

test('testOffers are deterministic, integer cents, labeled test sellers', () => {
  const a = testOffers('ebay', Q, 1099, 'T', 0);
  assert.deepEqual(a, testOffers('ebay', Q, 1099, 'T', 0));
  assert.notDeepEqual(a.map((o) => o.priceCents), testOffers('serpapi', Q, 1099, 'T', 0).map((o) => o.priceCents));
  assert.ok(a.every((o) => Number.isSafeInteger(o.priceCents) && o.priceCents >= 99 && o.url === ''));
  assert.ok(a.every((o, i) => o.seller === 'Test seller ' + (i + 1)));
  assert.equal(seedOf('abc'), seedOf('abc'));
});

test('runSource: unconfigured -> MOCK without network or quota use', async () => {
  const d = deps([]);
  const r = await runSource(fakeFeed({ configured: () => false }), Q, null, d);
  assert.deepEqual([r.mode, r.cache, r.offers.length, r.quotaRemaining], ['MOCK', 'NONE', 3, null]);
  assert.equal((d.env.CACHE as any).puts.length, 0);
});

test('runSource: miss -> live + cache write + quota; second call within 10 min -> HIT', async () => {
  const d = deps([]);
  const feed = fakeFeed();
  const first = await runSource(feed, Q, null, d);
  assert.deepEqual([first.mode, first.cache, first.quotaRemaining], ['REAL', 'MISS', 4]);
  const second = await runSource(feed, Q, null, d);
  assert.deepEqual([second.mode, second.cache, second.quotaRemaining], ['REAL', 'HIT', 4]);
  assert.equal(feed.calls.n, 1);
});

test('runSource: quota exhausted -> DEGRADED, STALE copy only within maxStaleMs', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const d = deps([], baseEnv({ CACHE: kv }));
  await kv.put(quotaKey('fake', FIXED_NOW_MS), '5');
  const none = await runSource(fakeFeed(), Q, null, d);
  assert.deepEqual([none.mode, none.cache, none.error, none.offers.length], ['DEGRADED', 'NONE', 'quota_exhausted', 0]);
  await writeFeedCache(kv, await feedCacheKey('fake', Q), { fetchedAtMs: FIXED_NOW_MS - FRESH_MS - 1, offers: [offer(900)] }, 6 * 3600_000);
  const stale = await runSource(fakeFeed(), Q, null, d);
  assert.deepEqual([stale.mode, stale.cache, stale.offers[0].priceCents], ['DEGRADED', 'STALE', 900]);
  const tooOld = await runSource(fakeFeed({ maxStaleMs: FRESH_MS }), Q, null, d);
  assert.equal(tooOld.cache, 'NONE');
});

test('runSource: upstream failure -> DEGRADED with code, never throws', async () => {
  const r = await runSource(fakeFeed({ search: async () => { throw new HttpError(502, 'FEED_UPSTREAM', 'x'); } }), Q, null, deps([]));
  assert.deepEqual([r.mode, r.error], ['DEGRADED', 'FEED_UPSTREAM']);
  const t = await runSource(fakeFeed({ search: async () => { throw new TypeError('boom'); } }), Q, null, deps([]));
  assert.equal(t.error, 'FEED_UPSTREAM');
});

test('runSource: freshMs keeps a 2 h old copy as a HIT with no live call and no quota spent', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const d = deps([], baseEnv({ CACHE: kv }));
  await writeFeedCache(kv, await feedCacheKey('fake', Q), { fetchedAtMs: FIXED_NOW_MS - 2 * 3600_000, offers: [offer(900)] }, 6 * 3600_000);
  const slow = fakeFeed({ freshMs: 24 * 3600_000 });
  const r = await runSource(slow, Q, null, d);
  assert.deepEqual([r.mode, r.cache, r.offers[0].priceCents, slow.calls.n], ['REAL', 'HIT', 900, 0]);
  const normal = fakeFeed();
  assert.equal((await runSource(normal, Q, null, d)).cache, 'MISS');
});

test('runSource: monthly cap stops live calls without burning a daily slot; the count spans days', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const d = deps([], baseEnv({ CACHE: kv }));
  const capped = fakeFeed({ monthlyBudget: () => 2 });
  assert.equal((await runSource(capped, { ...Q, query: 'a' }, null, d)).quotaRemaining, 1);
  assert.equal((await runSource(capped, { ...Q, query: 'b' }, null, d)).quotaRemaining, 0);
  const third = await runSource(capped, { ...Q, query: 'c' }, null, d);
  assert.deepEqual([third.mode, third.error, capped.calls.n], ['DEGRADED', 'quota_exhausted', 2]);
  assert.equal(await kv.get(quotaKey('fake', FIXED_NOW_MS)), '2');
  assert.equal(await kv.get(monthlyQuotaKey('fake', FIXED_NOW_MS)), '2');
});

test('runSource: KV failures degrade instead of throwing; counters failing closed means no live call', async () => {
  const broken = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } };
  const feed = fakeFeed();
  const r = await runSource(feed, Q, null, deps([], baseEnv({ CACHE: broken })));
  assert.deepEqual([r.mode, r.error, r.offers.length, feed.calls.n], ['DEGRADED', 'quota_unavailable', 0, 0]);
  // quota reads fine but the cache write fails: the live result is still returned
  const kv = memKV(() => FIXED_NOW_MS);
  const putFails = { get: kv.get.bind(kv), put: async (k: string, v: string, o?: unknown) => { if (k.startsWith('feed:')) throw new Error('kv down'); return kv.put(k, v, o as any); } };
  const ok = await runSource(fakeFeed(), Q, null, deps([], baseEnv({ CACHE: putFails })));
  assert.deepEqual([ok.mode, ok.cache, ok.offers.length], ['REAL', 'MISS', 1]);
});

test('runCompare: one failing source does not fail the call; single_source flagged', async () => {
  const ok = fakeFeed({ id: 'a' });
  const bad = fakeFeed({ id: 'b', search: async () => { throw new TypeError('down'); } });
  const { result } = await runCompare(Q, null, deps([ok, bad]));
  assert.deepEqual(result.sources.map((s) => [s.id, s.mode, s.bestCents]), [['a', 'REAL', 1000], ['b', 'DEGRADED', null]]);
  assert.ok(result.flags.includes('single_source'));
});

test('runCompare with no credentials at all: every registered source is MOCK, spread basis MOCK', async () => {
  const { result } = await runCompare(Q, null, deps(FEEDS));
  assert.deepEqual(result.sources.map((s) => s.mode), ['MOCK', 'MOCK', 'MOCK']);
  assert.ok(result.flags.includes('all_mock'));
  assert.equal(result.spread?.basis, 'MOCK');
});

// A SerpApi-shaped source: fresh for 24 h, and a cached copy is never shown past 24 h.
const serpShaped = (over: Partial<PriceFeed> = {}) => fakeFeed({ freshMs: 24 * 3600_000, maxStaleMs: 24 * 3600_000, ...over });

test('runSource: a 25 h old entry for a 24 h/24 h source with quota exhausted -> NONE, no offers', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const d = deps([], baseEnv({ CACHE: kv }));
  await kv.put(quotaKey('fake', FIXED_NOW_MS), '5');
  await writeFeedCache(kv, await feedCacheKey('fake', Q), { fetchedAtMs: FIXED_NOW_MS - 25 * 3600_000, offers: [offer(900)] }, 24 * 3600_000);
  const r = await runSource(serpShaped(), Q, null, d);
  assert.deepEqual([r.mode, r.cache, r.error, r.offers.length], ['DEGRADED', 'NONE', 'quota_exhausted', 0]);
});

test('runSource: live failure with a usable cached copy (older than fresh, within maxStaleMs) -> DEGRADED/STALE with those offers', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const d = deps([], baseEnv({ CACHE: kv }));
  await writeFeedCache(kv, await feedCacheKey('fake', Q), { fetchedAtMs: FIXED_NOW_MS - FRESH_MS - 1, offers: [offer(900)] }, 6 * 3600_000);
  const feed = fakeFeed({ search: async () => { throw new HttpError(502, 'FEED_UPSTREAM', 'x'); } });
  const r = await runSource(feed, Q, null, d);
  assert.deepEqual([r.mode, r.cache, r.error, r.offers.map((o) => o.priceCents)], ['DEGRADED', 'STALE', 'FEED_UPSTREAM', [900]]);
});

test('runSource: a cache entry stamped in the future is neither fresh nor usable as stale (treated as no cache)', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const d = deps([], baseEnv({ CACHE: kv }));
  await writeFeedCache(kv, await feedCacheKey('fake', Q), { fetchedAtMs: FIXED_NOW_MS + 3600_000, offers: [offer(900)] }, 6 * 3600_000);
  const live = fakeFeed();
  const r = await runSource(live, Q, null, d);
  assert.deepEqual([r.cache, r.offers[0].priceCents, live.calls.n], ['MISS', 1000, 1]);
  // and when the live call also fails, the future entry is not served as stale
  const kv2 = memKV(() => FIXED_NOW_MS);
  await writeFeedCache(kv2, await feedCacheKey('fake', Q), { fetchedAtMs: FIXED_NOW_MS + 3600_000, offers: [offer(900)] }, 6 * 3600_000);
  const failing = fakeFeed({ search: async () => { throw new HttpError(502, 'FEED_UPSTREAM', 'x'); } });
  const f = await runSource(failing, Q, null, deps([], baseEnv({ CACHE: kv2 })));
  assert.deepEqual([f.mode, f.cache, f.offers.length], ['DEGRADED', 'NONE', 0]);
});

// KV that reads fine but rejects every counter write.
const quotaPutFails = (kv = memKV(() => FIXED_NOW_MS)) => ({
  get: kv.get.bind(kv),
  put: async (k: string, v: string, o?: unknown) => { if (k.startsWith('quota:')) throw new Error('kv down'); return kv.put(k, v, o as any); },
});

test('runSource: quota READ failure fails closed even for sources without a monthly cap', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const readFails = { get: async (k: string) => { if (k.startsWith('quota:')) throw new Error('kv down'); return kv.get(k); }, put: kv.put.bind(kv) };
  const feed = fakeFeed();
  const r = await runSource(feed, Q, null, deps([], baseEnv({ CACHE: readFails })));
  assert.deepEqual([r.mode, r.error, feed.calls.n], ['DEGRADED', 'quota_unavailable', 0]);
});

test('runSource: counter WRITE failure -> call allowed without a monthly cap, fails closed with one', async () => {
  const plain = fakeFeed();
  const ok = await runSource(plain, Q, null, deps([], baseEnv({ CACHE: quotaPutFails() })));
  assert.deepEqual([ok.mode, ok.cache, ok.offers.length, plain.calls.n, ok.quotaRemaining], ['REAL', 'MISS', 1, 1, 4]);
  const capped = serpShaped({ monthlyBudget: () => 240 });
  const closed = await runSource(capped, Q, null, deps([], baseEnv({ CACHE: quotaPutFails() })));
  assert.deepEqual([closed.mode, closed.error, capped.calls.n], ['DEGRADED', 'quota_unavailable', 0]);
});

test('runCompare (real registry): counter writes failing -> eBay and Best Buy served, SerpApi quota_unavailable', async () => {
  const fx = (n: string) => readFileSync(new URL('./fixtures/feeds/' + n, import.meta.url), 'utf8');
  const hosts: string[] = [];
  const fetchFn = (async (input: any) => {
    const url = String(input?.url ?? input);
    hosts.push(new URL(url).host);
    if (url.includes('/oauth2/token')) return new Response(fx('ebay-token.json'), { status: 200 });
    if (url.includes('ebay')) return new Response(fx('ebay-search.json'), { status: 200 });
    if (url.includes('bestbuy')) return new Response(fx('bestbuy-upc.json'), { status: 200 });
    throw new Error('unexpected ' + url);
  }) as any;
  const env = baseEnv({ CACHE: quotaPutFails(), EBAY_API_BASE: 'https://api.ebay.com', EBAY_CLIENT_ID: 'c', EBAY_CLIENT_SECRET: 's', BESTBUY_API_KEY: 'k', SERPAPI_KEY: 'sk' });
  const { runs } = await runCompare(Q, null, { env: env as any, fetch: fetchFn, nowMs: FIXED_NOW_MS, feeds: FEEDS });
  assert.deepEqual(runs.map((r) => [r.id, r.mode, r.error]), [['ebay', 'REAL', null], ['bestbuy', 'REAL', null], ['serpapi', 'DEGRADED', 'quota_unavailable']]);
  assert.ok(!hosts.includes('serpapi.com'));
});

// backup source (SerpApi -> SearchApi.io): a scarce credit is spent only when SerpApi truly cannot serve
const withBackup = (backup: PriceFeed, over: Partial<PriceFeed> = {}) => fakeFeed({ fallback: backup, ...over });
const backupFeed = (over: Partial<PriceFeed> & { calls?: { n: number } } = {}) => fakeFeed({ id: 'backup', label: 'Backup', attribution: 'Backup', ...over });
// Primary whose monthly plan is used up (what "SerpApi is out" means), with a quiet daily counter.
const monthOut = async (kv: ReturnType<typeof memKV>) => { await kv.put(monthlyQuotaKey('fake', FIXED_NOW_MS), '1'); };

test('registry: SerpApi carries SearchApi.io as its backup, not as a fourth source', () => {
  assert.equal(FEEDS.find((f) => f.id === 'serpapi')?.fallback?.id, 'searchapi');
  assert.equal(FEEDS.length, 3);
});

test('backup: primary monthly plan exhausted is an app-side brake, not an outage: no backup, the primary result stays', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  await monthOut(kv);
  const backup = backupFeed();
  const r = await runSource(withBackup(backup, { monthlyBudget: () => 1 }), Q, null, deps([], baseEnv({ CACHE: kv })));
  assert.deepEqual([r.id, r.mode, r.cache, r.error, r.offers.length, backup.calls.n], ['fake', 'DEGRADED', 'NONE', 'quota_exhausted', 0, 0]);
  assert.equal('fallbackFor' in r, false);
  assert.equal(await kv.get(totalQuotaKey('backup')), null); // and no backup counter was touched
});

test('backup: primary quota_unavailable (counter unreadable) never triggers the backup either', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const readFails = { get: async (k: string) => { if (k === quotaKey('fake', FIXED_NOW_MS)) throw new Error('kv down'); return kv.get(k); }, put: kv.put.bind(kv) };
  const backup = backupFeed();
  const r = await runSource(withBackup(backup), Q, null, deps([], baseEnv({ CACHE: readFails })));
  assert.deepEqual([r.id, r.mode, r.error, backup.calls.n], ['fake', 'DEGRADED', 'quota_unavailable', 0]);
  const capped = backupFeed();
  const w = await runSource(withBackup(capped, { monthlyBudget: () => 240 }), Q, null, deps([], baseEnv({ CACHE: quotaPutFails() })));
  assert.deepEqual([w.id, w.error, capped.calls.n], ['fake', 'quota_unavailable', 0]);
});

test('backup: the primary\'s own DAILY brake alone never triggers the backup (that would bypass the rationing)', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  await kv.put(quotaKey('fake', FIXED_NOW_MS), '5');
  const backup = backupFeed();
  const capped = await runSource(withBackup(backup, { monthlyBudget: () => 240 }), Q, null, deps([], baseEnv({ CACHE: kv })));
  assert.deepEqual([capped.id, capped.mode, capped.error, backup.calls.n], ['fake', 'DEGRADED', 'quota_exhausted', 0]);
  const noMonthly = await runSource(withBackup(backup), Q, null, deps([], baseEnv({ CACHE: kv })));
  assert.deepEqual([noMonthly.id, noMonthly.error, backup.calls.n], ['fake', 'quota_exhausted', 0]);
});

test('backup: a STALE primary copy is preferred; no backup credit is spent', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  await monthOut(kv);
  await writeFeedCache(kv, await feedCacheKey('fake', Q), { fetchedAtMs: FIXED_NOW_MS - FRESH_MS - 1, offers: [offer(900)] }, 6 * 3600_000);
  const backup = backupFeed();
  const r = await runSource(withBackup(backup, { monthlyBudget: () => 1 }), Q, null, deps([], baseEnv({ CACHE: kv })));
  assert.deepEqual([r.id, r.mode, r.cache, backup.calls.n], ['fake', 'DEGRADED', 'STALE', 0]);
});

test('backup: never called while the primary is healthy (REAL MISS or HIT)', async () => {
  const d = deps([]);
  const backup = backupFeed();
  const feed = withBackup(backup);
  assert.equal((await runSource(feed, Q, null, d)).cache, 'MISS');
  assert.equal((await runSource(feed, Q, null, d)).cache, 'HIT');
  assert.equal(backup.calls.n, 0);
});

test('backup: primary upstream failure with no cache -> backup answers; unconfigured or failing backup leaves the primary result', async () => {
  const down = { search: async () => { throw new HttpError(502, 'FEED_UPSTREAM', 'x'); } };
  const ok = backupFeed();
  const viaBackup = await runSource(withBackup(ok, down), Q, null, deps([]));
  assert.deepEqual([viaBackup.id, viaBackup.mode, ok.calls.n], ['backup', 'REAL', 1]);
  // the primary's failure does not vanish: the answer says whom it stands in for and why
  assert.deepEqual([viaBackup.fallbackFor, viaBackup.primaryError], ['fake', 'FEED_UPSTREAM']);
  const afterTimeout = backupFeed();
  const t = await runSource(withBackup(afterTimeout, { search: async () => { throw new DOMException('aborted', 'TimeoutError'); } }), Q, null, deps([]));
  assert.deepEqual([t.id, t.fallbackFor, t.primaryError, afterTimeout.calls.n], ['backup', 'fake', 'FEED_UPSTREAM', 1]);
  const off = backupFeed({ configured: () => false });
  const noKey = await runSource(withBackup(off, down), Q, null, deps([]));
  assert.deepEqual([noKey.id, noKey.mode, noKey.error, off.calls.n], ['fake', 'DEGRADED', 'FEED_UPSTREAM', 0]);
  assert.equal('fallbackFor' in noKey, false);
  const bad = backupFeed({ search: async () => { throw new TypeError('also down'); } });
  const both = await runSource(withBackup(bad, down), Q, null, deps([]));
  assert.deepEqual([both.id, both.mode, both.error], ['fake', 'DEGRADED', 'FEED_UPSTREAM']);
});

test('backup: its lifetime cap still applies (one credit per distinct query, then the primary result is returned)', async () => {
  const down = { search: async () => { throw new HttpError(502, 'FEED_UPSTREAM', 'x'); } };
  const backup = backupFeed({ totalBudget: () => 1 });
  const feed = withBackup(backup, down);
  const d = deps([]);
  assert.equal((await runSource(feed, { ...Q, query: 'a' }, null, d)).id, 'backup');
  const second = await runSource(feed, { ...Q, query: 'b' }, null, d);
  assert.deepEqual([second.id, second.mode, second.error, backup.calls.n], ['fake', 'DEGRADED', 'FEED_UPSTREAM', 1]);
});

test('runSource: lifetime cap stops live calls for good and is reflected in quotaRemaining', async () => {
  const feed = fakeFeed({ totalBudget: () => 2 });
  const d = deps([]);
  assert.equal((await runSource(feed, { ...Q, query: 'a' }, null, d)).quotaRemaining, 1);
  assert.equal((await runSource(feed, { ...Q, query: 'b' }, null, d)).quotaRemaining, 0);
  const third = await runSource(feed, { ...Q, query: 'c' }, null, d);
  assert.deepEqual([third.mode, third.error, feed.calls.n], ['DEGRADED', 'quota_exhausted', 2]);
});

// real registry: SerpApi down (503), SearchApi.io answers
const SEARCHAPI_BODY = readFileSync(new URL('./fixtures/feeds/searchapi-shopping.json', import.meta.url), 'utf8');
const SERPAPI_BODY = readFileSync(new URL('./fixtures/feeds/serpapi-shopping.json', import.meta.url), 'utf8');
const T0 = FIXED_NOW_MS;
type Hit = { url: string; authorization: string | null };
function backupNet(opts: { serp?: number; serpOk?: boolean } = {}) {
  const hits: Hit[] = [];
  const fetchFn = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const authorization = new Headers(init?.headers ?? {}).get('authorization');
    hits.push({ url, authorization });
    if (url.includes('serpapi.com')) return opts.serpOk ? new Response(SERPAPI_BODY, { status: 200 }) : new Response('{"error":"boom"}', { status: opts.serp ?? 503 });
    if (url.includes('searchapi.io')) return new Response(SEARCHAPI_BODY, { status: 200 });
    throw new Error('unexpected ' + url);
  }) as any;
  return { fetch: fetchFn, hits, searchapi: () => hits.filter((h) => h.url.includes('searchapi.io')), serpapi: () => hits.filter((h) => h.url.includes('serpapi.com')) };
}
const realEnv = (kv: unknown, over: Record<string, unknown> = {}) => baseEnv({ CACHE: kv, SERPAPI_KEY: 'serp-secret', SEARCH_API_KEY: 'sak-secret', ...over });
const compareAt = (env: unknown, net: { fetch: any }, nowMs = T0) => runCompare(Q, null, { env: env as any, fetch: net.fetch, nowMs, feeds: FEEDS });

test('runCompare (real registry): SerpApi 503 -> SearchApi.io answers with a Bearer header, no key in the URL, provenance, 3 sources', async () => {
  const kv = memKV(() => T0);
  const net = backupNet();
  const { result, runs } = await compareAt(realEnv(kv), net);
  assert.deepEqual(runs.map((r) => [r.id, r.mode]), [['ebay', 'MOCK'], ['bestbuy', 'MOCK'], ['searchapi', 'REAL']]);
  assert.deepEqual([runs[2].cache, runs[2].error, runs[2].fallbackFor, runs[2].primaryError], ['MISS', null, 'serpapi', 'FEED_UPSTREAM']);
  assert.equal(result.sources.length, 3);
  assert.deepEqual(result.sources.map((s) => s.id), ['ebay', 'bestbuy', 'searchapi']);
  assert.deepEqual([result.sources[2].fallbackFor, result.sources[2].primaryError, result.sources[2].mode], ['serpapi', 'FEED_UPSTREAM', 'REAL']);
  assert.equal(result.sources[0].fallbackFor, undefined);
  // exactly one call to each host; the SearchApi key is a Bearer header and appears nowhere in the URL
  assert.equal(net.serpapi().length, 1);
  assert.equal(net.searchapi().length, 1);
  const sa = net.searchapi()[0];
  assert.equal(sa.authorization, 'Bearer sak-secret');
  assert.equal(sa.url.includes('sak-secret'), false);
  assert.equal(sa.url.includes('api_key'), false);
  assert.equal(new URL(sa.url).origin + new URL(sa.url).pathname, 'https://www.searchapi.io/api/v1/search');
  // quota counters: a per-day key and a TTL-less lifetime key (no monthly counter for SearchApi); SerpApi was charged too
  assert.equal(await kv.get('quota:v1:searchapi:2026-10-02'), '1');
  assert.equal(await kv.get('quota:v1t:searchapi'), '1');
  assert.deepEqual([...kv.store.keys()].filter((k) => k.startsWith('quota:') && k.includes('searchapi')).sort(), ['quota:v1:searchapi:2026-10-02', 'quota:v1t:searchapi']);
  assert.deepEqual(kv.puts.filter((p) => p.key === 'quota:v1t:searchapi').map((p) => p.ttl), [undefined]);
  assert.equal(await kv.get('quota:v1:serpapi:2026-10-02'), '1');
  assert.equal(await kv.get('quota:v1m:serpapi:2026-10'), '1');
  assert.equal(runs[2].quotaRemaining, 2); // min(3/day - 1, 90 total - 1)
});

test('runCompare (real registry): the backup answer is a 24 h cache: HIT just under 24 h, MISS after, never a free week-old price', async () => {
  const kv = memKV(() => T0);
  const net = backupNet();
  const env = realEnv(kv);
  const first = (await compareAt(env, net)).runs[2];
  assert.deepEqual([first.cache, first.mode], ['MISS', 'REAL']);
  const justUnder = (await compareAt(env, net, T0 + 24 * 3600_000 - 1)).runs[2];
  assert.deepEqual([justUnder.id, justUnder.mode, justUnder.cache, justUnder.fallbackFor, justUnder.primaryError], ['searchapi', 'REAL', 'HIT', 'serpapi', 'FEED_UPSTREAM']);
  assert.equal(net.searchapi().length, 1);
  assert.equal(await kv.get('quota:v1t:searchapi'), '1'); // a HIT spends no credit
  const after = (await compareAt(env, net, T0 + 24 * 3600_000 + 1)).runs[2];
  assert.deepEqual([after.id, after.mode, after.cache], ['searchapi', 'REAL', 'MISS']);
  assert.equal(net.searchapi().length, 2);
  assert.equal(await kv.get('quota:v1t:searchapi'), '2');
});

test('runCompare (real registry): a backup counter WRITE failure fails closed (no SearchApi call); the primary failure stays visible', async () => {
  const kv = memKV(() => T0);
  const writeFails = { get: kv.get.bind(kv), put: async (k: string, v: string, o?: unknown) => { if (k === 'quota:v1t:searchapi') throw new Error('kv down'); return kv.put(k, v, o as any); } };
  const net = backupNet();
  const { runs } = await compareAt(realEnv(writeFails), net);
  assert.deepEqual([runs[2].id, runs[2].mode, runs[2].error, runs[2].fallbackFor], ['serpapi', 'DEGRADED', 'FEED_UPSTREAM', undefined]);
  assert.equal(net.searchapi().length, 0);
  assert.equal(await kv.get('quota:v1t:searchapi'), null);
});

test('runCompare (real registry): a backup counter READ failure also fails closed', async () => {
  const kv = memKV(() => T0);
  const readFails = { get: async (k: string) => { if (k === 'quota:v1t:searchapi') throw new Error('kv down'); return kv.get(k); }, put: kv.put.bind(kv) };
  const net = backupNet();
  const { runs } = await compareAt(realEnv(readFails), net);
  assert.deepEqual([runs[2].id, runs[2].error], ['serpapi', 'FEED_UPSTREAM']);
  assert.equal(net.searchapi().length, 0);
});

test('runCompare (real registry): the 90 credits are for the whole plan: the cap holds across a month boundary', async () => {
  const kv = memKV(() => T0);
  await kv.put('quota:v1t:searchapi', '89');
  const net = backupNet();
  const env = realEnv(kv);
  const oct = Date.UTC(2026, 9, 31, 12);
  const nov = Date.UTC(2026, 10, 1, 12);
  const a = (await runCompare({ ...Q, query: 'case a' }, null, { env: env as any, fetch: net.fetch, nowMs: oct, feeds: FEEDS })).runs[2];
  assert.deepEqual([a.id, a.mode, a.quotaRemaining], ['searchapi', 'REAL', 0]);
  const b = (await runCompare({ ...Q, query: 'case b' }, null, { env: env as any, fetch: net.fetch, nowMs: nov, feeds: FEEDS })).runs[2];
  assert.deepEqual([b.id, b.error], ['serpapi', 'FEED_UPSTREAM']);
  assert.equal(net.searchapi().length, 1);
  assert.equal(await kv.get('quota:v1t:searchapi'), '90');
});

test('runCompare (real registry): SerpApi\'s own brakes (daily 0, monthly used up) never reach SearchApi.io', async () => {
  for (const over of [{ QUOTA_SERPAPI_DAILY: '0' }, { QUOTA_SERPAPI_MONTHLY: '0' }]) {
    const kv = memKV(() => T0);
    const net = backupNet();
    const { runs } = await compareAt(realEnv(kv, over), net);
    assert.deepEqual([runs[2].id, runs[2].mode, runs[2].error, runs[2].fallbackFor], ['serpapi', 'DEGRADED', 'quota_exhausted', undefined]);
    assert.equal(net.hits.length, 0);
    assert.equal(await kv.get('quota:v1t:searchapi'), null);
  }
});

test('runCompare (real registry): without SEARCH_API_KEY a SerpApi outage stays the primary result and calls nothing else', async () => {
  const net = backupNet();
  const { runs } = await compareAt(realEnv(memKV(() => T0), { SEARCH_API_KEY: undefined }), net);
  assert.deepEqual([runs[2].id, runs[2].error], ['serpapi', 'FEED_UPSTREAM']);
  assert.equal(net.searchapi().length, 0);
});

// paid sources: a non-operator run may only read the cache; anonymous visitors must not spend the paid plans
test('paid flag: SerpApi and its SearchApi.io backup are paid; eBay and Best Buy are not', () => {
  assert.deepEqual(FEEDS.map((f) => [f.id, f.paid === true]), [['ebay', false], ['bestbuy', false], ['serpapi', true]]);
  assert.equal(FEEDS.find((f) => f.id === 'serpapi')?.fallback?.paid, true);
});

const serpFeed = FEEDS.find((f) => f.id === 'serpapi') as PriceFeed;
const serpCacheAt = async (kv: ReturnType<typeof memKV>, fetchedAtMs: number) => {
  await writeFeedCache(kv, await feedCacheKey('serpapi', Q), { fetchedAtMs, offers: [offer(1099)] }, 24 * 3600_000);
};

test('allowPaid:false, paid feed, cache miss: REAL/NONE, no offers, refresh_requires_operator, zero calls, no counter written', async () => {
  const kv = memKV(() => T0);
  const net = backupNet();
  const run = await runSource(serpFeed, Q, null, { env: realEnv(kv) as any, fetch: net.fetch, nowMs: T0, feeds: [serpFeed], allowPaid: false });
  assert.deepEqual([run.id, run.mode, run.cache, run.offers.length, run.error, run.configured, run.fallbackFor], ['serpapi', 'REAL', 'NONE', 0, 'refresh_requires_operator', true, undefined]);
  assert.equal(net.hits.length, 0);
  assert.deepEqual(kv.puts, []);
  assert.equal(await kv.get(quotaKey('serpapi', T0)), null);
  assert.equal(await kv.get(monthlyQuotaKey('serpapi', T0)), null);
  assert.equal(await kv.get(totalQuotaKey('searchapi')), null);
});

test('allowPaid:false, paid feed, fresh cache: HIT from KV with zero calls and zero writes', async () => {
  const kv = memKV(() => T0);
  await serpCacheAt(kv, T0 - 3 * 3600_000);
  const putsBefore = kv.puts.length;
  const net = backupNet();
  const run = await runSource(serpFeed, Q, null, { env: realEnv(kv) as any, fetch: net.fetch, nowMs: T0, feeds: [serpFeed], allowPaid: false });
  assert.deepEqual([run.mode, run.cache, run.offers.length, run.error], ['REAL', 'HIT', 1, null]);
  assert.equal(net.hits.length, 0);
  assert.equal(kv.puts.length, putsBefore);
});

test('allowPaid:false, paid feed with only a usable STALE copy: serves it as DEGRADED/STALE, still zero calls', async () => {
  const kv = memKV(() => T0);
  await writeFeedCache(kv, await feedCacheKey('fake', Q), { fetchedAtMs: T0 - 2 * 3600_000, offers: [offer(1234)] }, 6 * 3600_000);
  const feed = fakeFeed({ paid: true, freshMs: 3600_000 });
  const run = await runSource(feed, Q, null, { ...deps([feed], baseEnv({ CACHE: kv })), allowPaid: false });
  assert.deepEqual([run.mode, run.cache, run.offers.length, run.error, feed.calls.n], ['DEGRADED', 'STALE', 1, 'refresh_requires_operator', 0]);
});

test('allowPaid:false never stops an unpaid feed (eBay/Best Buy behaviour unchanged)', async () => {
  const feed = fakeFeed();
  const run = await runSource(feed, Q, null, { ...deps([feed]), allowPaid: false });
  assert.deepEqual([run.mode, run.cache, run.error, feed.calls.n], ['REAL', 'MISS', null, 1]);
});

test('allowPaid:false never triggers the SearchApi.io fallback, even when the primary would have failed upstream', async () => {
  const kv = memKV(() => T0);
  const net = backupNet();
  const { runs } = await runCompare(Q, null, { env: realEnv(kv) as any, fetch: net.fetch, nowMs: T0, feeds: FEEDS, allowPaid: false });
  assert.deepEqual([runs[2].id, runs[2].error, runs[2].fallbackFor], ['serpapi', 'refresh_requires_operator', undefined]);
  assert.equal(net.hits.length, 0);
  assert.equal(await kv.get(totalQuotaKey('searchapi')), null);
});

test('allowPaid omitted/true keeps today\'s behaviour: one paid call on a miss, counters incremented once', async () => {
  const kv = memKV(() => T0);
  const net = backupNet({ serpOk: true });
  const run = await runSource(serpFeed, Q, null, { env: realEnv(kv) as any, fetch: net.fetch, nowMs: T0, feeds: [serpFeed], allowPaid: true });
  assert.deepEqual([run.cache, run.error, net.serpapi().length], ['MISS', null, 1]);
  assert.equal(await kv.get(quotaKey('serpapi', T0)), '1');
  assert.equal(await kv.get(monthlyQuotaKey('serpapi', T0)), '1');
});

test('refreshAfterMs: a cached copy older than the threshold is refreshed (one paid call), a younger one is still a HIT', async () => {
  const H = 3600_000;
  const old = memKV(() => T0);
  await serpCacheAt(old, T0 - 13 * H);
  const netOld = backupNet({ serpOk: true });
  const a = await runSource(serpFeed, Q, null, { env: realEnv(old) as any, fetch: netOld.fetch, nowMs: T0, feeds: [serpFeed], refreshAfterMs: 12 * H });
  assert.equal(netOld.serpapi().length, 1);
  assert.deepEqual([a.cache, a.error], ['MISS', null]);
  const young = memKV(() => T0);
  await serpCacheAt(young, T0 - 11 * H);
  const netYoung = backupNet({ serpOk: true });
  const b = await runSource(serpFeed, Q, null, { env: realEnv(young) as any, fetch: netYoung.fetch, nowMs: T0, feeds: [serpFeed], refreshAfterMs: 12 * H });
  assert.deepEqual([b.cache, netYoung.hits.length], ['HIT', 0]);
});
