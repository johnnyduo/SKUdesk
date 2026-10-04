import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HERO_SKU, RECONCILE_BATCH, WARM_REFRESH_AFTER_MS, handleScheduled, runCron, warmHeroPrice } from '../cron.ts';
import { feedCacheKey, readFeedCache, writeFeedCache } from '../feeds/cache.ts';
import { monthlyQuotaKey, quotaKey } from '../feeds/quota.ts';
import { getListing, insertObservations, listDueForReconcile, saveListing } from '../db/listings.ts';
import type { NewListing } from '../db/listings.ts';
import { FIXED_NOW_MS, baseEnv, fakeAssets, jsonResponse, memKV, scriptedFetch, testDeps } from './helpers/fakes.ts';
import { sqliteD1 } from './helpers/d1.ts';
import { throwawayServiceAccount } from './helpers/keys.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/merchant/' + name, import.meta.url), 'utf8'));
const MIN = 60_000;
const row = (offer_id: string, status: NewListing['status'] = 'SUBMITTED'): NewListing => ({ offer_id, lot_id: offer_id, product_name: 'n', status, issues_json: null, price_micros: 10_990_000, currency: 'USD', payload_hash: 'h' });

test('cron without merchant secrets: no upstream calls, still purges old observations', async () => {
  const db = sqliteD1();
  await insertObservations(db as any, [{ source: 'ebay', gtin: null, query: 'q', price_cents: 1, currency: 'USD', locked: 0, title: null, url: null, observed_at: FIXED_NOW_MS - 31 * 24 * 60 * MIN }]);
  await saveListing(db as any, row('A'), FIXED_NOW_MS - 10 * MIN);
  const net = scriptedFetch([]);
  const s = await runCron(baseEnv({ DB: db }) as any, testDeps({ fetch: net.fetch }) as any);
  assert.deepEqual(s, { checked: 0, updated: 0, errors: 0, purged: 1, merchantConfigured: false });
  assert.equal(net.calls.length, 0);
});

test('cron reconciles due rows, counts status changes and errors, leaves fresh/final rows alone', async () => {
  const { saJson } = await throwawayServiceAccount();
  const db = sqliteD1();
  const env = baseEnv({ DB: db, GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: '123', MERCHANT_DATA_SOURCE_ID: '456' });
  await saveListing(db as any, row('A'), FIXED_NOW_MS - 10 * MIN);
  await saveListing(db as any, row('B'), FIXED_NOW_MS - 9 * MIN);
  await saveListing(db as any, row('C', 'APPROVED'), FIXED_NOW_MS - 10 * MIN);
  await saveListing(db as any, row('D'), FIXED_NOW_MS - 1 * MIN);
  const boom = () => { throw new TypeError('down'); };
  const net = scriptedFetch([
    () => jsonResponse({ access_token: 'ya29.t', expires_in: 3599 }),
    () => jsonResponse(fx('product-disapproved.json')),
    boom, boom, boom, boom,
  ]);
  const s = await runCron(env as any, testDeps({ fetch: net.fetch }) as any);
  assert.deepEqual(s, { checked: 2, updated: 1, errors: 1, purged: 0, merchantConfigured: true });
  assert.equal((await getListing(db as any, 'A'))?.status, 'DISAPPROVED');
  assert.equal((await getListing(db as any, 'B'))?.status, 'SUBMITTED');
  assert.equal((await getListing(db as any, 'D'))?.last_checked_at, null);
  assert.equal(net.calls.length, 6); // token + A + B (initial try and 3 retries)
});

