import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedCacheKey, readFeedCache, writeFeedCache } from '../feeds/cache.ts';
import { monthlyQuotaKey, quotaKey, quotaRemaining, quotaRemainingMonthly, quotaRemainingTotal, totalQuotaKey, tryConsume, tryConsumeMonthly, tryConsumeTotal, utcDay } from '../feeds/quota.ts';
import { memKV } from './helpers/fakes.ts';

const Q = { gtin: '036000291452', query: 'Clear Case', country: 'US' as const };

test('feedCacheKey: stable, case/space-insensitive query, differs by source and gtin, no raw query inside', async () => {
  const a = await feedCacheKey('ebay', Q);
  assert.equal(a, await feedCacheKey('ebay', { ...Q, query: '  clear case ' }));
  assert.notEqual(a, await feedCacheKey('bestbuy', Q));
  assert.notEqual(a, await feedCacheKey('ebay', { ...Q, gtin: null }));
  assert.match(a, /^feed:v1:ebay:[0-9a-f]{32}$/);
});

test('write/read cache round trip; TTL = max stale age (>= 60 s); junk -> null', async () => {
  const kv = memKV(() => 0);
  await writeFeedCache(kv, 'k', { fetchedAtMs: 5, offers: [] }, 6 * 3600 * 1000);
  assert.deepEqual(await readFeedCache(kv, 'k'), { fetchedAtMs: 5, offers: [] });
  assert.equal(kv.puts[0].ttl, 21600);
  await writeFeedCache(kv, 'k2', { fetchedAtMs: 5, offers: [] }, 1000);
  assert.equal(kv.puts[1].ttl, 60);
  await kv.put('bad', '{nope');
  assert.equal(await readFeedCache(kv, 'bad'), null);
  assert.equal(await readFeedCache(kv, 'missing'), null);
});

test('quota: budget enforced per UTC day; resets at 00:00Z, not local midnight', async () => {
  const kv = memKV(() => 0);
  const lateUtc = Date.UTC(2026, 9, 2, 23, 59, 59);
  const nextUtc = Date.UTC(2026, 9, 3, 0, 0, 0);
  assert.equal(utcDay(lateUtc), '2026-10-02');
  assert.equal(quotaKey('serpapi', nextUtc), 'quota:v1:serpapi:2026-10-03');
  assert.deepEqual(await tryConsume(kv, 'serpapi', 2, lateUtc), { allowed: true, used: 1, remaining: 1 });
  assert.deepEqual(await tryConsume(kv, 'serpapi', 2, lateUtc), { allowed: true, used: 2, remaining: 0 });
  assert.deepEqual(await tryConsume(kv, 'serpapi', 2, lateUtc), { allowed: false, used: 2, remaining: 0 });
  assert.equal(await quotaRemaining(kv, 'serpapi', 2, nextUtc), 2);
  assert.equal((await tryConsume(kv, 'serpapi', 2, nextUtc)).allowed, true);
  assert.equal((await tryConsume(kv, 'ebay', 0, lateUtc)).allowed, false);
});

test('lifetime quota: for plans whose credits never refill; no TTL, survives month and year changes, hard stop at the cap', async () => {
  const kv = memKV(() => 0);
  assert.deepEqual(await tryConsumeTotal(kv, 'searchapi', 2, Date.UTC(2026, 9, 31)), { allowed: true, used: 1, remaining: 1 });
  assert.deepEqual(await tryConsumeTotal(kv, 'searchapi', 2, Date.UTC(2027, 0, 1)), { allowed: true, used: 2, remaining: 0 });
  assert.deepEqual(await tryConsumeTotal(kv, 'searchapi', 2, Date.UTC(2027, 5, 1)), { allowed: false, used: 2, remaining: 0 });
  assert.equal(await quotaRemainingTotal(kv, 'searchapi', 2, 0), 0);
  assert.ok(kv.puts.every((p: any) => p.ttl === undefined));
});

// Fail-safe: a counter we cannot trust (corrupt value) or a budget that is not a finite number means "exhausted", never "free".
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const COUNTERS = [
  ['daily', (kv: any) => quotaKey('s', NOW), (kv: any, b: number) => tryConsume(kv, 's', b, NOW), (kv: any, b: number) => quotaRemaining(kv, 's', b, NOW)],
  ['monthly', (kv: any) => monthlyQuotaKey('s', NOW), (kv: any, b: number) => tryConsumeMonthly(kv, 's', b, NOW), (kv: any, b: number) => quotaRemainingMonthly(kv, 's', b, NOW)],
  ['total', (kv: any) => totalQuotaKey('s'), (kv: any, b: number) => tryConsumeTotal(kv, 's', b, NOW), (kv: any, b: number) => quotaRemainingTotal(kv, 's', b, NOW)],
] as const;

for (const [name, keyOf, consume, remaining] of COUNTERS) {
  test('quota fail-safe (' + name + '): corrupt stored counters ("abc", "-5", "12abc", "1e3", "") are exhausted, nothing is written', async () => {
    for (const junk of ['abc', '-5', '12abc', '1e3', '1.5', '', ' ', 'NaN', 'Infinity']) {
      const kv = memKV(() => NOW);
      await kv.put(keyOf(kv), junk);
      const before = kv.puts.length;
      const r = await consume(kv, 100);
      assert.equal(r.allowed, false, name + ' ' + JSON.stringify(junk));
      assert.equal(r.remaining, 0);
      assert.equal(await remaining(kv, 100), 0, name + ' remaining ' + JSON.stringify(junk));
      assert.equal(kv.puts.length, before);
      assert.equal(await kv.get(keyOf(kv)), junk);
    }
  });

  test('quota fail-safe (' + name + '): a non-finite or NaN budget is exhausted; a valid stored count still works', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const kv = memKV(() => NOW);
      const r = await consume(kv, bad);
      assert.deepEqual([r.allowed, r.remaining], [false, 0], name + ' ' + bad);
      assert.equal(await remaining(kv, bad), 0);
      assert.equal(kv.puts.length, 0);
    }
    const kv = memKV(() => NOW);
    await kv.put(keyOf(kv), '7');
    assert.deepEqual(await consume(kv, 10), { allowed: true, used: 8, remaining: 2 });
    assert.equal(await remaining(kv, 10), 2);
  });
}
