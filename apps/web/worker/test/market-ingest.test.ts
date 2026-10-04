import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { applyEvents, clearPoints, decodeLogs, fillRows, newLedger, rangeStats, type CoreBook, type RawLog } from '../../src/lib/market-core.ts';
import { hydrate, toSnapBook, toSnapClear, validateSnapshot, HOT_EPOCHS, LIMITS } from '../../src/lib/market-snap.ts';
import { MAX_SNAPSHOT_BYTES } from '../../src/lib/market-source.ts';
import { acquireLease } from '../market/repo.ts';
import { CONFIRMATIONS, GRADUATE_EPOCHS, MAX_BOOKS_PER_RUN, OVERLAP_BLOCKS, RETAIN_EPOCHS, MAX_LOG_CALLS, MAX_LOGS_PER_RUN, MAX_SUBREQUESTS, marketTarget, parseSchedule, readRows, rebuildParts, runMarketIngest, writeBooks } from '../market/ingest.ts';
import { D1ValueTooLargeError, bookJson, getMeta, getParts, metaUpdate, rowsFrom, upsertBooks, type EpochRow, type MetaRow } from '../market/repo.ts';
import { LAG_OK_BLOCKS, MAX_BODY_BYTES, PART_MAX_BYTES, STALE_AFTER_MS, fitHot, graduate, hotBody, isComplete, snapshotBody } from '../market/assemble.ts';
import { baseEnv, testDeps, FIXED_NOW_MS } from './helpers/fakes.ts';
import { BOOK, DEPLOY, FULL, FX, HEAD, MIGRATIONS, catchUp, harness, snapshotOf } from './helpers/market-harness.ts';
import { sqliteD1 } from './helpers/d1.ts';
import { FAKE_SCHEDULE, startFakeRpc } from '../../test/market/helpers/fake-rpc.mjs';

test('catch-up from the deploy block over several runs: bounded work per run, then the snapshot equals the one-pass ledger', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    let runs = 0; let s;
    do {
      s = await runMarketIngest(h.env, h.deps); runs++; h.tick();
      const used = h.take();
      assert.ok(used.requests <= MAX_SUBREQUESTS, `run ${runs}: ${used.requests} subrequests`);
      assert.ok(used.statements <= 40, `run ${runs}: ${used.statements} D1 statements`);
      assert.equal(s.code, undefined);
    } while (s.reason !== 'caught_up' && runs < 20);
    assert.ok(runs >= 6, 'more than one run was needed (51k blocks at 4 x 2000 per run)');
    assert.equal(s.reason, 'caught_up');
    const snap = await snapshotOf(h);
    assert.ok(snap, 'valid snapshot'); assert.equal(snap.complete, true); assert.equal(snap.cursor, HEAD - CONFIRMATIONS);
    const l = newLedger(); hydrate(l, snap);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
    assert.deepEqual(fillRows(l, FAKE_SCHEDULE), fillRows(FULL, FAKE_SCHEDULE));
    assert.deepEqual(snap.schedule, FAKE_SCHEDULE);
  } finally { await rpc.close(); }
});

test('re-runs with no new blocks write nothing but the cursor; overlapping re-reads never double count', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await catchUp(h);
    const before = JSON.stringify(await getParts(h.db as any));
    rpc.setHead(HEAD + 40); // 40 new empty blocks: the overlap re-reads the last 32 already-ingested blocks too
    const s = await runMarketIngest(h.env, h.deps);
    assert.equal(s.books, 0); assert.equal(s.rebuilt, false);
    assert.equal(JSON.stringify(await getParts(h.db as any)), before);
    // every run advances freshness (head, cursor, updated_at) even though no book changed
    const meta = (await getMeta(h.db as any))!;
    assert.deepEqual([meta.head_block, meta.next_block - 1, meta.updated_at], [HEAD + 40, HEAD + 40 - CONFIRMATIONS, h.now()]);
    const l = newLedger(); hydrate(l, (await snapshotOf(h))!);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
  } finally { await rpc.close(); }
});

test('reorg: a changed anchor hash rewinds, re-reads the affected epochs and ends in the same state', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await catchUp(h);
    rpc.setFork('b'); rpc.setHead(HEAD + 5);
    const s = await runMarketIngest(h.env, h.deps);
    assert.equal(s.reorg, true);
    for (let i = 0; i < 4; i++) { h.tick(); await runMarketIngest(h.env, h.deps); }
    const l = newLedger(); hydrate(l, (await snapshotOf(h))!);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
    assert.deepEqual(fillRows(l, FAKE_SCHEDULE), fillRows(FULL, FAKE_SCHEDULE));
  } finally { await rpc.close(); }
});

test('reorg that dies before the parts are rebuilt never serves the orphaned parts (cursor below the part)', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await catchUp(h);
    assert.ok(await snapshotOf(h));
    rpc.setFork('b'); rpc.setHead(HEAD + 5);
    // the rewind batch commits, then the log read fails: rows are deleted and the cursor is rewound, the old parts are still there
    let n = 0;
    const flaky = { ...h.deps, fetch: (i: any, init: any) => (++n === 1 ? fetch(i, init) : Promise.reject(new TypeError('down'))) };
    const s = await runMarketIngest(h.env, flaky);
    assert.equal(s.reorg, true); assert.equal(s.reason, 'error');
    assert.equal(await snapshotOf(h), null, 'parts built at a higher cursor must not be served');
    for (let i = 0; i < 8; i++) { h.tick(); await runMarketIngest(h.env, h.deps); }
    const l = newLedger(); hydrate(l, (await snapshotOf(h))!);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
  } finally { await rpc.close(); }
});

test('RPC down: honest error code, cursor and rows untouched; not configured: skipped; identity change: reset', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await runMarketIngest(h.env, h.deps); const meta = await getMeta(h.db as any);
    const down = await runMarketIngest(h.env, { ...h.deps, fetch: async () => { throw new TypeError('down'); } });
    assert.deepEqual([down.reason, down.code], ['error', 'RPC_UNREACHABLE']);
    assert.equal((await getMeta(h.db as any))!.next_block, meta!.next_block);
    assert.equal((await runMarketIngest(baseEnv({ DB: h.db }) as any, h.deps)).reason, 'not_configured');
    const moved = await runMarketIngest({ ...h.env, MARKET_DEPLOY_BLOCK: String(DEPLOY + 1000) }, h.deps);
    assert.equal(moved.ran, true); assert.equal((await getMeta(h.db as any))!.deploy_block, DEPLOY + 1000);
  } finally { await rpc.close(); }
});

