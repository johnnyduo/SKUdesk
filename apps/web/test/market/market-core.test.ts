// node --test test/market/market-core.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHANGE_WINDOW, TOPICS, applyEvents, changeWindow, clearPoints, decodeLog, decodeLogs, fillRows, liveBooks, newLedger, rangeStats, summarize, traderOrder, type ClearPoint, type Ledger, type MarketEvent, type RawLog } from '../../src/lib/market-core.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
const HERO = '0x874760df68911be9e368727c9d7c69bb3a9fc9c8845563c7febbc10a8bb4550e';
const SCHED = { t0: 1759400000, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2_000_000 };

// Canonical text of a ledger (map entries and object keys sorted), so ledgers built in different orders compare exactly.
const sortKeys = (_k: string, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
function canon(l: Ledger): string {
  const books = [...l.books.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const clears = [...l.clears.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([m, byE]) => [m, [...byE.entries()].sort((a, b) => a[0] - b[0])]);
  return JSON.stringify({ books, clears }, sortKeys);
}
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('topic constants are the keccak of the BlindBook event signatures (pinned against viem)', async () => {
  const { toEventSelector } = await import('viem');
  assert.equal(TOPICS.commit, toEventSelector('Committed(bytes32,uint256,uint256,address,bytes32)'));
  assert.equal(TOPICS.reveal, toEventSelector('Revealed(bytes32,uint256,uint256,address,uint8,uint256,uint256)'));
  assert.equal(TOPICS.fill, toEventSelector('Fill(bytes32,uint256,uint256,address,uint8,uint256,uint256)'));
  assert.equal(TOPICS.clear, toEventSelector('EpochCleared(bytes32,uint256,uint256,uint256,uint256,uint256,uint256)'));
});

test('decodes the captured chain logs: four event kinds, MarketListed ignored, chain order', () => {
  assert.equal(FX.logs.length, 235);
  const ev = decodeLogs(FX.logs);
  const kinds: Record<string, number> = {};
  for (const e of ev) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  assert.deepEqual(kinds, { commit: 91, reveal: 76, fill: 48, clear: 18 });
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i - 1].block < ev[i].block || (ev[i - 1].block === ev[i].block && ev[i - 1].logIndex < ev[i].logIndex));
  const c = ev.find((e) => e.kind === 'clear' && e.market === HERO && e.epoch === 1136);
  assert.deepEqual(c && { price: (c as any).price, volume: (c as any).volume, buys: (c as any).buys, sells: (c as any).sells, forfeited: (c as any).forfeited }, { price: 1111, volume: 9, buys: 2, sells: 2, forfeited: 1 });
});

test('decodeLog rejects removed, unknown, truncated, out-of-range and malformed logs', () => {
  const good = FX.logs.find((l) => l.topics[0] === TOPICS.reveal)!;
  assert.ok(decodeLog(good));
  assert.equal(decodeLog({ ...good, removed: true }), null);
  assert.equal(decodeLog({ ...good, topics: ['0x' + 'ab'.repeat(32), ...good.topics.slice(1)] }), null);
  assert.equal(decodeLog({ ...good, data: good.data.slice(0, 2 + 64 * 3) }), null);
  assert.equal(decodeLog({ ...good, data: good.data.slice(0, 66) + '0'.repeat(63) + '2' + good.data.slice(130) }), null, 'side must be 0 or 1');
  assert.equal(decodeLog({ ...good, data: good.data.slice(0, 130) + 'f'.repeat(64) + good.data.slice(194) }), null, 'a price beyond 2^52 is refused, not rounded');
  assert.equal(decodeLog({ ...good, blockNumber: 'latest' }), null);
  assert.equal(decodeLog({ ...good, transactionHash: '0x12' }), null);
  assert.equal(decodeLog({ ...good, topics: good.topics.slice(0, 3) }), null, 'trader topic required');
  assert.equal(decodeLog(null as unknown as RawLog), null);
});

