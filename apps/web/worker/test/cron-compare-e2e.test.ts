// Permanent cron -> route contract: the hero price the cron warm-up writes is exactly what an ANONYMOUS compare request reads.
// Fake KV/D1/fetch and an injected clock; the real router (handleFetch) and the real scheduled handler (handleScheduled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleFetch } from '../app.ts';
import { handleScheduled } from '../cron.ts';
import { feedCacheKey } from '../feeds/cache.ts';
import { monthlyQuotaKey, quotaKey } from '../feeds/quota.ts';
import { FIXED_NOW_MS, baseEnv, fakeAssets, fakeExec, memKV, testDeps } from './helpers/fakes.ts';
import { sqliteD1 } from './helpers/d1.ts';

const SITE = 'https://robinize.agent-dong.workers.dev';
const HERO = 'CASE-IP16PRO-CLEAR-MAG-001';
const MANIFEST_RAW = readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8');
const SERP_BODY = readFileSync(new URL('./fixtures/feeds/serpapi-shopping.json', import.meta.url), 'utf8');

test('cron warm-up then anonymous compare: before NONE/refresh_requires_operator, after HIT with offers, zero extra SerpApi calls, one cache key', async () => {
  const clock = { now: FIXED_NOW_MS };
  const kv = memKV(() => clock.now);
  const env = baseEnv({ DB: sqliteD1(), CACHE: kv, ASSETS: fakeAssets({ '/p/manifest.json': MANIFEST_RAW }), SERPAPI_KEY: 'skey', ADMIN_TOKEN: 'adm-' + 'x'.repeat(40) }) as any;
  const calls: string[] = [];
  const fetchFn = async (input: Request | string | URL): Promise<Response> => {
    const u = String(input instanceof Request ? input.url : input);
    calls.push(u);
    if (u.includes('serpapi.com/search')) return new Response(SERP_BODY, { status: 200 });
    throw new Error('unexpected call ' + u);
  };
  const deps = () => testDeps({ fetch: fetchFn, nowMs: () => clock.now }) as any;
  const anon = async (qs: string) => {
    const res = await handleFetch(new Request(SITE + '/api/prices/compare?' + qs), env, fakeExec() as any, deps()); // no x-admin-token
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    return { body, serp: body.sources.find((s: any) => s.id === 'serpapi'), offers: body.offers.filter((o: any) => o.source === 'serpapi') };
  };
  const variants = ['sku=' + HERO, 'sku=' + HERO + '&q=zzz', 'sku=' + HERO + '&country=US', 'country=US&q=zzz&sku=' + HERO];

  // 1. Cold cache: the anonymous visitor gets nothing paid, and nothing is spent.
  const cold = await anon('sku=' + HERO);
  assert.deepEqual([cold.serp.mode, cold.serp.cache, cold.serp.error, cold.offers.length], ['REAL', 'NONE', 'refresh_requires_operator', 0]);
  assert.equal(calls.length, 0);
  assert.equal(await kv.get(quotaKey('serpapi', clock.now)), null);

  // 2. The scheduled handler warms the hero entry: exactly one paid call.
  await handleScheduled({ cron: '*/15 * * * *' }, env, deps());
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).searchParams.get('q'), 'iPhone 16 Pro Clear MagSafe Case');
  assert.equal(await kv.get(quotaKey('serpapi', clock.now)), '1');
  assert.equal(await kv.get(monthlyQuotaKey('serpapi', clock.now)), '1');
  const heroKey = await feedCacheKey('serpapi', { gtin: null, query: 'iPhone 16 Pro Clear MagSafe Case', country: 'US' });
  assert.ok(kv.store.has(heroKey), 'cron wrote the key the route derives');
  const feedKeys = () => [...kv.store.keys()].filter((k) => k.startsWith('feed:v1:serpapi:'));
  assert.deepEqual(feedKeys(), [heroKey]);

  // 3. Anonymous reads (all spellings of the hero request) are HITs on that same entry, with offers, and call nothing.
  for (const qs of variants) {
    const warm = await anon(qs);
    assert.deepEqual([warm.serp.mode, warm.serp.cache, warm.serp.error], ['REAL', 'HIT', null], qs);
    assert.ok(warm.offers.length >= 1, qs);
    assert.equal(warm.serp.offers, warm.offers.length, qs);
    assert.ok(warm.body.offers.some((o: any) => o.source === 'serpapi' && o.priceCents === 1049), qs);
    assert.equal(calls.length, 1, qs);
  }
  assert.deepEqual(feedKeys(), [heroKey]);
  assert.equal(await kv.get(quotaKey('serpapi', clock.now)), '1');

  // 4. A second tick while the entry is younger than 12 h makes no call either.
  clock.now += 11 * 60 * 60 * 1000;
  await handleScheduled({ cron: '*/15 * * * *' }, env, deps());
  assert.equal(calls.length, 1);
});
