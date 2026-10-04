// node --test test/market/price-chart-items.test.ts   (from apps/web)
// The chart's items from clearing points: an aggregated (hourly) point keeps its n, high and low in the line and in the candles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNodeModule } from '../site/helpers/bundle.ts';

const { toItems } = await loadNodeModule<{ toItems(p: unknown[], mode: 'line' | 'candles', tf: number): any[] }>(`export { toItems } from './src/components/market/PriceChart.tsx';`);
const cp = (epoch: number, time: number, price: number, over: Record<string, number> = {}) => ({ epoch, time, price, volume: 5, buys: 1, sells: 1, forfeited: 0, tx: '', block: 1, ...over });
const PTS = [cp(10, 3600, 1000, { n: 60, high: 1300, low: 800 }), cp(90, 7300, 1100), cp(91, 7345, 1050)];

test('line: a folded point keeps its range and its epoch count; a plain point stands for one epoch', () => {
  const it = toItems(PTS, 'line', 900);
  assert.deepEqual(it.map((x) => [x.epoch, x.c, x.h, x.l, x.n]), [[10, 1000, 1300, 800, 60], [90, 1100, 1100, 1100, 1], [91, 1050, 1050, 1050, 1]]);
});

test('candles: high/low come from the folded ranges and n sums the epochs, open/close stay first/last prices', () => {
  const it = toItems([...PTS, cp(11, 3700, 900)], 'candles', 3600);
  assert.deepEqual(it.map((x) => [x.t, x.o, x.c, x.h, x.l, x.n]), [[3600, 1000, 900, 1300, 800, 61], [7200, 1100, 1050, 1100, 1050, 2]]);
});

test('candles: an hourly aggregate (n>1) keeps its own one-hour span in every timeframe and is never squeezed into a 5 or 15 minute bucket', () => {
  for (const tf of [300, 900]) {
    const it = toItems(PTS, 'candles', tf);
    const agg = it.find((x) => x.n === 60)!;
    assert.deepEqual([agg.t, agg.w, agg.h, agg.l], [3600, 3600, 1300, 800], `tf ${tf}: the aggregate covers its whole hour, so the tooltip may not say ${tf / 60} minutes`);
    assert.ok(it.filter((x) => x.n === 1).every((x) => x.w === tf), 'plain points keep the chosen bucket');
  }
  assert.ok(toItems(PTS, 'candles', 3600).every((x) => x.w === 3600));
});