const M = '0x' + 'a'.repeat(64);
const mkBook = (e: number, market = M): CoreBook => ({ market, epoch: e, firstBlock: 1000 + e, lastBlock: 1000 + e, orders: [{ index: 0, trader: '0x' + '1'.repeat(40), hash: '0x' + '2'.repeat(64), side: 0, price: 100 + (e % 5), units: 3, filled: 3 }], clear: { price: 100 + (e % 5), volume: 3, buys: 1, sells: 1, forfeited: 0, tx: '0x' + e.toString(16).padStart(64, '0'), block: 1000 + e } });
async function seedMeta(db: ReturnType<typeof sqliteD1>, next: number, head: number, coldUntil = 0) {
  await db.prepare(`INSERT INTO mk_meta (id, schema_version, chain_id, book, deploy_block, schedule_json, next_block, head_block, head_time, cold_until, updated_at) VALUES (1, 1, 46630, ?1, 1000, ?2, ?3, ?4, 1, ?5, ?6)`).bind(BOOK.toLowerCase(), JSON.stringify(FAKE_SCHEDULE), next, head, coldUntil, FIXED_NOW_MS).run();
}

test('graduation: clears that left the hot window move to the compacted cold part; old rows are purged later', async () => {
  const db = sqliteD1(MIGRATIONS);
  const books = Array.from({ length: 400 }, (_, e) => mkBook(e));
  await db.batch(upsertBooks(db as any, books) as any);
  await seedMeta(db, 1400, 1412);
  const r = await rebuildParts(db as any, 0, FAKE_SCHEDULE, FIXED_NOW_MS);
  assert.deepEqual(r, { rebuilt: true, graduated: true });
  const hotFrom = 399 - HOT_EPOCHS + 1;
  assert.ok(hotFrom >= GRADUATE_EPOCHS);
  const meta = (await getMeta(db as any))!; assert.equal(meta.cold_until, hotFrom);
  const snap = validateSnapshot(JSON.parse(snapshotBody(meta, await getParts(db as any), FIXED_NOW_MS)!), { chainId: 46630, book: BOOK.toLowerCase(), deployBlock: 1000 })!;
  assert.ok(snap);
  assert.deepEqual(snap.cold[M].map((c) => c.e), Array.from({ length: hotFrom }, (_, e) => e));
  assert.equal(snap.hot.books.length, HOT_EPOCHS);
  assert.equal(Object.keys(snap.hot.clears).length, 0);
  const l = newLedger(); hydrate(l, snap); assert.equal(clearPoints(l)[M].length, 400);
});

// assembler output

const metaRow = (over: Partial<MetaRow> = {}): MetaRow => ({ id: 1, schema_version: 1, chain_id: 46630, book: BOOK.toLowerCase(), deploy_block: 1000, schedule_json: JSON.stringify(FAKE_SCHEDULE), next_block: 5001, anchor_block: 5000, anchor_hash: '0xab', head_block: 5012, head_time: 9, cold_until: 0, updated_at: FIXED_NOW_MS, ...over });
const part = (part: 'hot' | 'cold', body: string) => ({ part, body, built_at: FIXED_NOW_MS });
const row = (b: CoreBook): EpochRow => ({ market: b.market, epoch: b.epoch, book_json: bookJson(b), lite_json: JSON.stringify(toSnapBook(b, false)), clear_json: b.clear ? JSON.stringify(toSnapClear(b.epoch, b.clear, true)) : null });
const bulkBook = (e: number, market: string, orders: number): CoreBook => ({ market, epoch: e, firstBlock: 1000 + e, lastBlock: 1000 + e, orders: Array.from({ length: orders }, (_, i) => ({ index: i, trader: '0x' + (i + 1).toString(16).padStart(40, '0'), hash: '0x' + (i + 1).toString(16).padStart(64, '0'), side: 0 as const, price: 100, units: 3 })) });
const mk = (n: number) => '0x' + n.toString(16).padStart(64, '0');

test('isComplete is a freshness flag: lag <= LAG_OK_BLOCKS and updated within STALE_AFTER_MS, not cursor === head', () => {
  const m = (over: Partial<MetaRow>) => metaRow({ next_block: 10_001, head_block: 10_000, updated_at: FIXED_NOW_MS, ...over });
  assert.equal(isComplete(m({ head_block: 10_000 + LAG_OK_BLOCKS }), FIXED_NOW_MS), true, 'cursor is 2400 behind: still complete');
  assert.equal(isComplete(m({ head_block: 10_001 + LAG_OK_BLOCKS }), FIXED_NOW_MS), false, '2401 behind');
  assert.equal(isComplete(m({}), FIXED_NOW_MS + STALE_AFTER_MS), true);
  assert.equal(isComplete(m({}), FIXED_NOW_MS + STALE_AFTER_MS + 1), false, 'cron stopped');
  assert.equal(isComplete(m({ head_block: 0 }), FIXED_NOW_MS), false);
});