test('ledger from the fixture: books, a forfeited order, a partial fill, fills priced at the clear', () => {
  const l = newLedger(); applyEvents(l, decodeLogs(FX.logs), SCHED);
  assert.equal(l.books.size, 18);
  const b = l.books.get(`${HERO}:1136`)!;
  assert.deepEqual(b.orders.map((o) => o.index), [0, 1, 2, 3, 4]);
  assert.equal(b.orders[3].price, undefined, 'order 3 was never revealed (its bond was forfeited)');
  assert.deepEqual([b.orders[1].units, b.orders[1].filled], [15, 1], 'order 1 filled 1 of 15');
  assert.deepEqual(b.clear && [b.clear.price, b.clear.volume, b.clear.forfeited], [1111, 9, 1]);
  const fills = fillRows(l, SCHED);
  assert.equal(fills.length, 48);
  for (const f of fills) { const bk = l.books.get(`${f.marketId}:${f.epoch}`)!; assert.equal(f.price, bk.clear!.price); assert.equal(f.tx, bk.clear!.tx); assert.equal(f.time, SCHED.t0 + f.epoch * 45 + 35); }
  for (let i = 1; i < fills.length; i++) assert.ok(fills[i - 1].block >= fills[i].block, 'newest first');
  assert.equal(liveBooks(l)[HERO].epoch, 1139);
  const hero = clearPoints(l)[HERO];
  assert.deepEqual(hero.map((c) => c.epoch), [982, 983, 1136, 1137, 1138, 1139]);
  assert.deepEqual(hero.map((c) => c.volume), [0, 10, 9, 11, 14, 22]);
});

test('applyEvents is order-independent and idempotent: shuffles, duplicates and newest-first chunks give the same ledger', () => {
  const ev = decodeLogs(FX.logs);
  const ref = newLedger(); applyEvents(ref, ev, SCHED); const want = canon(ref);
  const r = rng(46630);
  for (let k = 0; k < 60; k++) {
    const shuffled = [...ev, ...ev.filter(() => r() < 0.3)];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const l = newLedger(); applyEvents(l, shuffled, SCHED);
    assert.equal(canon(l), want, `permutation ${k}`);
  }
  const chunks: MarketEvent[][] = []; for (let i = 0; i < ev.length; i += 40) chunks.push(ev.slice(i, i + 40));
  const l = newLedger(); for (const c of chunks.reverse()) applyEvents(l, c, SCHED); applyEvents(l, ev.slice(100, 160), SCHED);
  assert.equal(canon(l), want, 'newest chunk first, then an overlapping re-read');
});

test('summarize: change and sparkline use only traded points in epoch order, whatever order they were loaded in', () => {
  const pts = (ps: [number, number, number][]): ClearPoint[] => ps.map(([epoch, price, volume]) => ({ epoch, time: 0, price, volume, buys: 1, sells: 1, forfeited: 0, tx: '', block: epoch }));
  const s = summarize(pts([[1, 100, 5], [2, 0, 0], [3, 110, 2]]));
  assert.deepEqual(s, { last: 110, lastEpoch: 3, change: 0.1, prices: [100, 110] });
  assert.deepEqual(summarize([]), { last: 0, lastEpoch: -1, change: 0, prices: [] });
  const many = pts(Array.from({ length: 200 }, (_, i) => [i, 1000 + i, 1] as [number, number, number]));
  assert.equal(summarize(many).change, (1199 - 1080) / 1080, 'change is measured over the last 120 traded points');
  const l = newLedger(); const ev = decodeLogs(FX.logs); applyEvents(l, [...ev].reverse(), SCHED);
  assert.deepEqual(summarize(clearPoints(l)[HERO]), { last: 1113, lastEpoch: 1139, change: (1113 - 1102) / 1102, prices: [1102, 1111, 1103, 1109, 1113] });
});

test('rangeStats counts aggregated points by n, high and low', () => {
  const pts: ClearPoint[] = [
    { epoch: 10, time: 0, price: 105, volume: 30, buys: 6, sells: 6, forfeited: 0, tx: '', block: 1, n: 3, high: 120, low: 90 },
    { epoch: 11, time: 0, price: 0, volume: 0, buys: 0, sells: 0, forfeited: 2, tx: '', block: 2 },
    { epoch: 12, time: 0, price: 100, volume: 4, buys: 1, sells: 1, forfeited: 0, tx: '', block: 3 },
  ];
  assert.deepEqual(rangeStats(pts), { trades: 4, high: 120, low: 90, volume: 34 });
  assert.deepEqual(rangeStats([]), { trades: 0, high: 0, low: 0, volume: 0 });
});

