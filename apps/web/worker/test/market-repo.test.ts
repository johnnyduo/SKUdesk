import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CoreBook } from '../../src/lib/market-core.ts';
import { LEASE_MS, acquireLease, releaseLease, bookJson, deleteFromBlock, getMeta, loadBooks, maxEpoch, metaUpdate, putPart, resetMarket, rewindStart, rowsFrom, upsertBooks, UPSERT_CHUNK } from '../market/repo.ts';
import { sqliteD1 } from './helpers/d1.ts';

const MIGRATIONS = ['0001_init.sql', '0002_market.sql'].map((f) => new URL('../migrations/' + f, import.meta.url).pathname);
const M = '0x' + 'a'.repeat(64); const T = { rpc: 'https://rpc.test', book: '0x2BA62631d74827aBF2f7467B20370dC2DC59aa11', chainId: 46630, deployBlock: 100 };
const book = (epoch: number, fb: number, lb: number, filled?: number): CoreBook => ({ market: M, epoch, firstBlock: fb, lastBlock: lb, orders: [{ index: 0, trader: '0x' + '1'.repeat(40), hash: '0x' + '2'.repeat(64), side: 0, price: 10, units: 3, ...(filled ? { filled } : {}) }] });

test('resetMarket writes a fresh meta row (lower-case book, cursor at the deploy block) and clears market rows', async () => {
  const db = sqliteD1(MIGRATIONS);
  await db.batch(upsertBooks(db as any, [book(1, 100, 101)]) as any);
  const meta = await resetMarket(db as any, T, 1, 5);
  assert.deepEqual([meta.schema_version, meta.book, meta.next_block, meta.anchor_block, meta.schedule_json, meta.cold_until, meta.updated_at], [1, T.book.toLowerCase(), 100, null, null, 0, 5]);
  assert.equal(await maxEpoch(db as any), null);
  await metaUpdate(db as any, { next_block: 150, anchor_hash: '0xabc', anchor_block: 149 }).run();
  assert.deepEqual([(await getMeta(db as any))!.next_block, (await getMeta(db as any))!.anchor_hash], [150, '0xabc']);
});

test('upsertBooks / loadBooks round-trip through json_each, many rows per statement, updates in place', async () => {
  const db = sqliteD1(MIGRATIONS);
  const books = Array.from({ length: UPSERT_CHUNK + 30 }, (_, i) => book(i, 100 + i, 100 + i));
  const stmts = upsertBooks(db as any, books); assert.equal(stmts.length, 2);
  await db.batch(stmts as any);
  const keys = [{ m: M, e: 3 }, { m: M, e: 120 }, { m: M, e: 999 }];
  const got = await loadBooks(db as any, keys);
  assert.deepEqual(got.map((g) => g.book.epoch).sort((a, b) => a - b), [3, 120]);
  assert.equal(got[0].json, bookJson(got[0].book), 'stored JSON is the canonical serialization (change detection relies on it)');
  await db.batch(upsertBooks(db as any, [book(3, 103, 110, 3)]) as any);
  const [b3] = await loadBooks(db as any, [{ m: M, e: 3 }]);
  assert.deepEqual([b3.book.lastBlock, b3.book.orders[0].filled], [110, 3]);
  assert.equal(await maxEpoch(db as any), UPSERT_CHUNK + 29);
  assert.deepEqual((await rowsFrom(db as any, UPSERT_CHUNK + 28)).map((r) => r.epoch), [UPSERT_CHUNK + 28, UPSERT_CHUNK + 29]);
});

test('rewindStart finds the first block of every book touched at or after the rewind point; deleteFromBlock drops exactly those', async () => {
  const db = sqliteD1(MIGRATIONS);
  await db.batch(upsertBooks(db as any, [book(1, 100, 120), book(2, 130, 210), book(3, 205, 260)]) as any);
  assert.equal(await rewindStart(db as any, 200), 130);
  assert.equal(await rewindStart(db as any, 300), 300);
  await deleteFromBlock(db as any, 200).run();
  assert.deepEqual((await rowsFrom(db as any, 0)).map((r) => r.epoch), [1]);
});

test('a failing statement rolls back the whole batch (books and cursor move together or not at all)', async () => {
  const db = sqliteD1(MIGRATIONS); await resetMarket(db as any, T, 1, 1);
  await assert.rejects(db.batch([...upsertBooks(db as any, [book(1, 100, 101)]), metaUpdate(db as any, { next_block: 500 }), db.prepare('INSERT INTO nope VALUES (1)')] as any));
  assert.equal(await maxEpoch(db as any), null); assert.equal((await getMeta(db as any))!.next_block, 100);
});

const bigBook = (epoch: number, bytes: number): CoreBook => {
  const b = book(epoch, 100 + epoch, 100 + epoch); b.orders[0].trader = '0x' + 'e'.repeat(Math.max(0, bytes)); return b;
};
const countChanges = async (db: any, stmts: any[]) => (await db.batch(stmts)).reduce((n: number, r: any) => n + r.meta.changes, 0);