test('snapshotBody: null when nothing servable or the read is torn; otherwise a valid snapshot with books ascending, unique, <= cursor', () => {
  const rows = [3, 1, 2].map((e) => row(mkBook(e))).sort((a, b) => a.epoch - b.epoch);
  const hot = part('hot', hotBody(rows, 0, 0, 0, 5000));
  const ok = snapshotBody(metaRow(), { hot, cold: null }, FIXED_NOW_MS)!;
  const snap = validateSnapshot(JSON.parse(ok), { chainId: 46630, book: BOOK.toLowerCase(), deployBlock: 1000 })!;
  assert.ok(snap); assert.equal(snap.cursor, 5000); assert.equal(snap.complete, true);
  assert.deepEqual(snap.hot.books.map((b) => b.e), [1, 2, 3]);
  assert.ok(snap.hot.books.every((b) => b.lb <= snap.cursor && b.o.every((o, i, a) => i === 0 || a[i - 1].i < o.i)));
  assert.equal(new Set(snap.hot.books.map((b) => b.m + b.e)).size, snap.hot.books.length);
  assert.equal(snapshotBody(metaRow(), { hot: null, cold: null }, FIXED_NOW_MS), null, 'no hot part yet');
  assert.equal(snapshotBody(metaRow({ cold_until: 40 }), { hot, cold: null }, FIXED_NOW_MS), null, 'cold part lost after graduation');
  assert.equal(snapshotBody(metaRow({ schedule_json: null }), { hot, cold: null }, FIXED_NOW_MS), null);
  assert.equal(snapshotBody(metaRow({ next_block: 1000 }), { hot, cold: null }, FIXED_NOW_MS), null, 'cursor before the deploy block');
  assert.equal(snapshotBody(metaRow({ head_block: 4000 }), { hot, cold: null }, FIXED_NOW_MS), null, 'cursor ahead of the head');
  // torn read: the hot part was built at cursor 6000 but the meta row read earlier says 5000
  assert.equal(snapshotBody(metaRow(), { hot: part('hot', hotBody(rows, 0, 0, 0, 6000)), cold: null }, FIXED_NOW_MS), null);
  // a hot part built at an older cursor is fine (quiet runs advance the cursor without rewriting it)
  assert.ok(snapshotBody(metaRow(), { hot: part('hot', hotBody(rows, 0, 0, 0, 4000)), cold: null }, FIXED_NOW_MS));
});

test('snapshotBody never emits a body above MAX_SNAPSHOT_BYTES (the client limit); two full parts always fit', () => {
  assert.equal(MAX_BODY_BYTES, MAX_SNAPSHOT_BYTES);
  assert.ok(2 * PART_MAX_BYTES + 2000 < MAX_SNAPSHOT_BYTES);
  const big = '"' + 'x'.repeat(MAX_SNAPSHOT_BYTES) + '"';
  assert.equal(snapshotBody(metaRow(), { hot: part('hot', `{"cur":1,"clears":{},"books":[],"pad":${big}}`), cold: null }, FIXED_NOW_MS), null);
});

test('fitHot: drops hashes first, then the oldest epochs, never exceeds the part cap and keeps the newest', () => {
  const markets = Array.from({ length: 20 }, (_, i) => mk(i + 1));
  const rows: EpochRow[] = [];
  for (let e = 0; e < 160; e++) for (const m of markets) rows.push(row(bulkBook(e, m, 10)));
  const hashFrom = 160 - 30;
  const nominal = hotBody(rows, 0, 0, hashFrom, 7);
  assert.ok(nominal.length > 1_900_000, `fixture must overflow (is ${nominal.length})`);
  const fit = fitHot(rows, 0, 0, hashFrom, 7, 1_900_000);
  assert.ok(fit.body.length <= 1_900_000);
  assert.ok(fit.hotFrom > 0 && fit.trimmed);
  const parsed = JSON.parse(fit.body) as { cur: number; clears: Record<string, { e: number }[]>; books: { m: string; e: number }[] };
  assert.equal(parsed.cur, 7);
  assert.equal(Math.max(...parsed.books.map((b) => b.e)), 159, 'newest epoch kept');
  assert.equal(Math.min(...parsed.books.map((b) => b.e)), fit.hotFrom);
  assert.equal(Object.keys(parsed.clears).length, 0, 'these books have no clears');
  // a smaller overflow is fixed by dropping hashes alone
  const few = rows.filter((r) => r.epoch >= 100);
  const lite = fitHot(few, 0, 100, 130, 7, hotBody(few, 0, 100, Infinity, 7).length + 10);
  assert.equal(lite.hotFrom, 100); assert.ok(!lite.body.includes('"h"'));
});

test('fitHot: respects the snapshot book cap (16384) by raising hotFrom', () => {
  const rows: EpochRow[] = [];
  for (let e = 0; e < 300; e++) for (let m = 1; m <= 60; m++) rows.push({ market: mk(m), epoch: e, book_json: '{"m":"x","e":1,"fb":1,"lb":1,"o":[]}', lite_json: '{"m":"x","e":1,"fb":1,"lb":1,"o":[]}', clear_json: null });
  const fit = fitHot(rows, 0, 0, 0, 1);
  const n = (JSON.parse(fit.body) as { books: unknown[] }).books.length;
  assert.ok(n <= LIMITS.books && n >= LIMITS.books - 60, `books ${n}`);
  assert.ok(fit.hotFrom > 0);
});

test('graduate: re-running the same range is idempotent; an oversize cold part is cut to its newest points (ascending, within the cap)', () => {
  const rows = Array.from({ length: 100 }, (_, e) => row(mkBook(e)));
  const once = graduate(null, rows, 0, 100, FAKE_SCHEDULE);
  assert.equal(graduate(once, rows, 0, 100, FAKE_SCHEDULE), once, 'a clear already in cold is not added twice');
  // 40 markets x 1500 clears is far above 1.9 MB even after compaction
  const many: EpochRow[] = [];
  for (let e = 0; e < 1500; e++) for (let m = 1; m <= 40; m++) many.push(row(mkBook(e, mk(m))));
  const cut = graduate(null, many, 0, 1500, FAKE_SCHEDULE, 1_900_000);
  assert.ok(cut.length <= 1_900_000);
  const parsed = JSON.parse(cut) as Record<string, { e: number }[]>;
  assert.equal(Object.keys(parsed).length, 40);
  for (const list of Object.values(parsed)) { assert.ok(list.length > 0); assert.equal(list[list.length - 1].e, 1499); assert.ok(list.every((c, i, a) => i === 0 || a[i - 1].e < c.e)); }
});

