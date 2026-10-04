// Run: node --test apps/web/src/lib/market-chart.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAtGaps, linePathOf, tradeStats, botStatus, agoText, epochCount, PAUSED_AFTER_EPOCHS, priceRange, REF_SPAN, carrySegments, gapTipText, CARRY_MIN_GAP } from './market-chart.ts';
import type { ClearPoint, Schedule } from './market.ts';

const cp = (epoch: number, price: number, volume = 5): ClearPoint => ({ epoch, time: 0, price, volume, buys: 1, sells: 1, forfeited: 0, tx: '0x', block: 1 });
const sched: Schedule = { t0: 1000, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2_000_000 };

test('splitAtGaps breaks the series wherever an epoch has no trade', () => {
  assert.deepEqual(splitAtGaps([{ epoch: 1 }, { epoch: 2 }, { epoch: 3 }]).map((r) => r.length), [3]);
  assert.deepEqual(splitAtGaps([{ epoch: 1 }, { epoch: 2 }, { epoch: 5 }, { epoch: 6 }, { epoch: 9 }]).map((r) => r.map((x) => x.epoch)), [[1, 2], [5, 6], [9]]);
  assert.deepEqual(splitAtGaps([]), []);
});
test('a path is only drawn for runs of two or more points, and each run starts with its own M', () => {
  assert.equal(linePathOf([{ x: 1, y: 2 }]), '');
  assert.equal(linePathOf([{ x: 1, y: 2 }, { x: 3, y: 4 }]), 'M1.0,2.0L3.0,4.0');
});
test('high and low are separate values with their own epochs, and the count is separate', () => {
  const s = tradeStats([cp(1, 1000), cp(2, 1200), cp(3, 900), cp(4, 1100), cp(5, 5000, 0)]);
  assert.deepEqual(s, { n: 4, high: 1200, highEpoch: 2, low: 900, lowEpoch: 3, volume: 20 });
  assert.equal(tradeStats([]).n, 0);
});
test('bots are paused only when the newest cleared epoch is far behind the live epoch', () => {
  const now = (e: number) => sched.t0 + e * sched.epochLen + 3;
  const fresh = botStatus({ a: [cp(100, 1000)] }, sched, 102, now(102))!;
  assert.equal(fresh.paused, false); assert.equal(fresh.lastClearEpoch, 100);
  const stale = botStatus({ a: [cp(100, 1000)], b: [cp(90, 1, 0)] }, sched, 100 + PAUSED_AFTER_EPOCHS, now(100 + PAUSED_AFTER_EPOCHS))!;
  assert.equal(stale.paused, true); assert.equal(stale.lastTradeEpoch, 100);
  assert.equal(stale.tradeAgeSec, PAUSED_AFTER_EPOCHS * 45 + 3 - 35);
  assert.equal(botStatus({}, sched, 5, 0), undefined); assert.equal(botStatus({ a: [cp(1, 1)] }, undefined, 5, 0), undefined);
});
test('a market where only empty epochs cleared still shows the bots as active, with no trade epoch', () => {
  const s = botStatus({ a: [cp(100, 0, 0)] }, sched, 101, sched.t0 + 101 * 45 + 1)!;
  assert.equal(s.paused, false); assert.equal(s.lastTradeEpoch, -1);
});
test('agoText', () => { assert.equal(agoText(30), '30 seconds'); assert.equal(agoText(61), '1 minute'); assert.equal(agoText(7300), '2 hours'); });

test('aggregated (hourly) points: counted by n, high and low from their own range, and the stat says how many epochs it stands for', () => {
  const s = tradeStats([cp(1, 1000), { ...cp(80, 1100, 40), n: 60, high: 1500, low: 700 }, cp(81, 1200)]);
  assert.deepEqual(s, { n: 62, high: 1500, highEpoch: 80, highN: 60, low: 700, lowEpoch: 80, lowN: 60, volume: 50 });
  assert.equal(epochCount([cp(1, 1), { ...cp(2, 1, 0), n: 7, high: 1, low: 1 }]), 8);
  assert.equal(epochCount([]), 0);
});

test('priceRange: a reference inside data +-30% widens the range to include it', () => {
  assert.deepEqual(priceRange(1000, 1100, 1250), { lo: 1000, hi: 1250 });
  assert.deepEqual(priceRange(1000, 1100, 900), { lo: 900, hi: 1100 });
  assert.deepEqual(priceRange(1000, 1100, 1050), { lo: 1000, hi: 1100 });
});
test('priceRange: a far-away reference is left out so small moves are not flattened (edges are inclusive)', () => {
  assert.equal(REF_SPAN, 0.3);
  assert.deepEqual(priceRange(1000, 1100, 5000), { lo: 1000, hi: 1100 });
  assert.deepEqual(priceRange(1000, 1100, 100), { lo: 1000, hi: 1100 });
  assert.deepEqual(priceRange(1000, 1100, 1430), { lo: 1000, hi: 1430 });
  assert.deepEqual(priceRange(1000, 1100, 700), { lo: 700, hi: 1100 });
  assert.deepEqual(priceRange(1000, 1100, 1431), { lo: 1000, hi: 1100 });
  assert.deepEqual(priceRange(1000, 1100, 699), { lo: 1000, hi: 1100 });
});

