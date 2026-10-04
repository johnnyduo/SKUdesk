// node --test apps/web/src/lib/book.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearBook, depth, type BookOrder } from './book.ts';

const B = (price: number, units: number): BookOrder => ({ side: 0, price, units });
const S = (price: number, units: number): BookOrder => ({ side: 1, price, units });

test('midpoint of the maximal-volume interval, best buy meets best sell', () => {
  const r = clearBook([B(100, 10), B(90, 10), S(80, 10), S(95, 10)]);
  assert.equal(r.price, 90); assert.equal(r.volume, 10); assert.deepEqual(r.fills, [10, 0, 10, 0]);
});
test('price is rounded down to the tick', () => { assert.equal(clearBook([B(95, 10), S(80, 10)], 5).price, 85); });
test('no cross means no trade', () => { const r = clearBook([B(50, 10), S(60, 10)]); assert.equal(r.price, 0); assert.equal(r.volume, 0); assert.deepEqual(r.fills, [0, 0]); });
test('partial fill by price-time priority', () => { const r = clearBook([B(100, 6), B(100, 6), S(90, 8)]); assert.equal(r.price, 95); assert.deepEqual(r.fills, [6, 2, 8]); });
test('cheaper ask is filled first', () => { const r = clearBook([B(100, 5), S(80, 5), S(85, 5)]); assert.equal(r.price, 90); assert.deepEqual(r.fills, [5, 5, 0]); });
test('unrevealed orders are ignored', () => { const r = clearBook([B(100, 10), { ...S(90, 10), revealed: false }, S(95, 10)]); assert.equal(r.price, 97); assert.equal(r.fills[1], 0); });
test('depth is cumulative and sorted away from the touch', () => {
  const d = depth([B(100, 5), B(90, 5), S(95, 3), S(99, 4)]);
  assert.deepEqual(d.bids, [{ price: 100, units: 5 }, { price: 90, units: 10 }]); assert.deepEqual(d.asks, [{ price: 95, units: 3 }, { price: 99, units: 7 }]);
});

// properties against an independent brute-force reference over thousands of random books
function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
test('5000 random books: maximal volume, limits respected, both sides equal, no overfill, priority', () => {
  const r = rng(46630);
  for (let k = 0; k < 5000; k++) {
    const n = 2 + Math.floor(r() * 12); const orders: BookOrder[] = [];
    for (let i = 0; i < n; i++) orders.push({ side: r() < 0.5 ? 0 : 1, price: 1 + Math.floor(r() * 40), units: 1 + Math.floor(r() * 15) });
    const res = clearBook(orders);
    let vmax = 0, lo = 0, hi = 0;
    for (let p = 1; p <= 40; p++) { let d = 0, s = 0; for (const o of orders) { if (o.side === 0 && o.price >= p) d += o.units; if (o.side === 1 && o.price <= p) s += o.units; } const v = Math.min(d, s); if (v > vmax) { vmax = v; lo = p; hi = p; } else if (v === vmax && v > 0) hi = p; }
    assert.equal(res.volume, vmax, 'volume is maximal'); if (vmax > 0) assert.equal(res.price, Math.floor((lo + hi) / 2));
    let bf = 0, sf = 0;
    orders.forEach((o, i) => {
      assert.ok(res.fills[i] <= o.units); if (res.fills[i] > 0) assert.ok(o.side === 0 ? o.price >= res.price : o.price <= res.price);
      if (o.side === 0) bf += res.fills[i]; else sf += res.fills[i];
      orders.forEach((q, j) => { if (i !== j && q.side === o.side && res.fills[j] > 0 && res.fills[i] < o.units) { const better = o.side === 0 ? o.price > q.price || (o.price === q.price && i < j) : o.price < q.price || (o.price === q.price && i < j); assert.ok(!better, 'a better or earlier order is never skipped'); } });
    });
    assert.equal(bf, vmax); assert.equal(sf, vmax);
  }
});
