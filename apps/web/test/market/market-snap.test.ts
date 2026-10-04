// node --test test/market/market-snap.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEvents, clearPoints, decodeLogs, fillRows, newLedger, rangeStats, summarize, type ClearPoint, type CoreBook, type Ledger, type MarketEvent, type RawLog } from '../../src/lib/market-core.ts';
import { AGG_KEEP, FULL_KEEP, HASH_EPOCHS, HOT_EPOCHS, LIMITS, TX_KEEP, buildSnapshot, compactClears, hotFrom, hydrate, validateSnapshot, type MarketSnapshot } from '../../src/lib/market-snap.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
const HERO = '0x874760df68911be9e368727c9d7c69bb3a9fc9c8845563c7febbc10a8bb4550e';
const SCHED = { t0: 1759400000, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2_000_000 };
const ID = { chainId: 46630, book: '0x2ba62631d74827abf2f7467b20370dc2dc59aa11', deployBlock: 127690064 };
const META = { ...ID, cursor: 127999285, head: 127999300, headTime: 1759451300, builtAt: 1759451301000, complete: true };

function fixtureLedger() { const l = newLedger(); applyEvents(l, decodeLogs(FX.logs), SCHED); return l; }
const roundTrip = (s: MarketSnapshot) => JSON.parse(JSON.stringify(s));
const pt = (epoch: number, price: number, volume: number): ClearPoint => ({ epoch, time: SCHED.t0 + epoch * 45 + 35, price, volume, buys: 1, sells: 1, forfeited: 0, tx: '0x' + epoch.toString(16).padStart(64, '0'), block: 1000 + epoch });

test('snapshot of the fixture ledger validates after a JSON round trip and hydrates to the same views', () => {
  const l = fixtureLedger();
  const snap = validateSnapshot(roundTrip(buildSnapshot(l, META, SCHED)), ID);
  assert.ok(snap, 'valid');
  assert.equal(snap.hot.books.length, 18, 'all 18 books are inside the hot window');
  assert.equal(hotFrom(l.books.values()), 1139 - HOT_EPOCHS + 1);
  const hashed = snap.hot.books.filter((b) => b.o.some((o) => o.h)).map((b) => b.e);
  assert.ok(hashed.every((e) => e > 1139 - 30) && hashed.length > 0, 'commit hashes only on the newest 30 epochs');
  const h = newLedger(); hydrate(h, snap);
  assert.deepEqual(clearPoints(h), clearPoints(l));
  assert.deepEqual(fillRows(h, SCHED), fillRows(l, SCHED));
  assert.deepEqual(summarize(clearPoints(h)[HERO]), summarize(clearPoints(l)[HERO]));
});

test('events applied on top of a hydrated snapshot (an overlapping RPC poll) change nothing', () => {
  const l = fixtureLedger();
  const h = newLedger(); hydrate(h, validateSnapshot(roundTrip(buildSnapshot(l, META, SCHED)), ID)!);
  const before = JSON.stringify(clearPoints(h)) + JSON.stringify(fillRows(h, SCHED));
  applyEvents(h, decodeLogs(FX.logs).slice(150), SCHED);
  assert.equal(JSON.stringify(clearPoints(h)) + JSON.stringify(fillRows(h, SCHED)), before);
});