test('rebuildParts reads the cursor (meta) before it reads any epoch row', async () => {
  const db = sqliteD1(MIGRATIONS);
  await db.batch(upsertBooks(db as any, [mkBook(1), mkBook(2)]) as any);
  await seedMeta(db, 1400, 1412);
  const order: string[] = [];
  const spy = { ...db, prepare: (sql: string) => { if (/FROM mk_meta/.test(sql)) order.push('meta'); else if (/FROM mk_epochs/.test(sql)) order.push('rows'); return db.prepare(sql); }, batch: db.batch };
  await rebuildParts(spy as any, 0, FAKE_SCHEDULE, FIXED_NOW_MS);
  assert.ok(order.indexOf('meta') >= 0 && order.indexOf('meta') < order.indexOf('rows'), order.join());
  assert.match((await getParts(db as any)).hot!.body, /^\{"cur":1399,/);
});

test('readRows paginates past the 16385-row page: no silent cut of the newest epochs', async () => {
  const db = sqliteD1(MIGRATIONS);
  const books: CoreBook[] = [];
  for (let e = 0; e < 400; e++) for (let m = 1; m <= 50; m++) books.push({ market: mk(m), epoch: e, firstBlock: 1, lastBlock: 1, orders: [] });
  await db.batch(upsertBooks(db as any, books) as any);
  assert.equal((await rowsFrom(db as any, 0)).length, 16_385, 'the raw query is cut at its limit');
  const rows = await readRows(db as any, 0);
  assert.equal(rows.length, 20_000);
  assert.equal(rows[rows.length - 1].epoch, 399);
  assert.ok(rows.every((r, i, a) => i === 0 || a[i - 1].epoch < r.epoch || (a[i - 1].epoch === r.epoch && a[i - 1].market < r.market)));
});

// read-merge-write

test('read-merge-write: data already stored survives a re-read of the same logs and nothing is rewritten', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await catchUp(h);
    // a stored book carries an order that the logs of a re-read do not contain (e.g. read before a prune); a blind replace would drop it
    const target = (await rowsFrom(h.db as any, 0)).find((r) => JSON.parse(r.book_json).o.length > 0)!;
    const sb = JSON.parse(target.book_json) as import('../../src/lib/market-snap.ts').SnapBook;
    const extra = { i: 23, t: '0x' + '7'.repeat(40), h: '0x' + '8'.repeat(64) };
    assert.ok(!sb.o.some((o) => o.i === 23));
    sb.o.push(extra);
    const { fromSnapBook } = await import('../../src/lib/market-snap.ts');
    await h.db.batch(upsertBooks(h.db as any, [fromSnapBook(sb)]) as any);
    await metaUpdate(h.db as any, { next_block: DEPLOY, anchor_block: null, anchor_hash: null }).run();
    let written = 0; let s;
    do { s = await runMarketIngest(h.env, h.deps); written += s.books; h.tick(); } while (s.reason !== 'caught_up');
    assert.equal(written, 0, 'identical content is not rewritten');
    const after = (await rowsFrom(h.db as any, 0)).find((r) => r.market === target.market && r.epoch === target.epoch)!;
    assert.ok((JSON.parse(after.book_json) as typeof sb).o.some((o) => o.i === 23 && o.t === extra.t), 'stored order kept');
    const l = newLedger(); hydrate(l, (await snapshotOf(h))!);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
  } finally { await rpc.close(); }
});

// D1_VALUE_TOO_LARGE never wedges the cursor

test('writeBooks: a book that is too large is trimmed (fewer orders) or, if that cannot help, skipped; the others are written', async () => {
  const db = sqliteD1(MIGRATIONS);
  const hugeAt = (n: number) => (db2: any, books: CoreBook[]) => {
    if (books.some((b) => b.orders.length > n || b.epoch === 9)) throw new D1ValueTooLargeError('book', 5_000_000);
    return upsertBooks(db2, books);
  };
  const fat = bulkBook(1, M, 16); const thin = bulkBook(2, M, 2); const doomed = bulkBook(9, M, 1);
  const r = await writeBooks(db as any, [fat, thin, doomed], hugeAt(4));
  assert.deepEqual([r.trimmed, r.skipped], [1, 1]);
  await db.batch(r.statements as any);
  const rows = await rowsFrom(db as any, 0);
  assert.deepEqual(rows.map((x) => x.epoch), [1, 2]);
  assert.ok(JSON.parse(rows[0].book_json).o.length <= 4 && JSON.parse(rows[0].book_json).o.length > 0);
  assert.equal(JSON.parse(rows[0].book_json).o[0].i, 0, 'the lowest indexes are kept');
});

test('parts that cannot fit: the cursor still advances, the hot part is dropped (snapshot unavailable, not wrong), and the next run rebuilds it', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    const s = await runMarketIngest(h.env, h.deps, { partMaxBytes: 300 });
    assert.equal(s.reason, 'parts_unavailable'); assert.equal(s.code, 'D1_VALUE_TOO_LARGE');
    const meta = (await getMeta(h.db as any))!;
    assert.equal(meta.next_block - 1, s.cursor); assert.ok(s.cursor >= DEPLOY, 'cursor advanced');
    assert.equal((await getParts(h.db as any)).hot, null);
    assert.equal(await snapshotOf(h), null);
    const { s: last } = await catchUp(h);
    assert.equal(last.code, undefined);
    const l = newLedger(); hydrate(l, (await snapshotOf(h))!);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
  } finally { await rpc.close(); }
});

test('per-run caps: a run that would write too many books ingests a shorter block window and the rest follows', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    let capped = 0; let s; let runs = 0;
    do {
      s = await runMarketIngest(h.env, h.deps, { maxBooks: 4 }); runs++; h.tick();
      if (s.capped) { capped++; assert.ok(s.books <= 4, `${s.books} books in a capped run`); }
    } while (s.reason !== 'caught_up' && runs < 60);
    assert.ok(capped > 0, 'the cap was hit at least once');
    const l = newLedger(); hydrate(l, (await snapshotOf(h))!);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
    assert.deepEqual(fillRows(l, FAKE_SCHEDULE), fillRows(FULL, FAKE_SCHEDULE));
  } finally { await rpc.close(); }
});

test('logs per run never exceed MAX_LOGS_PER_RUN, log calls never exceed MAX_LOG_CALLS', async () => {
  const dense = Array.from({ length: 3 }, () => FX.logs).flat(); // duplicates are harmless to the merge and triple the density
  const rpc = await startFakeRpc({ logs: dense, head: HEAD }); const h = harness(rpc.url);
  try {
    let s; let runs = 0;
    do { s = await runMarketIngest(h.env, h.deps); runs++; h.tick(); assert.ok(s.logs <= MAX_LOGS_PER_RUN, `${s.logs} logs`); assert.ok(s.calls <= 1 + MAX_LOG_CALLS + 1); } while (s.reason !== 'caught_up' && runs < 40);
    assert.equal(s.reason, 'caught_up');
  } finally { await rpc.close(); }
});

// overlapping runs (lease)