test('D1 size limits: chunks close on cumulative bytes, none above the limit; an oversize book/part throws D1_VALUE_TOO_LARGE before touching the DB', async () => {
  const db = sqliteD1(MIGRATIONS); await resetMarket(db as any, T, 1, 1);
  const books = Array.from({ length: 100 }, (_, i) => bigBook(i, 100_000)); // ~200 KB each (book + lite), 100 of them
  const stmts = upsertBooks(db as any, books);
  assert.ok(stmts.length >= 10, 'split by bytes, not only by count: ' + stmts.length);
  await db.batch(stmts as any); // the fake rejects any bound value > 2,000,000 bytes (SQLITE_TOOBIG), so success proves every chunk is within it
  assert.equal((await rowsFrom(db as any, 0, 1000)).length, 100);
  // one book of ~1.5 MB (book + lite ~3 MB would be too much; use ~0.6 MB raw => ~1.2+ MB with lite) must still be written alone
  const alone = upsertBooks(db as any, [bigBook(500, 700_000), bigBook(501, 10)]);
  assert.equal(alone.length, 2); await db.batch(alone as any);
  const before = await maxEpoch(db as any);
  assert.throws(() => upsertBooks(db as any, [book(900, 1, 1), bigBook(901, 1_500_000)]), (e: any) => e.code === 'D1_VALUE_TOO_LARGE' && /D1_VALUE_TOO_LARGE/.test(e.message) && e.message.includes('901') && !e.message.includes('eeee'));
  assert.equal(await maxEpoch(db as any), before, 'nothing written');
  assert.throws(() => putPart(db as any, 'hot', 'x'.repeat(1_950_000), 1), (e: any) => e.code === 'D1_VALUE_TOO_LARGE');
  assert.throws(() => putPart(db as any, 'hot', '\u20ac'.repeat(700_000), 1), (e: any) => e.code === 'D1_VALUE_TOO_LARGE', 'bytes, not characters (3 bytes each)');
  await putPart(db as any, 'hot', 'x'.repeat(1_800_000), 1).run();
  assert.equal((await getMeta(db as any))!.next_block, 100, 'cursor unchanged');
});

test('the sqlite fake enforces the D1 value and statement limits (SQLITE_TOOBIG)', async () => {
  const db = sqliteD1(MIGRATIONS);
  await assert.rejects(db.prepare('INSERT INTO mk_snapshot (part, body, built_at) VALUES (?1, ?2, 1)').bind('hot', 'x'.repeat(2_000_001)).run(), /SQLITE_TOOBIG/);
  await assert.rejects(db.prepare('SELECT ?1').bind('\u20ac'.repeat(700_000)).all(), /SQLITE_TOOBIG/);
  await assert.rejects(db.prepare('SELECT 1 /*' + ' '.repeat(100_001) + '*/').first(), /SQLITE_TOOBIG/);
  await db.prepare('INSERT INTO mk_snapshot (part, body, built_at) VALUES (?1, ?2, 1)').bind('hot', 'x'.repeat(2_000_000)).run();
});

test('both rewind queries use idx_mk_epochs_last, not a table scan', async () => {
  const db = sqliteD1(MIGRATIONS);
  await db.batch(upsertBooks(db as any, Array.from({ length: 50 }, (_, i) => book(i, 100 + i * 10, 105 + i * 10))) as any);
  const seen: string[] = [];
  const spy = { prepare: (sql: string) => { seen.push(sql); return db.prepare(sql); }, batch: db.batch };
  await rewindStart(spy as any, 300); deleteFromBlock(spy as any, 300);
  assert.equal(seen.length, 2);
  for (const sql of seen) {
    const plan = (await db.prepare('EXPLAIN QUERY PLAN ' + sql).bind(300).all<{ detail: string }>()).results.map((r) => r.detail).join(' | ');
    assert.match(plan, /idx_mk_epochs_last/, plan);
    assert.doesNotMatch(plan, /SCAN mk_epochs(?! USING)/, plan);
  }
});

test('re-upserting an identical book is a true no-op (0 changes, one row); a changed one reports 1', async () => {
  const db = sqliteD1(MIGRATIONS);
  assert.equal(await countChanges(db, upsertBooks(db as any, [book(1, 100, 101)])), 1);
  assert.equal(await countChanges(db, upsertBooks(db as any, [book(1, 100, 101)])), 0);
  assert.equal(await countChanges(db, upsertBooks(db as any, [book(1, 100, 101, 2)])), 1);
  assert.equal((await rowsFrom(db as any, 0)).length, 1);
  assert.equal(await countChanges(db, upsertBooks(db as any, [{ ...book(1, 100, 101, 2), clear: { price: 1, volume: 1, buys: 1, sells: 1, forfeited: 0, tx: '0x1', block: 101 } }])), 1);
});