test('validateSnapshot refuses another chain, contract, deployment, version, or a malformed body (cache poisoning)', () => {
  const good = roundTrip(buildSnapshot(fixtureLedger(), META, SCHED));
  assert.ok(validateSnapshot(good, ID));
  const bad = (patch: (s: any) => void) => { const s = roundTrip(good); patch(s); return validateSnapshot(s, ID); };
  assert.equal(bad((s) => { s.chainId = 1; }), null);
  assert.equal(bad((s) => { s.book = '0x' + '1'.repeat(40); }), null);
  assert.equal(bad((s) => { s.deployBlock = 1; }), null);
  assert.equal(bad((s) => { s.v = 2; }), null);
  assert.equal(bad((s) => { s.cursor = s.head + 1; }), null);
  assert.equal(bad((s) => { s.cursor = 5; }), null, 'cursor before the deploy block');
  assert.equal(bad((s) => { s.complete = 'yes'; }), null);
  assert.equal(bad((s) => { s.schedule.epochLen = 0; }), null);
  assert.equal(bad((s) => { s.hot.books[0].o[0].t = '<script>'; }), null);
  assert.equal(bad((s) => { s.hot.books[0].o[0].p = 1.5; }), null);
  assert.equal(bad((s) => { s.hot.books[0].o[0].s = 2; }), null);
  assert.equal(bad((s) => { s.hot.books[0].c.p = -1; }), null);
  assert.equal(bad((s) => { s.hot.clears = { ['__proto__']: [] }; }), null);
  assert.equal(bad((s) => { s.cold[HERO] = [{ e: 5, p: 1, v: 1, b: 1, s: 1, f: 0, k: 1 }, { e: 5, p: 1, v: 1, b: 1, s: 1, f: 0, k: 1 }]; }), null, 'epochs must strictly increase');
  assert.equal(bad((s) => { s.hot.books = Array.from({ length: 5000 }, () => s.hot.books[0]); }), null, 'size cap');
  assert.equal(validateSnapshot('{"v":1}', ID), null);
  assert.equal(validateSnapshot(null, ID), null);
});

test('compactClears: newest FULL_KEEP at full resolution, older folded per hour with n/high/low, tx only on the newest', () => {
  const pts = Array.from({ length: 2000 }, (_, i) => pt(i, 1000 + (i % 7), i % 50 === 0 ? 0 : 2));
  const c = compactClears(pts, SCHED);
  const full = c.slice(-FULL_KEEP);
  assert.deepEqual(full.map((p) => p.epoch), pts.slice(-FULL_KEEP).map((p) => p.epoch));
  assert.equal(full.filter((p) => p.tx).length, TX_KEEP);
  const folded = c.slice(0, c.length - FULL_KEEP);
  assert.ok(folded.length > 0 && folded.length <= AGG_KEEP);
  const n = folded.reduce((s, p) => s + (p.n ?? 1), 0);
  assert.equal(n, 2000 - FULL_KEEP, 'every older epoch is counted exactly once');
  assert.equal(folded.reduce((s, p) => s + p.volume, 0), pts.slice(0, 2000 - FULL_KEEP).reduce((s, p) => s + p.volume, 0));
  for (const p of folded) if (p.volume > 0) { assert.ok((p.high ?? p.price) >= p.price && (p.low ?? p.price) <= p.price); assert.equal(p.tx, ''); }
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].epoch < c[i].epoch, 'ascending, no duplicates');
});

test('compactClears is associative: compacting in steps (the Worker cold part) equals compacting once', () => {
  const pts = Array.from({ length: 3000 }, (_, i) => pt(i, 900 + ((i * 37) % 23), i % 31 === 0 ? 0 : 1 + (i % 5)));
  const once = compactClears(pts, SCHED);
  let acc: ClearPoint[] = [];
  for (let i = 0; i < pts.length; i += 240) acc = compactClears([...acc, ...pts.slice(i, i + 240)], SCHED);
  assert.deepEqual(acc, once);
});

// Replay guard for folded epochs, strict structure, cursor invariants, sanitized copy, caps.
const hex64 = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const M1 = hex64(0xa1);
const BLK = 127_700_000;
const clearEv = (market: string, epoch: number, price: number, volume: number): MarketEvent => ({ kind: 'clear', market, epoch, block: BLK + epoch, logIndex: 0, tx: hex64(0x10000 + epoch), price, volume, buys: 1, sells: 1, forfeited: 0 });
const commitEv = (market: string, epoch: number, index: number): MarketEvent => ({ kind: 'commit', market, epoch, block: BLK + epoch, logIndex: 1 + index, tx: hex64(0x20000 + epoch * 1000 + index), index, trader: addr(index + 1), hash: hex64(0x30000 + index) });
const via = (snap: MarketSnapshot) => { const h = newLedger(); hydrate(h, validateSnapshot(roundTrip(snap), ID)!); return h; };

