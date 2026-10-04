// node --test test/market/market-cache-worst.test.ts   (from apps/web)
// Does the biggest snapshot the system can produce still fit? Two readers, two limits:
//   - the browser cache entry is buildSnapshot(ledger) in an envelope; market-cache.ts writeCache refuses anything above CACHE_MAX_BYTES (3 MB);
//   - the body the Worker serves is cut by worker/market/assemble.ts (hot part <= PART_MAX_BYTES, cold part <= PART_MAX_BYTES) so it stays
//     under MAX_BODY_BYTES (5 MB, the client's own limit).
// Scenarios, all 18 catalog markets and a 30 000-epoch history (about 16 days, more folded hours than AGG_KEEP):
//   A  how the keeper runs today (one market per epoch, 6 bot orders per book): must fit the cache.
//   B  theoretical worst (every market has a book with the contract's 24-order maximum in each of the HOT_EPOCHS hot epochs, all filled, hashes on
//      the newest HASH_EPOCHS, full tx hashes): does NOT fit (about 10 MB). It must degrade safely: writeCache returns false, stores nothing, throws nothing.
//   C  the same worst case assembled the way the Worker does it (fitHot + graduate + snapshotBody): fits MAX_BODY_BYTES.
// The validator caps (LIMITS.books 16384, LIMITS.ordersPerBook 512) are not a size target: 16384 x 512 orders is hundreds of MB and cannot exist
// (18 markets x 160 epochs = 2880 books, 24 orders each); the numbers are printed so the cap is not mistaken for a plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY_BYTES, PART_MAX_BYTES, fitHot, graduate, snapshotBody } from '../../worker/market/assemble.ts';
import type { EpochRow, MetaRow } from '../../worker/market/repo.ts';
import { HASH_EPOCHS, HOT_EPOCHS, LIMITS, buildSnapshot, toSnapBook, toSnapClear, validateSnapshot } from '../../src/lib/market-snap.ts';
import { CACHE_KEY, CACHE_MAX_BYTES, memoryKV, readCache, writeCache } from '../../src/lib/market-cache.ts';
import { SCHED, ID, TOP, CURSOR, META, envelope, TODAY, WORST, ledgerOf } from './helpers/worst-ledger.ts';

test('A: the cache entry for the keeper as it runs today (one market per epoch, 6 orders per book) fits CACHE_MAX_BYTES and round-trips', async () => {
  const snap = buildSnapshot(ledgerOf(TODAY), META, SCHED); const raw = envelope(snap);
  console.log(`A today: ${raw.length} bytes of ${CACHE_MAX_BYTES} (${snap.hot.books.length} hot books, cold ${JSON.stringify(snap.cold).length} B)`);
  assert.ok(raw.length < CACHE_MAX_BYTES, `${raw.length} bytes`);
  const kv = memoryKV();
  assert.equal(await writeCache(kv, ID, snap, Date.now()), true);
  assert.ok(await readCache(kv, ID, Date.now()), 'readCache validates what writeCache stored');
});

test('B: the theoretical worst cache entry (18 markets x 160 epochs x 24 orders) is over CACHE_MAX_BYTES and degrades safely: no write, no throw, no cache', async () => {
  const snap = buildSnapshot(ledgerOf(WORST), META, SCHED); const raw = envelope(snap);
  const books = snap.hot.books.length, orders = snap.hot.books.reduce((n, b) => n + b.o.length, 0);
  assert.equal(books, 18 * HOT_EPOCHS); assert.equal(orders, books * 24);
  const hot = JSON.stringify(snap.hot).length, cold = JSON.stringify(snap.cold).length, perOrder = JSON.stringify(snap.hot.books[0].o[0]).length;
  const fits = Math.floor((CACHE_MAX_BYTES - (raw.length - hot)) / (hot / HOT_EPOCHS));
  console.log(`B worst: ${raw.length} bytes vs cap ${CACHE_MAX_BYTES}: hot ${hot} (${books} books, ${orders} orders, ~${perOrder} B/order, ${Math.round(hot / HOT_EPOCHS)} B per hot epoch), cold ${cold}. Hot epochs that would fit under the cap: ${fits} of ${HOT_EPOCHS}.`);
  console.log(`B caps for scale: ${LIMITS.books} books x ${LIMITS.ordersPerBook} orders = ${LIMITS.books * LIMITS.ordersPerBook} orders ~ ${Math.round((LIMITS.books * LIMITS.ordersPerBook * perOrder) / 1e6)} MB, unreachable (the contract allows 24 per market-epoch)`);
  assert.ok(raw.length > CACHE_MAX_BYTES, 'if this ever fits, drop this test and keep A: the cap is no longer the limit');
  const kv = memoryKV();
  assert.equal(await writeCache(kv, ID, snap, Date.now()), false);
  assert.equal(kv.data.has(CACHE_KEY), false, 'nothing stored: the next visit simply loads from the Worker snapshot');
});

test('C: the worst case assembled by the Worker (fitHot + graduate + snapshotBody) stays under MAX_BODY_BYTES and validates', () => {
  const l = ledgerOf(WORST); const hotFromEpoch = TOP - HOT_EPOCHS + 1, coldUntil = hotFromEpoch - 12_000, hashFrom = TOP - HASH_EPOCHS + 1;
  const rows: EpochRow[] = [];
  for (const [m, byE] of l.clears) {
    for (const [e, c] of byE) {
      if (e < coldUntil) continue;
      const b = l.books.get(`${m}:${e}`);
      rows.push({ market: m, epoch: e, book_json: b ? JSON.stringify(toSnapBook(b, true)) : '{}', lite_json: b ? JSON.stringify(toSnapBook(b, false)) : '{}', clear_json: JSON.stringify(toSnapClear(e, c, true)) });
    }
  }
  rows.sort((a, b) => a.epoch - b.epoch || a.market.localeCompare(b.market));
  const hot = fitHot(rows, hotFromEpoch, hotFromEpoch, hashFrom, CURSOR);
  const cold = graduate(null, rows, coldUntil, hotFromEpoch, SCHED);
  const meta: MetaRow = { id: 1, schema_version: 1, chain_id: ID.chainId, book: ID.book, deploy_block: ID.deployBlock, schedule_json: JSON.stringify(SCHED), next_block: CURSOR + 1, anchor_block: null, anchor_hash: null, head_block: CURSOR, head_time: 1, cold_until: hotFromEpoch, updated_at: 1, lease_until: 0 };
  const body = snapshotBody(meta, { hot: { part: 'hot', body: hot.body, built_at: 1 }, cold: { part: 'cold', body: cold, built_at: 1 } }, 1);
  console.log(`C worker body: ${body?.length} bytes of ${MAX_BODY_BYTES} (hot ${hot.body.length}${hot.trimmed ? `, trimmed to the newest ${TOP - hot.hotFrom + 1} epochs` : ''}, cold ${cold.length}; each part cap ${PART_MAX_BYTES})`);
  assert.ok(body, 'snapshotBody refuses a body above MAX_BODY_BYTES (null)');
  assert.ok(hot.body.length <= PART_MAX_BYTES && cold.length <= PART_MAX_BYTES && body!.length <= MAX_BODY_BYTES);
  assert.ok(validateSnapshot(JSON.parse(body!), ID), 'the client accepts the worst Worker body');
});