test('cron purge still runs when reconcile fails, and reconcile failure does not throw', async () => {
  const { saJson } = await throwawayServiceAccount();
  const db = sqliteD1();
  const env = baseEnv({ DB: db, GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: '123', MERCHANT_DATA_SOURCE_ID: '456' });
  await insertObservations(db as any, [{ source: 'ebay', gtin: null, query: 'q', price_cents: 1, currency: 'USD', locked: 0, title: null, url: null, observed_at: FIXED_NOW_MS - 7 * 60 * MIN }]);
  await saveListing(db as any, row('A'), FIXED_NOW_MS - 10 * MIN);
  const realPrepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    if (sql.includes('FROM merchant_listings')) throw new Error('db down https://secret.example/?token=abc');
    return realPrepare(sql);
  };
  const s = await runCron(env as any, testDeps() as any);
  assert.equal(s.purged, 1);
  assert.equal(s.errors, 1);
});

test('cron reconcile failure and purge failure are isolated; handleScheduled never throws or leaks error text', async () => {
  const db = sqliteD1();
  const env = baseEnv({ DB: db });
  (db as any).prepare = () => { throw new Error('db down https://secret.example/?token=abc'); };
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    await handleScheduled({ cron: '*/15 * * * *' }, env as any, testDeps() as any);
  } finally {
    console.log = orig;
  }
  const out = lines.join('\n');
  assert.ok(out.includes('"event":"cron"'));
  assert.ok(!out.includes('secret.example'));
  assert.ok(!out.includes('token=abc'));
});

test('cron reads at most RECONCILE_BATCH rows per run', async () => {
  const { saJson } = await throwawayServiceAccount();
  const db = sqliteD1();
  const env = baseEnv({ DB: db, GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: '123', MERCHANT_DATA_SOURCE_ID: '456' });
  for (let i = 0; i < RECONCILE_BATCH + 5; i++) await saveListing(db as any, row('O' + i), FIXED_NOW_MS - 10 * MIN);
  const script = [() => jsonResponse({ access_token: 'ya29.t', expires_in: 3599 }), ...Array.from({ length: RECONCILE_BATCH + 5 }, () => () => jsonResponse(fx('product-disapproved.json')))];
  const net = scriptedFetch(script);
  const s = await runCron(env as any, testDeps({ fetch: net.fetch }) as any);
  assert.equal(RECONCILE_BATCH, 25);
  assert.equal(s.checked, 25);
  assert.equal(net.calls.length, 26); // 1 token exchange + 25 product reads
});

const liveEnv = async (db: unknown) => {
  const { saJson } = await throwawayServiceAccount();
  return baseEnv({ DB: db, GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: '123', MERCHANT_DATA_SOURCE_ID: '456' });
};
const tokenOk = () => jsonResponse({ access_token: 'ya29.t', expires_in: 3599 });

test('cron: a row-specific error bumps last_checked_at; the failing row is not re-read within the retry spacing and does not starve others', async () => {
  const db = sqliteD1();
  const env = await liveEnv(db);
  await saveListing(db as any, row('BAD'), FIXED_NOW_MS - 20 * MIN);
  await saveListing(db as any, row('GOOD'), FIXED_NOW_MS - 10 * MIN);
  const net = scriptedFetch([tokenOk, () => jsonResponse({ error: { message: 'x' } }, 400), () => jsonResponse(fx('product-disapproved.json'))]);
  const deps = testDeps({ fetch: net.fetch });
  const s = await runCron(env as any, deps as any);
  assert.deepEqual([s.checked, s.errors, s.updated], [2, 1, 1]);
  assert.equal(net.calls.length, 3);
  assert.equal((await getListing(db as any, 'BAD'))?.last_checked_at, FIXED_NOW_MS);
  assert.equal((await getListing(db as any, 'BAD'))?.status, 'SUBMITTED');
  // Same instant: nothing is due any more (BAD was just checked, GOOD is final), so no further upstream calls.
  const again = await runCron(env as any, deps as any);
  assert.equal(again.checked, 0);
  assert.equal(net.calls.length, 3);
});