/** 1000 clears in one market, then one later order (so the hot window starts at 841 and everything before it is cold). */
function probe(volumeOf: (e: number) => number) {
  const evs: MarketEvent[] = [];
  for (let e = 0; e < 1000; e++) evs.push(clearEv(M1, e, 1000 + (e % 7), volumeOf(e)));
  evs.push(commitEv(M1, 1000, 0));
  const l = newLedger(); applyEvents(l, evs, SCHED);
  return { evs, l, snap: roundTrip(buildSnapshot(l, META, SCHED)) as MarketSnapshot };
}
const views = (x: Ledger) => { const cp = clearPoints(x); return JSON.stringify([cp, rangeStats(cp[M1]), summarize(cp[M1]), fillRows(x, SCHED)]); };
// Same, with tx removed: a replayed full-resolution clear may fill in a tx that compaction had dropped; nothing else may move.
const stable = (x: Ledger) => { const cp = clearPoints(x); return JSON.stringify([Object.fromEntries(Object.entries(cp).map(([m, l]) => [m, l.map(({ tx: _t, ...r }) => r)])), rangeStats(cp[M1]), summarize(cp[M1]), fillRows(x, SCHED)]); };

test('replaying a clear that is already inside a folded point changes nothing (bucket-last and non-last epochs)', () => {
  const { evs, l, snap } = probe(() => 2);
  assert.equal(rangeStats(clearPoints(l)[M1]).trades, 1000);
  const agg = snap.cold[M1].filter((p) => (p.n ?? 1) > 1);
  assert.ok(agg.length >= 2, 'the cold part has folded points');
  const floor = Math.max(...agg.map((p) => p.e));
  const bucketLast = new Set(agg.map((p) => p.e));
  const clears = evs.filter((e) => e.kind === 'clear');
  const replay = (pick: (e: MarketEvent) => boolean) => { const h = via(snap); const before = views(h); applyEvents(h, clears.filter(pick), SCHED); return [before, views(h), h] as const; };

  const h0 = via(snap);
  assert.equal(rangeStats(clearPoints(h0)[M1]).trades, 1000);
  assert.equal(rangeStats(clearPoints(h0)[M1]).volume, 2000);
  const [b1, a1] = replay((e) => bucketLast.has(e.epoch));
  assert.equal(a1, b1, 'a clear for the last epoch of a bucket must not overwrite the aggregate');
  const [b2, a2] = replay((e) => e.epoch <= floor && !bucketLast.has(e.epoch));
  assert.equal(a2, b2, 'a clear for a non-last epoch of a bucket must not become a new raw point');
  assert.ok(clears.filter((e) => e.epoch <= floor && !bucketLast.has(e.epoch)).length > 10);
  const [b3, a3] = replay((e) => e.epoch <= floor);
  assert.equal(a3, b3);
});

test('replaying every event of the snapshot (zero-volume buckets included) leaves the views unchanged; events past the floor still apply', () => {
  const { evs, l, snap } = probe((e) => (e % 50 === 0 ? 0 : 2));
  const h = via(snap); const before = stable(h);
  assert.deepEqual(rangeStats(clearPoints(h)[M1]), rangeStats(clearPoints(l)[M1]), 'hydrated totals equal the source totals');
  applyEvents(h, evs, SCHED);
  assert.equal(stable(h), before);
  applyEvents(h, [clearEv(M1, 1001, 1234, 3)], SCHED);
  const cp = clearPoints(h)[M1]; assert.equal(cp[cp.length - 1].epoch, 1001);
  assert.equal(rangeStats(cp).trades, rangeStats(clearPoints(l)[M1]).trades + 1);
});