const leaseOf = async (h: ReturnType<typeof harness>) => (await getMeta(h.db as any))!.lease_until;
const withoutLease = (m: MetaRow | null) => m && { ...m, lease_until: 0 };

test('two truly overlapping runs: the second returns busy and writes nothing; the first releases the lease; the next run goes on', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const h = harness(rpc.url, {}, async (i, init) => { await gate; return fetch(i, init); });
  try {
    const a = runMarketIngest(h.env, h.deps); // holds the lease, waits on its first request
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await leaseOf(h), h.now() + 120_000);
    const metaBefore = await getMeta(h.db as any); h.sql.length = 0;
    const b = await runMarketIngest(h.env, h.deps);
    assert.deepEqual([b.reason, b.ran, b.calls], ['busy', false, 0]);
    assert.deepEqual(await getMeta(h.db as any), metaBefore, 'nothing written by the busy run');
    assert.ok(!h.sql.some((q) => /mk_epochs|mk_snapshot/.test(q)), 'it did not even touch the rows');
    release(); const sa = await a;
    assert.equal(sa.code, undefined); assert.ok(sa.ran);
    assert.equal(await leaseOf(h), 0, 'released');
    h.tick(); assert.equal((await runMarketIngest(h.env, h.deps)).reason === 'busy', false);
  } finally { release(); await rpc.close(); }
});

test('two simultaneous runs: exactly one does the work and the end state equals a single run', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h1 = harness(rpc.url); const h2 = harness(rpc.url);
  try {
    await runMarketIngest(h1.env, h1.deps);
    const both = await Promise.all([runMarketIngest(h2.env, h2.deps), runMarketIngest(h2.env, h2.deps)]);
    assert.deepEqual(both.map((r) => r.reason === 'busy').sort(), [false, true]);
    assert.deepEqual(await rowsFrom(h2.db as any, 0), await rowsFrom(h1.db as any, 0));
    assert.deepEqual(withoutLease(await getMeta(h2.db as any)), withoutLease(await getMeta(h1.db as any)));
  } finally { await rpc.close(); }
});

test('a crashed run blocks the ingest for the lease time only (2 minutes)', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await runMarketIngest(h.env, h.deps);
    await h.db.prepare('UPDATE mk_meta SET lease_until = ?1').bind(h.now() + 120_000).run(); // the holder died without releasing
    assert.equal((await runMarketIngest(h.env, h.deps)).reason, 'busy');
    h.tick(119_999); assert.equal((await runMarketIngest(h.env, h.deps)).reason, 'busy');
    h.tick(1); const s = await runMarketIngest(h.env, h.deps);
    assert.notEqual(s.reason, 'busy'); assert.ok(s.ran);
    assert.equal(await leaseOf(h), 0);
  } finally { await rpc.close(); }
});

test('the lease is released when a run fails', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    const s = await runMarketIngest(h.env, { ...h.deps, fetch: async () => { throw new TypeError('down'); } });
    assert.equal(s.reason, 'error'); assert.equal(await leaseOf(h), 0);
  } finally { await rpc.close(); }
});

// RPC errors, config

test('a limit-class RPC error shrinks the log window within the run and the run still makes progress', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD, failGetLogs: 1 }); const h = harness(rpc.url);
  try {
    const s = await runMarketIngest(h.env, h.deps);
    assert.equal(s.code, undefined); assert.ok(s.ran);
    const [first] = rpc.logRanges; // the refused request (2000 blocks) is not recorded by the fake; the retry is
    assert.equal(rpc.calls.filter((c: string) => c === 'eth_getLogs').length, rpc.logRanges.length + 1, 'one request was refused');
    assert.equal(first[0], DEPLOY, 'the same start block is retried');
    assert.equal(first[1] - first[0] + 1, 1000, 'halved after the error');
    assert.ok(s.cursor >= first[1]);
    assert.ok(h.take().requests <= MAX_SUBREQUESTS);
  } finally { await rpc.close(); }
});

test('a range that is always too large: a dense log window is caught up with smaller windows; an impossible one fails with the short code and rpcCode, cursor untouched', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD, maxLogs: 120 }); // 2000 blocks near DEPLOY+50000 hold 182 logs
  const h = harness(rpc.url);
  try {
    const { s, runs } = await catchUp(h, 40);
    assert.equal(s.reason, 'caught_up', `ended after ${runs} runs`);
    assert.ok(rpc.logRanges.some(([a, b]) => b - a + 1 < 2000), 'a smaller window was tried');
    const l = newLedger(); hydrate(l, (await snapshotOf(h))!);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
  } finally { await rpc.close(); }
  const never = await startFakeRpc({ logs: FX.logs, head: HEAD, maxLogs: -1 }); const h2 = harness(never.url);
  try {
    const s = await runMarketIngest(h2.env, h2.deps);
    assert.deepEqual([s.reason, s.code, s.rpcCode], ['error', 'RPC_ERROR', -32005]);
    assert.ok(h2.take().requests <= MAX_SUBREQUESTS);
    assert.equal((await getMeta(h2.db as any))!.next_block, DEPLOY);
  } finally { await never.close(); }
});

test('parseSchedule decodes 32-byte words with BigInt and rejects values above 2^53 - 1', () => {
  const w = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
  const ok = [1790958692n, 45n, 20n, 35n, 2000000n].map(w);
  assert.deepEqual(parseSchedule(ok), FAKE_SCHEDULE);
  assert.equal(parseSchedule([w(1n << 60n), ...ok.slice(1)]), null, 'beyond hexInt AND beyond a safe integer');
  assert.equal(parseSchedule([w((1n << 53n) - 1n), ...ok.slice(1)])?.t0, Number.MAX_SAFE_INTEGER);
  assert.equal(parseSchedule([w(1n << 53n), ...ok.slice(1)]), null);
  assert.equal(parseSchedule([ok[0], '0x2d', ...ok.slice(2)]), null, 'not a 32-byte word');
  assert.equal(parseSchedule([ok[0], w(0n), ...ok.slice(2)]), null, 'epochLen 0');
  assert.equal(parseSchedule([ok[0], ok[1], w(40n), ok[3], ok[4]]), null, 'commitEnd >= revealEnd');
  assert.equal(parseSchedule(ok.slice(0, 4)), null);
});