test('cron: a global error code (401 twice) stops the batch after the first row', async () => {
  const db = sqliteD1();
  const env = await liveEnv(db);
  for (const id of ['A', 'B', 'C']) await saveListing(db as any, row(id), FIXED_NOW_MS - 10 * MIN);
  const e401 = () => jsonResponse(fx('error-401.json'), 401);
  const net = scriptedFetch([tokenOk, e401, tokenOk, e401]);
  const s = await runCron(env as any, testDeps({ fetch: net.fetch }) as any);
  assert.deepEqual([s.checked, s.errors], [1, 1]);
  assert.equal(net.calls.length, 4); // token, GET 401, forced token, GET 401 - rows B and C never read
  assert.equal((await getListing(db as any, 'B'))?.last_checked_at, null);
});

test('cron: a re-published old listing (created_at > 48 h ago, updated_at recent) is reconciled', async () => {
  const db = sqliteD1();
  const env = await liveEnv(db);
  await saveListing(db as any, row('OLD'), FIXED_NOW_MS - 60 * 60 * MIN);
  await saveListing(db as any, row('OLD'), FIXED_NOW_MS - 10 * MIN);
  const net = scriptedFetch([tokenOk, () => jsonResponse(fx('product-approved.json'))]);
  const s = await runCron(env as any, testDeps({ fetch: net.fetch }) as any);
  assert.deepEqual([s.checked, s.updated], [1, 1]);
  assert.equal((await getListing(db as any, 'OLD'))?.status, 'APPROVED');
});

test('cron: the row that triggers a global-error break is bumped so it cannot sort first on every tick', async () => {
  const db = sqliteD1();
  const env = await liveEnv(db);
  for (const [i, id] of ['A', 'B', 'C'].entries()) await saveListing(db as any, row(id), FIXED_NOW_MS - (30 - i) * MIN);
  const e401 = () => jsonResponse(fx('error-401.json'), 401);
  const net = scriptedFetch([tokenOk, e401, tokenOk, e401]);
  const s = await runCron(env as any, testDeps({ fetch: net.fetch }) as any);
  assert.deepEqual([s.checked, s.errors], [1, 1]);
  assert.equal((await getListing(db as any, 'A'))?.last_checked_at, FIXED_NOW_MS); // the triggering row
  assert.equal((await getListing(db as any, 'B'))?.last_checked_at, null);
  assert.equal((await getListing(db as any, 'C'))?.last_checked_at, null);
  // Next tick (later): the unchecked rows now sort ahead of A.
  const next = await listDueForReconcile(db as any, FIXED_NOW_MS + 30 * MIN, 25);
  assert.deepEqual(next.map((r) => r.offer_id), ['B', 'C', 'A']);
});

// hero price warm-up: one paid SerpApi refresh when the hero cache entry is missing or older than 12 h
const H = 60 * MIN;
const MANIFEST_RAW = readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8');
const SERP_BODY = readFileSync(new URL('./fixtures/feeds/serpapi-shopping.json', import.meta.url), 'utf8');
const HERO_Q = { gtin: null, query: 'iPhone 16 Pro Clear MagSafe Case', country: 'US' as const };
function warmNet(opts: { serp?: number } = {}) {
  const calls: string[] = [];
  const fetchFn = async (input: Request | string | URL): Promise<Response> => {
    const u = String(input instanceof Request ? input.url : input);
    calls.push(u);
    if (u.includes('serpapi.com')) return opts.serp ? new Response('{"error":"boom"}', { status: opts.serp }) : new Response(SERP_BODY, { status: 200 });
    if (u.includes('searchapi.io')) return new Response(SERP_BODY, { status: 200 });
    throw new Error('unexpected ' + u);
  };
  return { fetch: fetchFn, calls, serp: () => calls.filter((u) => u.includes('serpapi.com')), searchapi: () => calls.filter((u) => u.includes('searchapi.io')) };
}
const warmEnv = (over: Record<string, unknown> = {}, now = () => FIXED_NOW_MS) => baseEnv({ DB: sqliteD1(), CACHE: memKV(now), ASSETS: fakeAssets({ '/p/manifest.json': MANIFEST_RAW }), SERPAPI_KEY: 'skey', ...over });
const heroKey = () => feedCacheKey('serpapi', HERO_Q);
const seedHero = async (env: any, ageMs: number) => writeFeedCache(env.CACHE, await heroKey(), { fetchedAtMs: FIXED_NOW_MS - ageMs, offers: [] }, 24 * H);