// carry segments: a pure presentation of "no trades here, the last cleared price still stands"
const at = (epoch: number, price: number, over: Partial<ClearPoint> = {}): ClearPoint => ({ ...cp(epoch, price), time: 1000 + epoch * 45, ...over });
test('carrySegments: no gap (consecutive, or holes of at most CARRY_MIN_GAP epochs), empty input and a single point give nothing', () => {
  assert.equal(CARRY_MIN_GAP, 3);
  assert.deepEqual(carrySegments([], 100, CARRY_MIN_GAP), []);
  assert.deepEqual(carrySegments([at(10, 500)], undefined, CARRY_MIN_GAP), []);
  assert.deepEqual(carrySegments([at(10, 500)], 12, CARRY_MIN_GAP), []);
  assert.deepEqual(carrySegments([at(10, 500), at(11, 510), at(12, 520), at(16, 530)], 17, CARRY_MIN_GAP), [], 'epochs 13-15 are three missing epochs: not longer than the minimum');
});
test('carrySegments: one gap carries the earlier price from the last real point to the next one, and counts the missing epochs', () => {
  const g = carrySegments([at(10, 500), at(11, 510), at(20, 530), at(21, 540)], 22, CARRY_MIN_GAP);
  assert.deepEqual(g, [{ fromEpoch: 12, toEpoch: 19, missing: 8, t0: 1000 + 11 * 45, t1: 1000 + 20 * 45, price: 510, toNow: false }]);
  assert.equal(carrySegments([at(10, 500), at(15, 530)], 16, CARRY_MIN_GAP).length, 1, 'four missing epochs (11-14) is a gap');
});
test('carrySegments: empty (no-trade) clears are not trades, so they never end a gap', () => {
  const g = carrySegments([at(10, 500), at(13, 999, { volume: 0 }), at(30, 520)], 31, CARRY_MIN_GAP);
  assert.equal(g.length, 1); assert.equal(g[0].price, 500); assert.equal(g[0].missing, 19);
});
test('carrySegments: a trailing gap runs from the last real point to now when the latest trade is old', () => {
  const g = carrySegments([at(10, 500), at(11, 510)], 40, CARRY_MIN_GAP);
  assert.deepEqual(g, [{ fromEpoch: 12, toEpoch: 39, missing: 28, t0: 1000 + 11 * 45, t1: 1000 + 40 * 45, price: 510, toNow: true }]);
  assert.deepEqual(carrySegments([at(10, 500), at(11, 510)], 14, CARRY_MIN_GAP), [], 'epochs 12-13 only');
});
test('carrySegments: an hourly aggregate stands for its whole hour, so the carry ends where the hour starts and never overlaps it', () => {
  const H = 3600, hour = 10 * H;
  const agg = at(0, 700, { time: hour + 3500, epoch: Math.round((hour + 3500 - 1000) / 45), n: 60, high: 800, low: 600 });
  // the previous point is long before, the aggregate covers [hour, hour + 3500]
  const g = carrySegments([at(5, 400), agg], undefined, CARRY_MIN_GAP);
  assert.equal(g.length, 1); assert.equal(g[0].t0, 1000 + 5 * 45); assert.equal(g[0].t1, hour); assert.equal(g[0].price, 400);
  assert.ok(g[0].toEpoch < agg.epoch - 70, 'B is the epoch before the aggregate starts, not the aggregate\'s last epoch');
  // two adjacent hourly aggregates: nothing between them
  const a1 = at(0, 700, { time: hour + 3550, epoch: Math.round((hour + 3550 - 1000) / 45), n: 70 });
  const a2 = at(0, 710, { time: hour + H + 3550, epoch: Math.round((hour + H + 3550 - 1000) / 45), n: 70 });
  assert.deepEqual(carrySegments([a1, a2], undefined, CARRY_MIN_GAP), []);
  // an aggregate followed by a later plain point carries from the aggregate's last epoch
  const g2 = carrySegments([a1, at(a1.epoch + 50, 720)], undefined, CARRY_MIN_GAP);
  assert.equal(g2.length, 1); assert.equal(g2[0].fromEpoch, a1.epoch + 1); assert.equal(g2[0].price, 700);
});
test('gapTipText: the epochs, an honest duration, and the carried price in the shared money format', () => {
  const g = carrySegments([at(10, 129643), at(30, 129700)], 31, CARRY_MIN_GAP)[0];
  assert.equal(gapTipText(g), 'No trades from epoch 11 to 29 (about 14 min). Last price $1,296.43 carried.');
  const t = carrySegments([at(10, 129643)], 700, CARRY_MIN_GAP)[0];
  assert.equal(gapTipText(t), 'No trades from epoch 11 to now (about 517 min). Last price $1,296.43 carried.'.replace('517 min', '8.6 h'));
});