// conflicting duplicates and clear time
const H = (c: string) => '0x' + c.repeat(64);
const clearEv = (block: number, tx: string, price: number): MarketEvent => ({ kind: 'clear', market: HERO, epoch: 7, block, logIndex: 0, tx, price, volume: 3, buys: 1, sells: 1, forfeited: 0 });
const fillEv = (block: number, tx: string, units: number): MarketEvent => ({ kind: 'fill', market: HERO, epoch: 7, block, logIndex: 1, tx, index: 0, trader: '0x' + '11'.repeat(20), side: 1, units, price: 100 });
const both = (a: MarketEvent[], sched?: typeof SCHED) => {
  const x = newLedger(); applyEvents(x, a, sched); const y = newLedger(); applyEvents(y, [...a].reverse(), sched); return [x, y] as const;
};

test('conflicting clears for one market+epoch: the greater (block, tx) wins in either application order', () => {
  const lo = clearEv(10, H('a'), 100), hi = clearEv(11, H('b'), 101);
  const [x, y] = both([lo, hi], SCHED);
  assert.equal(canon(x), canon(y));
  assert.equal(x.books.get(`${HERO}:7`)!.clear!.price, 101);
  assert.equal(clearPoints(x)[HERO][0].price, 101);
  const tieLo = clearEv(10, H('a'), 100), tieHi = clearEv(10, H('b'), 102);
  const [p, q] = both([tieLo, tieHi], SCHED);
  assert.equal(canon(p), canon(q));
  assert.equal(p.books.get(`${HERO}:7`)!.clear!.price, 102, 'same block: the greater tx hash wins');
  const once = newLedger(); applyEvents(once, [hi], SCHED); const twice = newLedger(); applyEvents(twice, [hi, hi], SCHED);
  assert.equal(canon(once), canon(twice));
});

test('conflicting fills for one order: the greater (block, tx) wins in either application order', () => {
  const lo = fillEv(10, H('a'), 1), hi = fillEv(11, H('b'), 2);
  const [x, y] = both([lo, hi], SCHED);
  assert.equal(canon(x), canon(y));
  assert.equal(x.books.get(`${HERO}:7`)!.orders[0].filled, 2);
  const [p, q] = both([fillEv(10, H('c'), 5), fillEv(10, H('b'), 4)], SCHED);
  assert.equal(canon(p), canon(q));
  assert.equal(p.books.get(`${HERO}:7`)!.orders[0].filled, 5);
  const once = newLedger(); applyEvents(once, [hi], SCHED); const twice = newLedger(); applyEvents(twice, [hi, hi], SCHED);
  assert.equal(canon(once), canon(twice));
});

test('clear time: kept when a later call has no schedule, stamped when a later call has one', () => {
  const c = clearEv(10, H('a'), 100); const want = SCHED.t0 + 7 * SCHED.epochLen + SCHED.revealEnd;
  const a = newLedger(); applyEvents(a, [c], SCHED); applyEvents(a, [c]);
  assert.equal(clearPoints(a)[HERO][0].time, want, 'a schedule-less re-read must not reset the time to 0');
  const b = newLedger(); applyEvents(b, [c]); assert.equal(clearPoints(b)[HERO][0].time, 0);
  applyEvents(b, [c], SCHED);
  assert.equal(clearPoints(b)[HERO][0].time, want, 'a later call with a schedule stamps the missing time');
  const d = newLedger(); applyEvents(d, [c], SCHED); applyEvents(d, [clearEv(11, H('b'), 101)]);
  assert.equal(clearPoints(d)[HERO][0].time, want, 'a replacing clear without a schedule keeps the known time');
});

// traders: every wallet in the order of its first order on chain (labels "Agent A", "Agent B", ...)