test('cold path through buildSnapshot + hydrate: recent clears are exact, older ones survive as folded totals', () => {
  const { l, snap } = probe((e) => (e % 50 === 0 ? 0 : 2));
  const cold = snap.cold[M1]; assert.ok(cold.length > FULL_KEEP && cold.some((p) => (p.n ?? 1) > 1));
  assert.equal(snap.hot.books.every((b) => b.e >= 841), true);
  const h = via(snap);
  const strip = (x: Ledger) => clearPoints(x)[M1].slice(-(FULL_KEEP + 159)).map(({ tx: _t, ...r }) => r);
  assert.deepEqual(strip(h), strip(l));
  assert.deepEqual(rangeStats(clearPoints(h)[M1]), rangeStats(clearPoints(l)[M1]));
  assert.deepEqual(summarize(clearPoints(h)[M1]), summarize(clearPoints(l)[M1]));
});

test('hydrate REPLACES the ledger content (never merges into a non-empty ledger) and resets the folded floor', () => {
  const { snap } = probe(() => 2);
  const l = fixtureLedger(); hydrate(l, validateSnapshot(roundTrip(buildSnapshot(fixtureLedger(), META, SCHED)), ID)!);
  hydrate(l, validateSnapshot(snap, ID)!);
  assert.deepEqual(Object.keys(clearPoints(l)), [M1], 'the fixture markets are gone');
  assert.ok([...l.books.values()].every((b) => b.market === M1));
  assert.equal(views(l), views(via(snap)));
  // a snapshot without folded data resets the floor: an early clear is a new point again
  const fresh = fixtureLedger(); hydrate(l, validateSnapshot(roundTrip(buildSnapshot(fresh, META, SCHED)), ID)!);
  applyEvents(l, [clearEv(M1, 5, 1000, 2)], SCHED);
  assert.equal(clearPoints(l)[M1].length, 1);
});

test('validateSnapshot enforces book structure: ascending unique order indexes, unique (market, epoch), clear epoch, folded point bounds', () => {
  const good = roundTrip(buildSnapshot(fixtureLedger(), META, SCHED));
  const bad = (patch: (s: any) => void) => { const s = roundTrip(good); patch(s); return validateSnapshot(s, ID); };
  const bi = good.hot.books.findIndex((b: any) => b.o.length >= 2);
  assert.ok(bi >= 0);
  assert.equal(bad((s) => { s.hot.books[bi].o.reverse(); }), null, 'descending order indexes');
  assert.equal(bad((s) => { s.hot.books[bi].o[1].i = s.hot.books[bi].o[0].i; }), null, 'duplicate order index');
  assert.equal(bad((s) => { s.hot.books.push(roundTrip(good).hot.books[0]); }), null, 'duplicate (market, epoch) book');
  const ci = good.hot.books.findIndex((b: any) => b.c);
  assert.ok(ci >= 0);
  assert.equal(bad((s) => { s.hot.books[ci].c.e = s.hot.books[ci].e + 1; }), null, 'clear epoch differs from the book epoch');
  const folded = { e: 50, p: 100, v: 10, b: 5, s: 5, f: 0, k: BLK, n: 4, hi: 120, lo: 90 };
  const withCold = (c: any) => bad((s) => { s.cold[HERO] = [c]; });
  assert.ok(withCold(folded), 'a consistent folded point is fine');
  assert.equal(withCold({ ...folded, lo: 101 }), null, 'lo above the price');
  assert.equal(withCold({ ...folded, hi: 99 }), null, 'hi below the price');
  assert.equal(withCold({ ...folded, lo: 130, hi: 120 }), null, 'lo above hi');
  assert.equal(withCold({ ...folded, n: 0 }), null, 'n must be positive');
  assert.equal(withCold({ ...folded, n: 100_001 }), null, 'n has an upper bound');
  assert.ok(withCold({ ...folded, n: 100_000 }));
  assert.equal(withCold({ ...folded, n: 1.5 }), null);
  const { hi: _hi, ...noHi } = folded; const { lo: _lo, ...noLo } = folded; const { n: _n, ...noN } = folded;
  assert.equal(withCold(noHi), null, 'n without hi');
  assert.equal(withCold(noLo), null, 'n without lo');
  assert.equal(withCold(noN), null, 'hi/lo without n');
});