test('warm: the hero sku is the catalog hero and the threshold is 12 h', () => {
  assert.equal(HERO_SKU, 'CASE-IP16PRO-CLEAR-MAG-001');
  assert.equal(WARM_REFRESH_AFTER_MS, 12 * H);
});

test('warm: hero cache missing -> exactly one paid SerpApi refresh for the hero title, cache written, counters incremented once', async () => {
  const env = warmEnv();
  const net = warmNet();
  assert.equal(await warmHeroPrice(env as any, testDeps({ fetch: net.fetch }) as any), 'refreshed');
  assert.equal(net.calls.length, 1);
  assert.equal(new URL(net.serp()[0]).searchParams.get('q'), 'iPhone 16 Pro Clear MagSafe Case');
  const cached = await readFeedCache(env.CACHE as any, await heroKey());
  assert.equal(cached?.fetchedAtMs, FIXED_NOW_MS);
  assert.equal(cached?.offers.length, 3);
  assert.equal(await (env.CACHE as any).get(quotaKey('serpapi', FIXED_NOW_MS)), '1');
  assert.equal(await (env.CACHE as any).get(monthlyQuotaKey('serpapi', FIXED_NOW_MS)), '1');
});

test('warm: hero cache younger than 12 h -> no call, no counters', async () => {
  const env = warmEnv();
  await seedHero(env, 12 * H - MIN);
  const net = warmNet();
  assert.equal(await warmHeroPrice(env as any, testDeps({ fetch: net.fetch }) as any), 'fresh');
  assert.equal(net.calls.length, 0);
  assert.equal(await (env.CACHE as any).get(quotaKey('serpapi', FIXED_NOW_MS)), null);
});

test('warm: hero cache 13 h old -> one paid refresh that renews the entry', async () => {
  const env = warmEnv();
  await seedHero(env, 13 * H);
  const net = warmNet();
  assert.equal(await warmHeroPrice(env as any, testDeps({ fetch: net.fetch }) as any), 'refreshed');
  assert.equal(net.serp().length, 1);
  assert.equal((await readFeedCache(env.CACHE as any, await heroKey()))?.fetchedAtMs, FIXED_NOW_MS);
});

test('warm: exhausted daily or monthly quota -> no call, no throw, reported as quota_exhausted', async () => {
  for (const [key, val] of [[quotaKey('serpapi', FIXED_NOW_MS), '8'], [monthlyQuotaKey('serpapi', FIXED_NOW_MS), '240']] as const) {
    const env = warmEnv();
    await (env.CACHE as any).put(key, val);
    const net = warmNet();
    assert.equal(await warmHeroPrice(env as any, testDeps({ fetch: net.fetch }) as any), 'quota_exhausted');
    assert.equal(net.calls.length, 0);
  }
});

test('warm: SerpApi unconfigured (MOCK) -> nothing happens', async () => {
  const env = warmEnv({ SERPAPI_KEY: undefined, SEARCH_API_KEY: 'sak' });
  const net = warmNet();
  assert.equal(await warmHeroPrice(env as any, testDeps({ fetch: net.fetch }) as any), 'unconfigured');
  assert.equal(net.calls.length, 0);
});

test('warm: a hero missing from the manifest (or no manifest) is skipped; other skus are never warmed', async () => {
  const entries = JSON.parse(MANIFEST_RAW);
  entries.entries = entries.entries.filter((e: any) => e.sku !== HERO_SKU);
  for (const files of [{ '/p/manifest.json': JSON.stringify(entries) }, {}]) {
    const env = warmEnv({ ASSETS: fakeAssets(files) });
    const net = warmNet();
    assert.equal(await warmHeroPrice(env as any, testDeps({ fetch: net.fetch }) as any), 'no_hero');
    assert.equal(net.calls.length, 0);
  }
});