/** main's old rule, kept here as the reference: walk the events in chain order and note each wallet at its first Committed. */
function firstCommitOrder(events: MarketEvent[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const e of [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) if (e.kind === 'commit' && !seen.has(e.trader)) { seen.add(e.trader); out.push(e.trader); }
  return out;
}

test('traderOrder on the fixture: the wallets in the order of their first commit, as the old store listed them', () => {
  const ev = decodeLogs(FX.logs); const l = newLedger(); applyEvents(l, ev, SCHED);
  const want = firstCommitOrder(ev);
  assert.ok(want.length >= 5, 'the fixture has several distinct wallets');
  assert.deepEqual(traderOrder(l), want);
  assert.ok(traderOrder(l).every((a) => a === a.toLowerCase()), 'lowercase');
});

test('traderOrder is independent of arrival order: reversed, shuffled, chunked newest-first and duplicated give the same list', () => {
  const ev = decodeLogs(FX.logs); const want = firstCommitOrder(ev);
  const run = (list: MarketEvent[][]) => { const l = newLedger(); for (const part of list) applyEvents(l, part, SCHED); return traderOrder(l); };
  assert.deepEqual(run([[...ev].reverse()]), want);
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = rng(seed); const sh = [...ev].map((e) => [r(), e] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    assert.deepEqual(run([sh]), want, 'seed ' + seed);
    const cut = [0, Math.floor(sh.length / 3), Math.floor((2 * sh.length) / 3), sh.length]; // three batches, then everything again (overlapping re-read)
    assert.deepEqual(run([sh.slice(cut[0], cut[1]), sh.slice(cut[1], cut[2]), sh.slice(cut[2]), sh]), want, 'batches ' + seed);
  }
  const chunks: MarketEvent[][] = []; for (let i = 0; i < ev.length; i += 40) chunks.unshift(ev.slice(i, i + 40)); // newest chunk first, as the backfill delivers
  assert.deepEqual(run(chunks), want);
});

test('traderOrder: ties on block go by logIndex, then by address; a later order never moves a wallet up; reveals and fills count when the commit is not loaded', () => {
  const mk = (kind: 'commit' | 'reveal', trader: string, block: number, logIndex: number, index = 0, epoch = 1): MarketEvent => (kind === 'commit'
    ? { kind, market: HERO, epoch, block, logIndex, tx: '0x' + '11'.repeat(32), index, trader, hash: '0x' + '22'.repeat(32) }
    : { kind, market: HERO, epoch, block, logIndex, tx: '0x' + '11'.repeat(32), index, trader, side: 0, price: 1, units: 1 });
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
  const l = newLedger();
  applyEvents(l, [mk('commit', B, 10, 5, 1), mk('commit', A, 10, 3, 0), mk('commit', C, 12, 0, 2), mk('commit', A, 20, 0, 3, 2)], SCHED);
  assert.deepEqual(traderOrder(l), [A, B, C]);
  applyEvents(l, [mk('reveal', C, 11, 1, 2)], SCHED); // C's reveal at (11,1) is earlier than its commit at (12,0): C's position is the earliest of its orders, still after B
  assert.deepEqual(traderOrder(l), [A, B, C]);
  applyEvents(l, [mk('reveal', C, 9, 1, 7, 0)], SCHED);
  assert.deepEqual(traderOrder(l), [C, A, B], 'older history arriving later can reorder: stable only once history is complete');
  assert.deepEqual(traderOrder(newLedger()), []);
});

test('changeWindow: the change% window never starts on an aggregated (hourly) point; summarize measures over it', () => {
  const p = (epoch: number, price: number, over: Partial<ClearPoint> = {}): ClearPoint => ({ epoch, time: 0, price, volume: 1, buys: 1, sells: 1, forfeited: 0, tx: '', block: epoch, ...over });
  const pts = [p(1, 500, { n: 40, high: 900, low: 400 }), p(50, 600, { n: 30, high: 700, low: 550 }), p(100, 1000), p(101, 1100)];
  assert.deepEqual([changeWindow(pts).first!.epoch, changeWindow(pts).last!.epoch], [100, 101]);
  assert.equal(summarize(pts).change, 0.1);
  const onlyOld = [p(1, 500, { n: 3, high: 600, low: 400 }), p(9, 800)];
  assert.equal(changeWindow(onlyOld).first!.epoch, 9, 'nothing but aggregates before the newest point: the window is that point alone');
  assert.equal(summarize(onlyOld).change, 0);
  assert.deepEqual(changeWindow([]), {});
  assert.equal(changeWindow(Array.from({ length: CHANGE_WINDOW + 5 }, (_, i) => p(i, 1000 + i))).first!.epoch, 5, 'full-resolution windows are unchanged');
});