test('validateSnapshot enforces cursor consistency: no data past the cursor; complete is a freshness flag, not cursor === head', () => {
  const good = roundTrip(buildSnapshot(fixtureLedger(), META, SCHED));
  const bad = (patch: (s: any) => void) => { const s = roundTrip(good); patch(s); return validateSnapshot(s, ID); };
  const ci = good.hot.books.findIndex((b: any) => b.c);
  assert.equal(bad((s) => { s.hot.books[0].lb = s.cursor + 1; }), null, 'book lastBlock past the cursor');
  assert.equal(bad((s) => { s.hot.books[0].fb = s.cursor + 1; s.hot.books[0].lb = s.cursor + 2; }), null, 'book firstBlock past the cursor');
  assert.equal(bad((s) => { s.hot.books[ci].c.k = s.cursor + 1; }), null, 'book clear block past the cursor');
  assert.ok(bad((s) => { s.hot.books[ci].c.k = s.cursor; s.hot.books[ci].lb = s.cursor; }), 'a block equal to the cursor is fine');
  assert.equal(bad((s) => { s.hot.clears = { [HERO]: [{ e: 1, p: 1, v: 1, b: 1, s: 1, f: 0, k: s.cursor + 1 }] }; }), null, 'hot clear past the cursor');
  assert.ok(bad((s) => { s.hot.clears = { [HERO]: [{ e: 1, p: 1, v: 1, b: 1, s: 1, f: 0, k: s.cursor }] }; }));
  assert.equal(bad((s) => { s.cold[HERO] = [{ e: 1, p: 1, v: 1, b: 1, s: 1, f: 0, k: s.cursor + 1 }]; }), null, 'cold clear past the cursor');
  assert.ok(bad((s) => { s.complete = true; s.head = s.cursor + 2000; }), 'complete may lag the head (the Worker allows a lag)');
  assert.ok(bad((s) => { s.complete = false; s.head = s.cursor; }), 'incomplete at the head is fine');
  assert.equal(bad((s) => { s.complete = true; s.head = s.cursor - 1; }), null, 'head behind the cursor never validates, complete or not');
});

test('validateSnapshot returns a rebuilt copy with whitelisted fields only', () => {
  const good = roundTrip(buildSnapshot(fixtureLedger(), META, SCHED));
  const dirty = roundTrip(good);
  dirty.extra = 1; dirty.schedule.x = 1; dirty.hot.y = 1; dirty.hot.books[0].z = 1; dirty.hot.books[0].o[0].w = 1;
  const ci = dirty.hot.books.findIndex((b: any) => b.c); dirty.hot.books[ci].c.q = 1;
  dirty.cold = { ...dirty.cold, [HERO]: [{ e: 1, p: 1, v: 1, b: 1, s: 1, f: 0, k: BLK, tx: undefined, junk: 1 }] };
  const text = JSON.stringify(dirty).replace('"hot":{', '"hot":{"__proto__":{"polluted":true},').replace('"o":[{', '"o":[{"__proto__":{"polluted":true},');
  const input = JSON.parse(text);
  assert.ok(Object.prototype.hasOwnProperty.call(input.hot, '__proto__'), 'the probe really carries an own __proto__');
  const out = validateSnapshot(input, ID)!;
  assert.ok(out);
  const expected = roundTrip(good); expected.cold[HERO] = [{ e: 1, p: 1, v: 1, b: 1, s: 1, f: 0, k: BLK }];
  assert.deepEqual(JSON.parse(JSON.stringify(out)), expected);
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  assert.equal(own(out.hot, '__proto__'), false); assert.equal(own(out.hot.books[0].o[0], '__proto__'), false);
  assert.equal(({} as any).polluted, undefined);
  assert.notEqual(out, input); assert.notEqual(out.hot.books[0], input.hot.books[0]);
  input.hot.books[0].o[0].t = 'mutated'; assert.notEqual(out.hot.books[0].o[0].t, 'mutated');
});