test('warm: a SerpApi outage spends one call, never reaches SearchApi.io, and backs off for an hour', async () => {
  let now = FIXED_NOW_MS;
  const env = warmEnv({ SEARCH_API_KEY: 'sak' }, () => now);
  const net = warmNet({ serp: 503 });
  const deps = () => testDeps({ fetch: net.fetch, nowMs: () => now }) as any;
  assert.equal(await warmHeroPrice(env as any, deps()), 'FEED_UPSTREAM');
  assert.deepEqual([net.serp().length, net.searchapi().length], [1, 0]);
  assert.equal(await (env.CACHE as any).get('quota:v1t:searchapi'), null);
  now += 15 * MIN;
  assert.equal(await warmHeroPrice(env as any, deps()), 'cooldown');
  assert.equal(net.calls.length, 1);
  now += 50 * MIN; // 65 min after the failure
  assert.equal(await warmHeroPrice(env as any, deps()), 'FEED_UPSTREAM');
  assert.equal(net.serp().length, 2);
});

test('warm: a stale-but-present hero entry survives a failed refresh (no data loss)', async () => {
  const env = warmEnv();
  await seedHero(env, 13 * H);
  const net = warmNet({ serp: 503 });
  assert.equal(await warmHeroPrice(env as any, testDeps({ fetch: net.fetch }) as any), 'FEED_UPSTREAM');
  assert.equal((await readFeedCache(env.CACHE as any, await heroKey()))?.fetchedAtMs, FIXED_NOW_MS - 13 * H);
});

test('runCron: one tick makes at most one paid call, keeps the summary shape, and logs the warm code only', async () => {
  const env = warmEnv();
  const net = warmNet();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let s;
  try { s = await runCron(env as any, testDeps({ fetch: net.fetch }) as any); } finally { console.log = orig; }
  assert.deepEqual(s, { checked: 0, updated: 0, errors: 0, purged: 0, merchantConfigured: false });
  assert.equal(net.calls.length, 1);
  const warm = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.event === 'cron_warm');
  assert.equal(warm.code, 'refreshed');
  assert.ok(!lines.join('\n').includes('skey'));
  await runCron(env as any, testDeps({ fetch: net.fetch }) as any); // second tick: entry is fresh
  assert.equal(net.calls.length, 1);
});

test('runCron: a warm-up crash (KV down) never throws and does not skip the purge', async () => {
  const db = sqliteD1();
  await insertObservations(db as any, [{ source: 'ebay', gtin: null, query: 'q', price_cents: 1, currency: 'USD', locked: 0, title: null, url: null, observed_at: FIXED_NOW_MS - 7 * 60 * MIN }]);
  const broken = { get: async () => { throw new Error('kv down skey'); }, put: async () => { throw new Error('kv down skey'); } };
  const env = warmEnv({ DB: db, CACHE: broken });
  const net = warmNet();
  const s = await runCron(env as any, testDeps({ fetch: net.fetch }) as any);
  assert.equal(s.purged, 1);
  assert.equal(net.calls.length, 0);
});

// sustained-outage budget: exponential backoff (1,2,4,8,12 h) + at most 3 failed attempts per UTC day
const DAY = 24 * H;
const failKey = (nowMs: number) => 'warm:v1:serpapi:fail:' + new Date(nowMs).toISOString().slice(0, 10);
function outage(start = FIXED_NOW_MS, over: Record<string, unknown> = {}) {
  const clock = { now: start };
  const env = warmEnv(over, () => clock.now) as any;
  const net = warmNet({ serp: 503 });
  const tick = () => warmHeroPrice(env, testDeps({ fetch: net.fetch, nowMs: () => clock.now }) as any);
  return { clock, env, net, tick };
}