test('MARKET_RPC_URL must be https (explicit localhost / 127.0.0.1 http excepted); book, chain id and deploy block come from the vars only', async () => {
  const e = (o: Record<string, string>) => ({ MARKET_BOOK: BOOK, MARKET_CHAIN_ID: '46630', MARKET_DEPLOY_BLOCK: '100', ...o }) as any;
  assert.ok(marketTarget(e({ MARKET_RPC_URL: 'https://rpc.example.org/x' })));
  assert.ok(marketTarget(e({ MARKET_RPC_URL: 'http://127.0.0.1:8545' })));
  assert.ok(marketTarget(e({ MARKET_RPC_URL: 'http://localhost:8545' })));
  for (const bad of ['http://rpc.example.org', 'http://127.0.0.1.evil.example/', 'http://user@localhost.evil.com', 'ftp://x', 'rpc.example.org', 'javascript:1', '']) assert.equal(marketTarget(e({ MARKET_RPC_URL: bad })), null, bad);
  assert.equal(marketTarget(e({ MARKET_RPC_URL: 'https://r.example', MARKET_BOOK: 'nope' })), null);
  assert.equal(marketTarget(e({ MARKET_RPC_URL: 'https://r.example', MARKET_CHAIN_ID: '' })), null);
  assert.equal(marketTarget(e({ MARKET_RPC_URL: 'https://r.example', MARKET_DEPLOY_BLOCK: '0' })), null);
  const t = marketTarget(e({ MARKET_RPC_URL: 'https://r.example', MARKET_BOOK: '0x' + 'AB'.repeat(20), MARKET_CHAIN_ID: '7', MARKET_DEPLOY_BLOCK: '55' }))!;
  assert.deepEqual([t.book, t.chainId, t.deployBlock], ['0x' + 'ab'.repeat(20), 7, 55]);
  // an insecure URL is refused before any request or write
  const db = sqliteD1(MIGRATIONS); let calls = 0;
  const s = await runMarketIngest(baseEnv({ DB: db, MARKET_RPC_URL: 'http://rpc.example.org', MARKET_BOOK: BOOK, MARKET_CHAIN_ID: '46630', MARKET_DEPLOY_BLOCK: '100' }) as any, testDeps({ fetch: async () => { calls++; throw new Error('x'); } }) as any);
  assert.deepEqual([s.reason, s.code, calls], ['not_configured', 'RPC_URL_INSECURE', 0]);
  assert.equal(await getMeta(db as any), null);
});

test('the log filter uses the configured book address (lower-cased) and no market address or chain id is hard-coded in the ingest sources', async () => {
  const OTHER = '0x' + 'Cd'.repeat(20);
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const seen: string[] = [];
  const h = harness(rpc.url, { MARKET_BOOK: OTHER }, async (i, init) => { seen.push(String(init.body)); return fetch(i, init); });
  try {
    await runMarketIngest(h.env, h.deps);
    const logCalls = seen.flatMap((b) => JSON.parse(b) as { method: string; params: [{ address?: string; to?: string }] }[]).filter((c) => c.method === 'eth_getLogs' || c.method === 'eth_call');
    assert.ok(logCalls.length > 0);
    assert.ok(logCalls.every((c) => (c.params[0].address ?? c.params[0].to) === OTHER.toLowerCase()));
  } finally { await rpc.close(); }
  for (const f of ['ingest.ts', 'assemble.ts']) {
    const src = readFileSync(new URL('../market/' + f, import.meta.url), 'utf8');
    assert.ok(!/0x[0-9a-fA-F]{40}\b/.test(src), `${f}: no hard-coded address`);
    assert.ok(!/46630|127948000/.test(src), `${f}: no hard-coded chain id or deploy block`);
  }
});

// nothing from upstream is logged or returned

test('upstream bodies and messages never reach the summary or the console', async () => {
  const SECRET = 'UPSTREAM-SECRET-TEXT-9f3a';
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    const db = sqliteD1(MIGRATIONS);
    const mk500 = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    for (const f of [mk500({ error: { code: -32005, message: SECRET } }), mk500(SECRET, 500), mk500([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: SECRET } }]), async () => new Response(SECRET, { status: 200 })]) {
      const env = baseEnv({ DB: db, MARKET_RPC_URL: 'https://rpc.example.org', MARKET_BOOK: BOOK, MARKET_CHAIN_ID: '46630', MARKET_DEPLOY_BLOCK: String(DEPLOY) });
      const s = await runMarketIngest(env as any, testDeps({ fetch: f }) as any);
      assert.equal(s.reason, 'error');
      assert.match(String(s.code), /^[A-Z0-9_]{1,30}$/);
      assert.ok(!JSON.stringify(s).includes(SECRET));
    }
  } finally { Object.assign(console, orig); }
  assert.ok(!logged.join('\n').includes(SECRET));
});

test('the rpc is asked for the chain id and a wrong chain is refused before anything is written', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD, chainId: 1 }); const h = harness(rpc.url);
  try {
    const s = await runMarketIngest(h.env, h.deps);
    assert.deepEqual([s.reason, s.code], ['error', 'RPC_WRONG_CHAIN']);
    assert.equal((await getMeta(h.db as any))!.next_block, DEPLOY);
    assert.equal((await getMeta(h.db as any))!.head_block, 0);
  } finally { await rpc.close(); }
  // an existing deployment is not wiped by a node that answers for another chain
  const good = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h2 = harness(good.url);
  try {
    await catchUp(h2);
    const rows = JSON.stringify(await rowsFrom(h2.db as any, 0)); const meta = await getMeta(h2.db as any);
    const bad = await startFakeRpc({ logs: FX.logs, head: HEAD, chainId: 1 });
    try {
      const s = await runMarketIngest({ ...h2.env, MARKET_RPC_URL: bad.url, MARKET_DEPLOY_BLOCK: String(DEPLOY + 5) }, h2.deps);
      assert.deepEqual([s.reason, s.code], ['error', 'RPC_WRONG_CHAIN']);
    } finally { await bad.close(); }
    assert.equal(JSON.stringify(await rowsFrom(h2.db as any, 0)), rows);
    assert.deepEqual(await getMeta(h2.db as any), meta);
  } finally { await good.close(); }
});

// CPU / D1 reads

test('constants: the per-run book cap is sized for the 10 ms CPU budget, the overlap covers a lagging getLogs node', () => {
  assert.equal(MAX_BOOKS_PER_RUN, 100);
  assert.equal(OVERLAP_BLOCKS, 256);
});

