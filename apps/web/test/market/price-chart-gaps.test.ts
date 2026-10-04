// node --test test/market/price-chart-gaps.test.ts   (from apps/web)
// The dotted "last price carried" stretches across holes with no trades: drawn for a gap fixture, absent for a gapless one,
// pure presentation (aria-hidden, no markers) and invisible to items/data-points/stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNodeModule } from '../site/helpers/bundle.ts';

const { render, toItems, carrySegments, tradeStats } = await loadNodeModule<{ render(segs: unknown[]): string; toItems(p: unknown[], mode: 'line' | 'candles', tf: number): any[]; carrySegments(p: unknown[], now: number | undefined, min: number): any[]; tradeStats(p: unknown[]): any }>(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { CarryLines } from './src/components/market/PriceChart.tsx';
  export { toItems } from './src/components/market/PriceChart.tsx';
  export { carrySegments, tradeStats } from './src/lib/market-chart.ts';
  export const render = (segs) => renderToStaticMarkup(createElement('svg', null, createElement(CarryLines, { segs, X: (t) => t / 10, Y: (p) => 500 - p / 10 })));
`);
const cp = (epoch: number, price: number) => ({ epoch, time: 1000 + epoch * 45, price, volume: 5, buys: 1, sells: 1, forfeited: 0, tx: '', block: 1 });
const GAPPY = [cp(209, 129643), cp(210, 129700), cp(835, 130100), cp(836, 130200)];   // an 8-hour hole, like IP16P-CLR
const GAPLESS = [cp(1, 100), cp(2, 101), cp(3, 102), cp(5, 103)];

test('a gap fixture draws one dotted, aria-hidden, marker-free flat segment at the last price; a gapless one draws none', () => {
  const html = render(carrySegments(GAPPY, 837, 3));
  assert.equal((html.match(/data-testid="chart-gap"/g) ?? []).length, 1);
  assert.match(html, /<g class="mk-carry" aria-hidden="true">/);
  assert.match(html, /class="mk-gap"[^>]*data-from="211" data-to="834"/);
  assert.match(html, /y1="-12470" y2="-12470"/, 'flat at the last real price before the hole (epoch 210, $1,297.00)');
  assert.ok(!/<circle|<title|<text/.test(html), 'no markers, no tooltip points, no text');
  assert.equal(render(carrySegments(GAPLESS, 6, 3)), '<svg><g class="mk-carry" aria-hidden="true"></g></svg>');
});
test('a trailing gap to now is drawn too, and the carried line adds nothing to the real data', () => {
  const trailing = carrySegments(GAPPY, 900, 3);
  assert.deepEqual(trailing.map((g) => g.toNow), [false, true]);
  assert.equal((render(trailing).match(/data-testid="chart-gap"/g) ?? []).length, 2);
  assert.equal(toItems(GAPPY, 'line', 900).length, GAPPY.length, 'items (= data-points) are the real points only');
  const candles = toItems(GAPPY, 'candles', 900);
  assert.equal(candles.length, 2, 'candles: one per real bucket, none invented inside the hole');
  assert.ok(candles.every((c) => c.t + c.w <= 1000 + 211 * 45 + 900 || c.t >= 1000 + 835 * 45 - 900));
  assert.deepEqual(tradeStats(GAPPY), tradeStats(GAPPY.map((p) => ({ ...p }))));
  assert.equal(tradeStats(GAPPY).n, 4); assert.equal(tradeStats(GAPPY).high, 130200);
});