test('warm backoff: failures 1,2,3 block the next attempts until exactly 1 h, 2 h, 4 h; state is {n, until} with a bounded TTL', async () => {
  const start = Date.UTC(2026, 9, 2, 20, 0, 0); // 20:00, 21:00, 23:00: the 4 h backoff after the 3rd failure crosses midnight
  const { clock, env, net, tick } = outage(start);
  for (const [n, waitMs] of [[1, H], [2, 2 * H], [3, 4 * H]] as const) {
    const failedAt = clock.now;
    assert.equal(await tick(), 'FEED_UPSTREAM');
    assert.equal(net.serp().length, n);
    assert.deepEqual(JSON.parse(await env.CACHE.get('warm:v1:serpapi:retry')), { n, until: failedAt + waitMs });
    clock.now = failedAt + waitMs - MIN;
    assert.equal(await tick(), 'cooldown');
    assert.equal(net.serp().length, n);
    clock.now = failedAt + waitMs; // the next iteration (if any) attempts at exactly `until`
  }
  const ttls = env.CACHE.puts.filter((p: any) => p.key === 'warm:v1:serpapi:retry').map((p: any) => p.ttl);
  assert.equal(ttls.length, 3);
  for (const t of ttls) assert.ok(Number.isInteger(t) && t >= 60 && t <= 2 * 24 * 3600, 'ttl ' + t);
  const dayPuts = env.CACHE.puts.filter((p: any) => p.key === failKey(start));
  assert.equal(dayPuts.length, 3);
  for (const p of dayPuts) assert.equal(p.ttl, 2 * 24 * 3600);
});

test('warm backoff: delays double and cap at 12 h (1,2,4,8,12,12) across days', async () => {
  const { clock, env, tick } = outage();
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    const at = clock.now;
    assert.equal(await tick(), 'FEED_UPSTREAM', 'attempt ' + (i + 1));
    const s = JSON.parse(await env.CACHE.get('warm:v1:serpapi:retry'));
    delays.push((s.until - at) / H);
    clock.now = s.until; // advance exactly to the end of the backoff (new UTC days reset the daily cap)
    if (i === 2) clock.now = Math.max(clock.now, Date.UTC(2026, 9, 3, 0, 0, 0)); // 3 attempts used today: wait for tomorrow
  }
  assert.deepEqual(delays, [1, 2, 4, 8, 12, 12]);
});

test('warm backoff: the 4th failure within one UTC day is never attempted; the next UTC day allows an attempt again', async () => {
  const start = Date.UTC(2026, 9, 2, 0, 5, 0);
  const { clock, env, net, tick } = outage(start);
  await tick(); clock.now += H; await tick(); clock.now += 2 * H; await tick(); // 00:05, 01:05, 03:05
  assert.equal(net.serp().length, 3);
  assert.equal(await env.CACHE.get(failKey(start)), '3');
  clock.now = Date.UTC(2026, 9, 2, 23, 50, 0); // backoff long over, still the same UTC day
  assert.equal(await tick(), 'daily_cap');
  assert.equal(net.serp().length, 3);
  clock.now = Date.UTC(2026, 9, 3, 0, 5, 0);
  assert.equal(await tick(), 'FEED_UPSTREAM');
  assert.equal(net.serp().length, 4);
  assert.equal(await env.CACHE.get(failKey(clock.now)), '1');
});