test('rebuildParts reads only the column each row ships (CASE per band), never "SELECT book_json, lite_json, clear_json" for the whole window', async () => {
  const db = sqliteD1(MIGRATIONS);
  await db.batch(upsertBooks(db as any, Array.from({ length: 400 }, (_, e) => mkBook(e))) as any);
  await seedMeta(db, 1400, 1412);
  const seen: string[] = [];
  const spy = { ...db, prepare: (sql: string) => { seen.push(sql); return db.prepare(sql); }, batch: db.batch };
  await rebuildParts(spy as any, 0, FAKE_SCHEDULE, FIXED_NOW_MS);
  const q = seen.filter((x) => /FROM mk_epochs WHERE epoch >= /.test(x));
  assert.equal(q.length, 1, 'one page');
  assert.match(q[0], /CASE WHEN epoch >= \?3 THEN book_json/);
  assert.match(q[0], /CASE WHEN epoch >= \?4 AND epoch < \?3 THEN lite_json/);
  assert.match(q[0], /CASE WHEN epoch < \?4 THEN clear_json/);
  assert.ok(!seen.some((x) => /SELECT market, epoch, book_json, lite_json, clear_json/.test(x)), 'the full-column query is not used when the window fits');
});

test('a capped run folds the stored books once (no re-parse of every stored book per halving)', async () => {
  const parses = async (caps: { maxBooks?: number }) => {
    const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
    try {
      await catchUp(h);
      await metaUpdate(h.db as any, { next_block: DEPLOY, anchor_block: null, anchor_hash: null }).run(); // re-read the busy start: every book is stored already
      const real = JSON.parse; let n = 0;
      JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { n++; return real(...a); }) as typeof JSON.parse;
      try { const s = await runMarketIngest(h.env, h.deps, caps); return { n, capped: s.capped }; } finally { JSON.parse = real; }
    } finally { await rpc.close(); }
  };
  const open = await parses({}); const capped = await parses({ maxBooks: 3 });
  assert.equal(open.capped, false); assert.equal(capped.capped, true);
  assert.ok(capped.n <= open.n, `capped run parsed ${capped.n} JSON texts, an uncapped run ${open.n}`);
});

// writeBooks: only the offender is split out

test('writeBooks: one oversized book does not turn the run into per-book statements', async () => {
  const db = sqliteD1(MIGRATIONS);
  const stub = (db2: any, books: CoreBook[]) => { if (books.some((b) => b.orders.length > 4)) throw new D1ValueTooLargeError('book', 5_000_000); return upsertBooks(db2, books); };
  const books = [...Array.from({ length: 150 }, (_, e) => bulkBook(e + 10, M, 2)), bulkBook(1, M, 16)];
  const r = await writeBooks(db as any, books, stub);
  assert.deepEqual([r.trimmed, r.skipped], [1, 0]);
  assert.ok(r.statements.length <= 3, `${r.statements.length} statements: 150 thin books in 2 chunks + the trimmed one`);
  await db.batch(r.statements as any);
  assert.equal((await rowsFrom(db as any, 0)).length, 151);
});

// graduation, hot window, purge, recovery

const gradBook = (e: number, m: string): CoreBook => ({ market: m, epoch: e, firstBlock: 1000 + e, lastBlock: 1000 + e, orders: [{ index: 0, trader: '0x' + '1'.repeat(40), hash: '0x' + '2'.repeat(64), side: 0, price: 100 + (e % 7), units: 3, filled: e % 3 ? 3 : 0 }], clear: { price: 100 + (e % 7), volume: e % 3 ? 3 : 0, buys: 1, sells: 1, forfeited: 0, tx: mk(e + 1), block: 1000 + e } });
for (const [label, END, STEP] of [['steady 400 epochs', 400, 7], ['long 2000 epochs', 2000, 13]] as const) {
  test(`incremental graduation (${label}): rebuilding as epochs arrive ships every epoch's clear exactly once`, async () => {
    const db = sqliteD1(MIGRATIONS); const MK = [mk(1), mk(2)];
    await seedMeta(db, 99_999, 99_999);
    let done = 0; let checks = 0;
    for (let upto = STEP; upto <= END; upto += STEP) {
      const books: CoreBook[] = []; for (let e = done; e < upto; e++) for (const m of MK) books.push(gradBook(e, m));
      await db.batch(upsertBooks(db as any, books) as any); done = upto;
      const meta = (await getMeta(db as any))!;
      await rebuildParts(db as any, meta.cold_until, FAKE_SCHEDULE, FIXED_NOW_MS, { cursor: 99_998 });
      const s = validateSnapshot(JSON.parse(snapshotBody((await getMeta(db as any))!, await getParts(db as any), FIXED_NOW_MS)!), { chainId: 46630, book: BOOK.toLowerCase(), deployBlock: 1000 })!;
      assert.ok(s, 'valid at ' + upto);
      const l = newLedger(); hydrate(l, s);
      let trades = 0, vol = 0; for (let e = 0; e < upto; e++) if (e % 3) { trades++; vol += 3; }
      for (const m of MK) {
        const pts = clearPoints(l)[m]; const st = rangeStats(pts);
        assert.equal(pts.reduce((a, p) => a + (p.n ?? 1), 0), upto, `epochs represented at ${upto}`);
        assert.equal(st.trades, trades); assert.equal(st.volume, vol);
      }
      checks++;
    }
    assert.ok(checks > 10);
  });
}

test('clears of epochs between the cold boundary and the hot window travel in hot.clears until they graduate', async () => {
  const db = sqliteD1(MIGRATIONS);
  await db.batch(upsertBooks(db as any, Array.from({ length: 200 }, (_, e) => gradBook(e, M))) as any);
  await seedMeta(db, 1400, 1412);
  const r = await rebuildParts(db as any, 0, FAKE_SCHEDULE, FIXED_NOW_MS);
  assert.deepEqual(r, { rebuilt: true, graduated: false }, '40 epochs left the hot window: fewer than GRADUATE_EPOCHS');
  const snap = validateSnapshot(JSON.parse(snapshotBody((await getMeta(db as any))!, await getParts(db as any), FIXED_NOW_MS)!), { chainId: 46630, book: BOOK.toLowerCase(), deployBlock: 1000 })!;
  assert.deepEqual(Object.keys(snap.cold), []);
  assert.deepEqual(snap.hot.clears[M].map((c) => c.e), Array.from({ length: 40 }, (_, e) => e));
  assert.equal(snap.hot.books.length, HOT_EPOCHS);
  const l = newLedger(); hydrate(l, snap); assert.equal(clearPoints(l)[M].length, 200);
});

