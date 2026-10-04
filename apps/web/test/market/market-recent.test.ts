// node --test test/market/market-recent.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentEpochs, RECENT_EPOCHS } from '../../src/lib/market-recent.ts';

const pt = (epoch: number, over: Record<string, unknown> = {}) => ({ epoch, time: 1790958692 + epoch * 45, price: 1099, volume: 4, buys: 2, sells: 2, forfeited: 0, tx: '0x' + String(epoch).padStart(64, '0'), block: 128000000 + epoch, ...over }) as any;
const order = (index: number, side?: 0 | 1, filled?: number) => ({ index, trader: '0x' + String(index).padStart(40, '0'), hash: '0xh' + index, ...(side === undefined ? {} : { side, price: 1099, units: 3, filled }) });

test('newest first, at most RECENT_EPOCHS, folded aggregates skipped, duplicate epochs once, sorted by epoch', () => {
  const pts = [pt(1), pt(2, { n: 5, high: 1200, low: 1000 }), ...Array.from({ length: 10 }, (_, i) => pt(10 + i)), pt(19)];
  assert.equal(RECENT_EPOCHS, 5);
  assert.deepEqual(recentEpochs(pts, () => undefined).map((x) => x.epoch), [19, 18, 17, 16, 15]);
  assert.ok(!recentEpochs(pts, () => undefined, 50).some((x) => x.epoch === 2), 'an aggregated history point is not one epoch result');
  assert.deepEqual(recentEpochs(undefined, () => undefined), []);
  assert.deepEqual(recentEpochs([pt(3), pt(1), pt(2)], () => undefined).map((x) => x.epoch), [3, 2, 1]);
});

test('orders come from the loaded book, sorted by index; side counts include revealed orders only', () => {
  const book = { marketId: 'm', epoch: 12, orders: [order(2, 1, 3), order(0, 0, 3), order(1)] } as any;
  const [r] = recentEpochs([pt(12)], (e) => (e === 12 ? book : undefined));
  assert.deepEqual(r.orders!.map((o) => o.index), [0, 1, 2]);
  assert.deepEqual([r.buyOrders, r.sellOrders], [1, 1]);
  assert.deepEqual([r.price, r.volume, r.tx, r.block], [1099, 4, pt(12).tx, 128000012]);
});

test('an epoch whose book is not loaded (or is empty) still shows its clearing result, without orders', () => {
  const [r] = recentEpochs([pt(7)], () => undefined);
  assert.deepEqual([r.orders, r.buyOrders, r.sellOrders], [null, null, null]);
  assert.equal(recentEpochs([pt(8)], () => ({ marketId: 'm', epoch: 8, orders: [] }) as any)[0].orders, null);
});