test('warm backoff: a success resets the consecutive-failure state (back to a 1 h first backoff) and clears the retry key', async () => {
  const clock = { now: FIXED_NOW_MS };
  const env = warmEnv({}, () => clock.now) as any;
  let failing = true;
  const calls: string[] = [];
  const fetchFn = async (input: Request | string | URL) => { calls.push(String(input)); return failing ? new Response('{}', { status: 503 }) : new Response(SERP_BODY, { status: 200 }); };
  const tick = () => warmHeroPrice(env, testDeps({ fetch: fetchFn, nowMs: () => clock.now }) as any);
  assert.equal(await tick(), 'FEED_UPSTREAM');
  clock.now += H;
  assert.equal(await tick(), 'FEED_UPSTREAM');
  assert.equal(JSON.parse(await env.CACHE.get('warm:v1:serpapi:retry')).n, 2);
  clock.now += 2 * H;
  failing = false;
  assert.equal(await tick(), 'refreshed');
  assert.equal(await env.CACHE.get('warm:v1:serpapi:retry'), null);
  // 12 h later the entry is stale again; the next failure starts over at n=1 / 1 h
  clock.now += 12 * H;
  failing = true;
  const at = clock.now;
  assert.equal(await tick(), 'FEED_UPSTREAM');
  assert.deepEqual(JSON.parse(await env.CACHE.get('warm:v1:serpapi:retry')), { n: 1, until: at + H });
});

test('warm backoff: a corrupt backoff value (or corrupt daily counter) skips the tick; a KV read failure on them keeps going', async () => {
  for (const bad of ['1', 'zz', '{"n":"x","until":1}', '{"n":1}', '{"n":-1,"until":5}', 'null', '[]']) {
    const { env, net, tick } = outage();
    await env.CACHE.put('warm:v1:serpapi:retry', bad);
    assert.equal(await tick(), 'cooldown', bad);
    assert.equal(net.calls.length, 0, bad);
  }
  for (const bad of ['abc', '-1', '3x']) {
    const { env, net, tick } = outage();
    await env.CACHE.put(failKey(FIXED_NOW_MS), bad);
    assert.equal(await tick(), 'daily_cap', bad);
    assert.equal(net.calls.length, 0, bad);
  }
  // read failure on only the warm keys: today's behavior (the quota counters still guard the call)
  const { env, net, tick } = outage();
  const realGet = env.CACHE.get.bind(env.CACHE);
  env.CACHE.get = async (k: string) => { if (k.startsWith('warm:v1:')) throw new Error('kv down'); return realGet(k); };
  assert.equal(await tick(), 'FEED_UPSTREAM');
  assert.equal(net.serp().length, 1);
});

test('warm backoff: 7 days of 15-minute ticks against a continuous 503 make at most 3 paid attempts a day and the monthly counter matches', async () => {
  const start = Date.UTC(2026, 9, 2, 0, 0, 0);
  const { clock, env, net, tick } = outage(start);
  const perDay = new Map<string, number>();
  for (let t = start; t < start + 7 * DAY; t += 15 * MIN) {
    clock.now = t;
    const before = net.serp().length;
    await tick();
    const made = net.serp().length - before;
    assert.ok(made <= 1);
    const d = new Date(t).toISOString().slice(0, 10);
    perDay.set(d, (perDay.get(d) ?? 0) + made);
  }
  for (const [d, n] of perDay) assert.ok(n <= 3, d + ' made ' + n);
  const total = net.serp().length;
  assert.ok(total >= 7 && total <= 21, 'total ' + total);
  assert.equal(net.searchapi().length, 0);
  assert.equal(await env.CACHE.get(monthlyQuotaKey('serpapi', start)), String(total));
});

test('warm backoff: the healthy path is unchanged (missing -> one call; 11 h no call; 12 h one call; no failure state written)', async () => {
  const clock = { now: FIXED_NOW_MS };
  const env = warmEnv({}, () => clock.now) as any;
  const net = warmNet();
  const tick = () => warmHeroPrice(env, testDeps({ fetch: net.fetch, nowMs: () => clock.now }) as any);
  assert.equal(await tick(), 'refreshed');
  clock.now += 11 * H;
  assert.equal(await tick(), 'fresh');
  assert.equal(net.calls.length, 1);
  clock.now += H;
  assert.equal(await tick(), 'refreshed');
  assert.equal(net.calls.length, 2);
  assert.equal(await env.CACHE.get('warm:v1:serpapi:retry'), null);
  assert.equal(await env.CACHE.get(failKey(clock.now)), null);
});