test('purge: rows older than hotFrom - RETAIN_EPOCHS are deleted when clears graduate, newer ones stay', async () => {
  const db = sqliteD1(MIGRATIONS);
  const N = RETAIN_EPOCHS + 260;
  await db.batch(upsertBooks(db as any, Array.from({ length: N }, (_, e) => gradBook(e, M))) as any);
  await seedMeta(db, 90_000, 90_012);
  const r = await rebuildParts(db as any, 0, FAKE_SCHEDULE, FIXED_NOW_MS);
  assert.equal(r.graduated, true);
  const hotFrom = N - 1 - HOT_EPOCHS + 1; const keepFrom = hotFrom - RETAIN_EPOCHS;
  const epochs = (await rowsFrom(db as any, 0)).map((x) => x.epoch);
  assert.equal(epochs[0], keepFrom); assert.equal(epochs.length, N - keepFrom);
  assert.equal((await getMeta(db as any))!.cold_until, hotFrom);
});

test('after parts_unavailable, the next run with NO new blocks and no changed book rebuilds the hot part', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    let s; let runs = 0;
    do { s = await runMarketIngest(h.env, h.deps, { partMaxBytes: 300 }); runs++; h.tick(); } while (s.reason !== 'caught_up' && runs < 30);
    assert.equal((await getParts(h.db as any)).hot, null); assert.equal(await snapshotOf(h), null);
    const next = await runMarketIngest(h.env, h.deps); // same head, nothing new
    assert.equal(next.books, 0); assert.equal(next.rebuilt, true);
    const l = newLedger(); hydrate(l, (await snapshotOf(h))!);
    assert.deepEqual(clearPoints(l), clearPoints(FULL));
  } finally { await rpc.close(); }
});

test('acquireLease is ONE conditional UPDATE (plus the INSERT OR IGNORE of the placeholder): no SELECT, taken only when changes === 1', async () => {
  const db = sqliteD1(MIGRATIONS); const sql: string[] = [];
  const spy = { ...db, prepare: (q: string) => { sql.push(q.replace(/\s+/g, ' ').trim()); return db.prepare(q); }, batch: db.batch };
  const T = { rpc: 'https://r.example', book: BOOK.toLowerCase(), chainId: 46630, deployBlock: DEPLOY };
  assert.ok(await acquireLease(spy as any, T, 1000));
  assert.equal(sql.length, 2);
  assert.match(sql[0], /^INSERT OR IGNORE INTO mk_meta /);
  assert.equal(sql[1], 'UPDATE mk_meta SET lease_until = ?1 WHERE id = 1 AND lease_until <= ?2');
  assert.ok(!sql.some((q) => /^SELECT/i.test(q)));
  assert.equal(await acquireLease(spy as any, T, 1001), null);
});

test('a missing meta row never makes leftover market rows look current: they are wiped on that path', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await h.db.batch(upsertBooks(h.db as any, [mkBook(5), mkBook(6)]) as any); // rows without any meta row (e.g. a restored table)
    await h.db.prepare(`INSERT INTO mk_snapshot (part, body, built_at) VALUES ('hot', '{"cur":1,"clears":{},"books":[]}', 1)`).run();
    const s = await runMarketIngest(h.env, h.deps);
    assert.equal(s.code, undefined);
    assert.ok(!(await rowsFrom(h.db as any, 0)).some((r) => r.market === M), 'the leftover rows are gone');
    assert.ok(!(await getParts(h.db as any)).hot || !(await getParts(h.db as any)).hot!.body.includes('"cur":1,'));
  } finally { await rpc.close(); }
});

test('after parts_unavailable, new EMPTY blocks alone (no changed book) rebuild the parts on the main path', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    let s; let runs = 0;
    do { s = await runMarketIngest(h.env, h.deps, { partMaxBytes: 300 }); runs++; h.tick(); } while (s.reason !== 'caught_up' && runs < 30);
    assert.equal((await getParts(h.db as any)).hot, null);
    rpc.setHead(HEAD + 40);
    const next = await runMarketIngest(h.env, h.deps);
    assert.deepEqual([next.books, next.rebuilt, next.reason], [0, true, 'caught_up']);
    assert.ok(await snapshotOf(h));
  } finally { await rpc.close(); }
});

test('over-cap fallback reads only the columns fitHot still needs: less than a second full read, same result as fitHot on full rows', async () => {
  const db = sqliteD1(MIGRATIONS); const MKS = Array.from({ length: 12 }, (_, i) => mk(i + 1));
  const books: CoreBook[] = []; for (let e = 0; e < 200; e++) for (const m of MKS) books.push({ ...bulkBook(e, m, 24), clear: { price: 100, volume: 3, buys: 1, sells: 1, forfeited: 0, tx: mk(e + 7), block: 1000 + e } });
  await db.batch(upsertBooks(db as any, books) as any);
  await seedMeta(db, 5000, 5012);
  let chars = 0; const spy = { ...db, prepare: (q: string) => { const st = db.prepare(q); return { ...st, bind: (...v: unknown[]) => { const b = st.bind(...v); return { ...b, all: async () => { const r = await b.all(); if (/FROM mk_epochs WHERE epoch >=/.test(q)) chars += JSON.stringify(r.results).length; return r; } }; } }; }, batch: db.batch };
  const cap = 1_900_000;
  await rebuildParts(spy as any, 0, FAKE_SCHEDULE, FIXED_NOW_MS, { cursor: 4999 });
  const full = await rowsFrom(db as any, 0);
  assert.ok(chars < JSON.stringify(full).length, `read ${chars} chars, one full read is ${JSON.stringify(full).length}`);
  const hot = (await getParts(db as any)).hot!.body;
  assert.ok(hot.length <= cap);
  const want = fitHot(full, 0, 199 - HOT_EPOCHS + 1, 199 - 30 + 1, 4999, cap);
  assert.equal(hot, want.body, 'identical to fitHot on all columns');
});
