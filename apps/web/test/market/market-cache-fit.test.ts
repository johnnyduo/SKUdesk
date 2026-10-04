// node --test test/market/market-cache-fit.test.ts   (from apps/web)
// The browser cache writer on the theoretical worst ledger (18 markets x 160 hot epochs x 24 orders, about 10 MB in full): fitSnapshot / writeFitted
// shrink it like the Worker's fitHot (drop commit hashes, then the oldest hot epochs; every clear stays) until the entry fits CACHE_MAX_BYTES, and
// createCacheGate keeps a failed write from being retried (rebuild + serialize of a big snapshot) before the 5-minute window has passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newLedger, clearPoints } from '../../src/lib/market-core.ts';
import { HASH_EPOCHS, HOT_EPOCHS, FULL_KEEP, buildSnapshot, hydrate, validateSnapshot } from '../../src/lib/market-snap.ts';
import { CACHE_KEY, CACHE_MAX_BYTES, CACHE_WRITE_EVERY_MS, createCacheGate, fitSnapshot, memoryKV, readCache, writeFitted, type KV } from '../../src/lib/market-cache.ts';
import { ID, META, SCHED, TOP, TODAY, WORST, envelope, ledgerOf } from './helpers/worst-ledger.ts';

const NOW = 1_800_000_000_000;
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('fitSnapshot: a ledger that already fits is returned exactly as buildSnapshot makes it (nothing is thrown away)', () => {
  const l = ledgerOf(TODAY);
  const fit = fitSnapshot(l, META, SCHED, ID, NOW);
  assert.deepEqual(fit, buildSnapshot(l, META, SCHED));
});

test('fitSnapshot: the worst ledger is shrunk to <= CACHE_MAX_BYTES, validates, and keeps the newest epoch and every market\'s clears', () => {
  const l = ledgerOf(WORST);
  assert.ok(envelope(buildSnapshot(l, META, SCHED)).length > CACHE_MAX_BYTES, 'precondition: the unshrunk worst case is over the cap');
  const snap = fitSnapshot(l, META, SCHED, ID, NOW)!;
  assert.ok(snap, 'something fits');
  const bytes = JSON.stringify({ k: 'x'.repeat(60), savedAt: NOW, body: snap }).length;
  assert.ok(bytes <= CACHE_MAX_BYTES, `${bytes} bytes`);
  assert.ok(validateSnapshot(wire(snap), ID), 'validateSnapshot accepts it');
  const epochs = snap.hot.books.map((b) => b.e);
  assert.equal(Math.max(...epochs), TOP, 'the newest epoch keeps its books');
  assert.ok(Math.min(...epochs) > TOP - HOT_EPOCHS + 1, 'the hot window was shortened (oldest hot epochs dropped)');
  assert.ok(epochs.length > 0, 'but not emptied');
  assert.ok(snap.hot.books.every((b) => b.e > TOP - HASH_EPOCHS ? b.o.every((o) => o.h === undefined) : true), 'commit hashes dropped');
  // every market still has its newest clear and a contiguous newest range, in the hot books or the cold part
  const back = newLedger(); hydrate(back, validateSnapshot(wire(snap), ID)!);
  const want = clearPoints(l), got = clearPoints(back);
  assert.equal(Object.keys(got).length, 18);
  for (const [m, list] of Object.entries(want)) {
    const g = got[m]; assert.ok(g, m);
    assert.equal(g[g.length - 1].epoch, TOP, 'newest clear kept');
    const tail = list.slice(-FULL_KEEP), gt = g.slice(-FULL_KEEP);
    assert.equal(gt.length, tail.length);
    for (const [i, c] of tail.entries()) {
      const k = gt[i];
      assert.deepEqual([k.epoch, k.price, k.volume, k.buys, k.sells, k.forfeited, k.block, k.time], [c.epoch, c.price, c.volume, c.buys, c.sells, c.forfeited, c.block, c.time], `${m} epoch ${c.epoch}`);
    }
    assert.equal(gt[gt.length - 1].tx, tail[tail.length - 1].tx, 'tx of the newest clear kept');
  }
});

test('fitSnapshot: only clearing points are over the cap -> null (nothing sensible to store)', () => {
  assert.equal(fitSnapshot(ledgerOf(TODAY), META, SCHED, ID, NOW, 1000), null);
});

test('writeFitted: the worst ledger IS cached (the plain buildSnapshot write was refused), readCache returns it, entry <= CACHE_MAX_BYTES', async () => {
  const kv = memoryKV();
  assert.equal(await writeFitted(kv, ID, ledgerOf(WORST), META, SCHED, NOW), true);
  const raw = kv.data.get(CACHE_KEY)!; assert.ok(raw && raw.length <= CACHE_MAX_BYTES, `${raw?.length}`);
  const snap = await readCache(kv, ID, NOW); assert.ok(snap); assert.equal(Math.max(...snap!.hot.books.map((b) => b.e)), TOP);
});

test('writeFitted: a storage that refuses gives false and never throws', async () => {
  const bad: KV = { get: async () => undefined, set: async () => { throw new Error('quota'); }, del: async () => undefined };
  assert.equal(await writeFitted(bad, ID, ledgerOf(TODAY), META, SCHED, NOW), false);
});

test('createCacheGate: one write per window; force skips the window only', () => {
  let t = 1_000_000; const g = createCacheGate(() => t);
  assert.equal(g.allowed(false), true, 'first write allowed at once');
  g.begin(); g.done(true);
  t += 60_000; assert.equal(g.allowed(false), false, 'inside the window');
  assert.equal(g.allowed(true), true, 'force (history complete) skips the regular window');
  t += CACHE_WRITE_EVERY_MS; assert.equal(g.allowed(false), true, 'window over');
});

test('createCacheGate + writeFitted: a failed write is not retried within the back-off window, even when forced; then it is (injected clock)', async () => {
  let t = 5_000_000; let sets = 0; let fail = true;
  const kv: KV = { get: async () => undefined, del: async () => undefined, set: async () => { sets++; if (fail) throw new Error('quota exceeded'); } };
  const gate = createCacheGate(() => t); const ledger = ledgerOf(TODAY);
  const attempt = async (force: boolean) => {
    if (!gate.allowed(force)) return 'skipped';
    gate.begin(); const ok = await writeFitted(kv, ID, ledger, META, SCHED, t); gate.done(ok); return ok ? 'written' : 'failed';
  };
  assert.equal(await attempt(false), 'failed'); assert.equal(sets, 1);
  for (const dt of [1_000, 30_000, 120_000]) { t += dt; assert.equal(await attempt(false), 'skipped', `+${dt} ms`); assert.equal(await attempt(true), 'skipped', `forced +${dt} ms`); }
  assert.equal(sets, 1, 'no further set() while backed off');
  t = 5_000_000 + CACHE_WRITE_EVERY_MS - 1; assert.equal(await attempt(true), 'skipped', 'one ms before the window ends');
  t = 5_000_000 + CACHE_WRITE_EVERY_MS; fail = false; assert.equal(await attempt(false), 'written'); assert.equal(sets, 2);
  assert.equal(await attempt(false), 'skipped', 'and after a success the normal window applies again');
});