test('validateSnapshot rejects bad hex, descending epochs and non-finite numbers (objects that never saw JSON)', () => {
  const good = buildSnapshot(fixtureLedger(), META, SCHED);
  const bad = (patch: (s: any) => void) => { const s = structuredClone(good); patch(s); return validateSnapshot(s, ID); };
  assert.ok(validateSnapshot(structuredClone(good), ID));
  const hashed = good.hot.books.findIndex((b) => b.o.some((o) => o.h)); const oi = good.hot.books[hashed].o.findIndex((o) => o.h);
  assert.equal(bad((s) => { s.hot.books[hashed].o[oi].h = '0x12'; }), null, 'short hash');
  assert.equal(bad((s) => { s.hot.books[hashed].o[oi].h = s.hot.books[hashed].o[oi].h.toUpperCase().replace('0X', '0x'); }), null, 'upper-case hash');
  assert.equal(bad((s) => { s.hot.books[hashed].o[oi].h = 5; }), null, 'non-string hash');
  const ci = good.hot.books.findIndex((b) => b.c);
  assert.equal(bad((s) => { s.hot.books[ci].c.tx = '0xZZ'; }), null, 'bad clear tx');
  assert.equal(bad((s) => { s.hot.books[ci].c.tx = 7; }), null);
  assert.equal(bad((s) => { s.cold[HERO] = [{ e: 6, p: 1, v: 1, b: 1, s: 1, f: 0, k: 1 }, { e: 5, p: 1, v: 1, b: 1, s: 1, f: 0, k: 1 }]; }), null, 'descending epochs');
  assert.equal(bad((s) => { s.hot.books[ci].c.tx = '0x' + 'g'.repeat(64); }), null);
  for (const v of [NaN, Infinity, -Infinity]) {
    assert.equal(bad((s) => { s.hot.books[ci].c.p = v; }), null, String(v));
    assert.equal(bad((s) => { s.hot.books[0].o[0].u = v; }), null);
    assert.equal(bad((s) => { s.cursor = v; }), null);
    assert.equal(bad((s) => { s.schedule.t0 = v; }), null);
    assert.equal(bad((s) => { s.head = v; }), null);
  }
});

const ok = (s: any) => validateSnapshot(roundTrip(s), ID) !== null;
test('size caps: markets, clears per market, books and orders per book accept the cap and refuse cap + 1', () => {
  const base = roundTrip(buildSnapshot(fixtureLedger(), META, SCHED));
  const clearList = (n: number) => Array.from({ length: n }, (_, i) => ({ e: i, p: 1, v: 1, b: 1, s: 1, f: 0, k: BLK }));
  const withCold = (cold: any) => ({ ...base, cold });
  const markets = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [hex64(i + 1), clearList(1)]));
  assert.ok(ok(withCold(markets(LIMITS.markets)))); assert.equal(ok(withCold(markets(LIMITS.markets + 1))), false);
  assert.ok(ok(withCold({ [HERO]: clearList(LIMITS.clearsPerMarket) }))); assert.equal(ok(withCold({ [HERO]: clearList(LIMITS.clearsPerMarket + 1) })), false);
  const hotMarkets = (n: number) => ({ ...base, hot: { clears: markets(n), books: [] } });
  assert.ok(ok(hotMarkets(LIMITS.markets))); assert.equal(ok(hotMarkets(LIMITS.markets + 1)), false);
  const books = (n: number) => ({ ...base, hot: { clears: {}, books: Array.from({ length: n }, (_, i) => ({ m: hex64(1 + (i % 64)), e: Math.floor(i / 64), fb: BLK, lb: BLK, o: [] })) } });
  assert.ok(ok(books(LIMITS.books))); assert.equal(ok(books(LIMITS.books + 1)), false);
  const orders = (n: number) => ({ ...base, hot: { clears: {}, books: [{ m: HERO, e: 1, fb: BLK, lb: BLK, o: Array.from({ length: n }, (_, i) => ({ i, t: addr(i + 1) })) }] } });
  assert.ok(ok(orders(LIMITS.ordersPerBook))); assert.equal(ok(orders(LIMITS.ordersPerBook + 1)), false);
});