test('market ids are normalized to lower case at the repo boundary', async () => {
  const db = sqliteD1(MIGRATIONS);
  const upper = '0x' + 'A'.repeat(64);
  await db.batch(upsertBooks(db as any, [{ ...book(1, 100, 101), market: upper }]) as any);
  assert.equal(await countChanges(db, upsertBooks(db as any, [book(1, 100, 101)])), 0, 'same row, same canonical json');
  assert.equal((await rowsFrom(db as any, 0)).length, 1);
  const [a] = await loadBooks(db as any, [{ m: upper, e: 1 }]); const [b] = await loadBooks(db as any, [{ m: M, e: 1 }]);
  assert.equal(a.book.market, M); assert.equal(b.book.market, M);
  assert.equal(bookJson({ ...book(1, 100, 101), market: upper }), bookJson(book(1, 100, 101)));
});

test('metaUpdate: null resets a column, an empty patch is a harmless no-op', async () => {
  const db = sqliteD1(MIGRATIONS); await resetMarket(db as any, T, 1, 1);
  await metaUpdate(db as any, { anchor_block: 149, anchor_hash: '0xabc', next_block: 150 }).run();
  await metaUpdate(db as any, { anchor_block: null, anchor_hash: null }).run();
  const m = (await getMeta(db as any))!; assert.deepEqual([m.anchor_block, m.anchor_hash, m.next_block], [null, null, 150]);
  const r = await metaUpdate(db as any, {}).run(); assert.equal(r.meta.changes, 1);
  assert.deepEqual((await getMeta(db as any)), m);
});

test('a runtime constraint failure (not just a missing table) rolls the batch back', async () => {
  const db = sqliteD1(MIGRATIONS); await resetMarket(db as any, T, 1, 1);
  await assert.rejects(db.batch([...upsertBooks(db as any, [book(1, 100, 101)]), metaUpdate(db as any, { next_block: 500 }), db.prepare("INSERT INTO mk_snapshot (part, body, built_at) VALUES ('bogus', 'x', 1)")] as any), /CHECK|constraint/i);
  assert.equal(await maxEpoch(db as any), null); assert.equal((await getMeta(db as any))!.next_block, 100);
});

test('rowsFrom is bounded by a LIMIT, ordered by epoch then market', async () => {
  const db = sqliteD1(MIGRATIONS);
  await db.batch(upsertBooks(db as any, [book(1, 1, 1), book(2, 2, 2), book(3, 3, 3)]) as any);
  assert.deepEqual((await rowsFrom(db as any, 0, 2)).map((r) => r.epoch), [1, 2]);
  assert.equal((await rowsFrom(db as any, 0)).length, 3);
});

test('acquireLease: creates the meta row on the very first run, refuses while held, takes over after expiry, release only frees its own lease', async () => {
  const db = sqliteD1(MIGRATIONS);
  const a = await acquireLease(db as any, T, 1_000);
  assert.equal(a, 1_000 + LEASE_MS);
  assert.equal((await getMeta(db as any))!.next_block, T.deployBlock, 'placeholder row at the deploy block');
  assert.equal(await acquireLease(db as any, T, 1_000 + LEASE_MS - 1), null, 'still held');
  assert.equal(await acquireLease(db as any, T, 1_000), null, 'same instant');
  const b = await acquireLease(db as any, T, 1_000 + LEASE_MS);
  assert.equal(b, 1_000 + 2 * LEASE_MS, 'expired lease is taken over');
  await releaseLease(db as any, a!); // the old holder finishing late must not free the new holder's lease
  assert.equal((await getMeta(db as any))!.lease_until, b);
  await releaseLease(db as any, b!);
  assert.equal((await getMeta(db as any))!.lease_until, 0);
  assert.ok(await acquireLease(db as any, T, 1_001));
});

test('resetMarket keeps the lease of the run that calls it', async () => {
  const db = sqliteD1(MIGRATIONS);
  const until = await acquireLease(db as any, T, 5_000);
  const meta = await resetMarket(db as any, { ...T, deployBlock: 300 }, 1, 6_000);
  assert.deepEqual([meta.deploy_block, meta.next_block, meta.lease_until], [300, 300, until]);
});

test('rowsFrom with a window selects only the column each row needs: book_json from hashFrom, lite_json from hotFrom, clear_json below hotFrom', async () => {
  const db = sqliteD1(MIGRATIONS); await resetMarket(db as any, T, 1, 1);
  await db.batch(upsertBooks(db as any, [1, 5, 9].map((e) => ({ ...book(e, 100, 100), clear: { price: 10, volume: 3, buys: 1, sells: 1, forfeited: 0, tx: '0x' + '3'.repeat(64), block: 100 } })) as any) as any);
  const rows = await rowsFrom(db as any, 0, undefined, { hotFrom: 5, hashFrom: 9 });
  const show = (r: (typeof rows)[number]) => [r.epoch, r.book_json !== '', r.lite_json !== '', r.clear_json !== null];
  assert.deepEqual(rows.map(show), [[1, false, false, true], [5, false, true, false], [9, true, false, false]]);
  const full = await rowsFrom(db as any, 0);
  assert.ok(full.every((r) => r.book_json && r.lite_json), 'without a window: every column, as before');
});