test('worst case: 64 markets x the full hot window with busy books and long clear history, plus one oversized book, always validates', () => {
  // Worst case the module must carry: LIMITS.markets markets, every one with a book in every one of the HOT_EPOCHS epochs
  // (= 64 x 160 = 10240 books, LIMITS.books leaves margin), 24 orders per book (the contract's MAX_ORDERS), a long clear history.
  const l: Ledger = newLedger(); const markets = Array.from({ length: LIMITS.markets }, (_, i) => hex64(0x500 + i));
  const OLD = 1500;
  for (const [mi, m] of markets.entries()) {
    const byE = new Map<number, ClearPoint>(); l.clears.set(m, byE);
    for (let e = 0; e < OLD + HOT_EPOCHS; e++) byE.set(e, { epoch: e, time: SCHED.t0 + e * 45 + 35, price: 1000 + ((e * 7 + mi) % 13), volume: e % 3 ? 2 : 0, buys: 1, sells: 1, forfeited: 0, tx: hex64(e + 1), block: BLK + e });
    for (let e = OLD; e < OLD + HOT_EPOCHS; e++) {
      const b: CoreBook = { market: m, epoch: e, firstBlock: BLK + e - 5, lastBlock: BLK + e, orders: Array.from({ length: 24 }, (_, i) => ({ index: i, trader: addr(i + 1), hash: hex64(i + 1), side: (i % 2) as 0 | 1, price: 1000, units: 3, filled: i % 3 ? 3 : 0 })), clear: { price: 1000, volume: 2, buys: 1, sells: 1, forfeited: 0, tx: hex64(e + 1), block: BLK + e } };
      l.books.set(`${m}:${e}`, b);
    }
  }
  const huge: CoreBook = { market: markets[0], epoch: OLD + HOT_EPOCHS - 1, firstBlock: BLK, lastBlock: BLK + 1, orders: Array.from({ length: LIMITS.ordersPerBook + 50 }, (_, i) => ({ index: i, trader: addr(i + 1), hash: '' })) };
  l.books.set(`${markets[0]}:${huge.epoch}`, huge);
  const snap = buildSnapshot(l, { ...META, cursor: BLK + OLD + HOT_EPOCHS + 10, head: BLK + OLD + HOT_EPOCHS + 10 }, SCHED);
  assert.equal(snap.hot.books.length, LIMITS.markets * HOT_EPOCHS);
  assert.ok(snap.hot.books.length < LIMITS.books);
  const hb = snap.hot.books.find((b) => b.m === markets[0] && b.e === huge.epoch)!;
  assert.equal(hb.o.length, LIMITS.ordersPerBook, 'oversized book is cut deterministically');
  assert.deepEqual(hb.o.map((o) => o.i), Array.from({ length: LIMITS.ordersPerBook }, (_, i) => i), 'the earliest orders are kept');
  assert.ok(validateSnapshot(roundTrip(snap), ID), 'own output always validates');
  assert.deepEqual(JSON.stringify(buildSnapshot(l, { ...META, cursor: BLK + OLD + HOT_EPOCHS + 10, head: BLK + OLD + HOT_EPOCHS + 10 }, SCHED)), JSON.stringify(snap), 'deterministic');
});

test('buildSnapshot keeps commit hashes for the newest HASH_EPOCHS epochs that have orders, even when fewer than HOT_EPOCHS exist', () => {
  const l = newLedger();
  applyEvents(l, [5, 10, 11, 40].map((e) => commitEv(M1, e, 0)), SCHED);
  const snap = buildSnapshot(l, META, SCHED);
  const hashed = snap.hot.books.filter((b) => b.o.some((o) => o.h)).map((b) => b.e);
  assert.deepEqual(hashed, [11, 40], `epochs strictly newer than ${40 - HASH_EPOCHS}`);
});
