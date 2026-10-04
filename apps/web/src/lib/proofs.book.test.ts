// Test backing for docs/proofs/clearing.md (theorems C1, C2, C3, C6, C7) on the TypeScript mirror: exhaustive enumeration on small domains, not a formal verification.
// Run: node --test apps/web/src/lib/proofs.book.test.ts
// Exhaustive: EVERY book of <= 4 orders over 5 tick prices, sizes 1..3, both sides (837,930 books per tick, ticks 1 and 3),
// plus every book of <= 3 orders including unrevealed ones (33,824 books), against an independent brute-force oracle. The Solidity side is tied
// in through test/vectors/book-vectors-exhaustive.json (same format as book-vectors.json), cleared on-chain by ProofsClearing.t.sol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { clearBook, type BookOrder } from './book.ts';
import { clockAt } from './market.ts';
// @ts-ignore - plain .mjs module without type declarations
import { allBooks, buildExhaustive } from '../../../../packages/contracts/test/vectors/gen-book-exhaustive.mjs';

/** Oracle: V(p) at EVERY tick price 1..maxTick (not just revealed prices); fills by SORTING eligible orders. */
function oracle(orders: BookOrder[], tick: number, maxTick: number) {
  const live = orders.map((o) => o.revealed !== false); const n = orders.length;
  const V = (p: number) => { let d = 0, s = 0; orders.forEach((o, i) => { if (!live[i]) return; if (o.side === 0 ? o.price >= p : o.price <= p) { if (o.side === 0) d += o.units; else s += o.units; } }); return Math.min(d, s); };
  let vmax = 0, lo = 0, hi = 0;
  for (let k = 1; k <= maxTick; k++) { const p = k * tick, v = V(p); if (v > vmax) { vmax = v; lo = p; hi = p; } else if (v === vmax && v > 0) hi = p; }
  const fills = new Array<number>(n).fill(0);
  if (vmax === 0) return { price: 0, volume: 0, fills, lo, hi, V };
  const price = Math.floor((lo + hi) / (2 * tick)) * tick;
  for (const side of [0, 1]) {
    const el = orders.map((o, i) => i).filter((i) => live[i] && orders[i].side === side && (side === 0 ? orders[i].price >= price : orders[i].price <= price));
    el.sort((a, b) => (side === 0 ? orders[b].price - orders[a].price : orders[a].price - orders[b].price) || a - b);
    let rem = vmax; for (const i of el) { const f = Math.min(orders[i].units, rem); fills[i] = f; rem -= f; }
    assert.equal(rem, 0, 'lemma C1.3: the eligible side covers vmax');
  }
  return { price, volume: vmax, fills, lo, hi, V };
}

function checkBook(orders: BookOrder[], tick: number, maxTick: number, st: { traded: number; ties: number; partial: number; rounded: number }) {
  const r = clearBook(orders, tick); const o = oracle(orders, tick, maxTick);
  if (r.price !== o.price || r.volume !== o.volume || r.fills.some((f, i) => f !== o.fills[i])) assert.fail(`mirror != oracle: ${JSON.stringify({ orders, tick, r, o: { price: o.price, volume: o.volume, fills: o.fills } })}`);
  if (r.volume > 0) {
    st.traded++; if (o.lo < o.hi) st.ties++; if (2 * r.price < o.lo + o.hi) st.rounded++;
    // C1: p* is a maximal-volume tick price inside [lo, hi]
    if (o.V(r.price) !== r.volume || r.price < o.lo || r.price > o.hi || r.price % tick !== 0) assert.fail('C1');
    let b = 0, s = 0;
    orders.forEach((q, i) => {
      const f = r.fills[i];
      if (f > q.units || (f > 0 && q.revealed === false)) assert.fail('C2 overfill / unrevealed fill');
      if (f > 0 && (q.side === 0 ? q.price < r.price : q.price > r.price)) assert.fail('C2 individual rationality');
      if (f > 0 && f < q.units) st.partial++;
      if (q.side === 0) b += f; else s += f;
    });
    // C3 + C4 (cash): both sides fill exactly the volume, so buyers pay p* * V and sellers receive p* * V: zero dust
    if (b !== r.volume || s !== r.volume) assert.fail('C3');
  } else if (r.price !== 0 || r.fills.some((f) => f !== 0)) assert.fail('no-trade book must have price 0 and no fills');
}

test('C6 vectors: book-vectors-exhaustive.json is exactly the deterministic complete enumeration', () => {
  const onDisk = JSON.parse(fs.readFileSync(new URL('../../../../packages/contracts/test/vectors/book-vectors-exhaustive.json', import.meta.url), 'utf8'));
  assert.deepEqual(onDisk, buildExhaustive(), 'regenerate: node packages/contracts/test/vectors/gen-book-exhaustive.mjs');
  assert.equal(onDisk.n.length, 3768);
});

for (const tick of [1, 3]) {
  test(`C1-C3, C6 exhaustive: every book of <= 4 orders, 5 prices x 3 sizes x 2 sides, tick ${tick} (837,930 books) == oracle`, () => {
    const st = { traded: 0, ties: 0, partial: 0, rounded: 0 }; let books = 0;
    for (const orders of allBooks(tick, 4, [1, 2, 3, 4, 5], [1, 2, 3])) { checkBook(orders, tick, 5, st); books++; }
    assert.equal(books, 30 + 30 ** 2 + 30 ** 3 + 30 ** 4);
    assert.ok(st.traded > 300_000 && st.ties > 100_000 && st.partial > 100_000 && st.rounded > 50_000, `non-vacuous ${JSON.stringify(st)}`);
  });
}

test('C1-C3, C6 exhaustive with unrevealed orders: every book of <= 3 orders over 32 shapes (30 revealed + 2 unrevealed; 33,824 books), tick 2', () => {
  const shapes: BookOrder[] = [];
  for (const side of [0, 1] as const) for (const k of [1, 2, 3, 4, 5]) for (const u of [1, 2, 3]) shapes.push({ side, price: 2 * k, units: u });
  shapes.push({ side: 0, price: 2, units: 1, revealed: false }); shapes.push({ side: 1, price: 10, units: 3, revealed: false });
  const st = { traded: 0, ties: 0, partial: 0, rounded: 0 }; let books = 0;
  const rec = (acc: BookOrder[], left: number) => { if (acc.length > 0) { checkBook(acc.map((o) => ({ ...o })), 2, 5, st); books++; } if (left === 0) return; for (const s of shapes) rec([...acc, s], left - 1); };
  rec([], 3);
  assert.equal(books, 32 + 32 ** 2 + 32 ** 3);
  assert.ok(st.traded > 10_000, 'non-vacuous');
});

test('C6: the 400 existing parity vectors (book-vectors.json) also satisfy the oracle', () => {
  const j = JSON.parse(fs.readFileSync(new URL('../../../../packages/contracts/test/vectors/book-vectors.json', import.meta.url), 'utf8'));
  let off = 0; const st = { traded: 0, ties: 0, partial: 0, rounded: 0 };
  for (let v = 0; v < j.n.length; v++) {
    const orders: BookOrder[] = []; for (let i = 0; i < j.n[v]; i++) orders.push({ side: j.side[off + i], price: j.price[off + i], units: j.units[off + i] });
    checkBook(orders, j.tick[v], 40, st);
    const o = oracle(orders, j.tick[v], 40); assert.equal(o.price, j.expPrice[v]); assert.equal(o.volume, j.expVolume[v]);
    for (let i = 0; i < j.n[v]; i++) assert.equal(o.fills[i], j.expFill[off + i]);
    off += j.n[v];
  }
  assert.ok(st.traded > 100);
});

test('C7: clockAt (UI) equals the contract phase/epoch formula for every integer second, schedules up to L = 12', () => {
  let checks = 0;
  for (let L = 2; L <= 12; L++) for (let re = 1; re < L; re++) for (let ce = 0; ce < re; ce++) {
    const t0 = 1_000; const s = { t0, epochLen: L, commitEnd: ce, revealEnd: re, bond: 0 };
    for (let t = t0; t < t0 + 5 * L; t++) {
      const off = (t - t0) % L; const want = off < ce ? 'commit' : off < re ? 'reveal' : 'clear';
      const c = clockAt(s, t);
      assert.equal(c.epoch, Math.floor((t - t0) / L)); assert.equal(c.phase, want); assert.equal(c.offset, off);
      assert.ok(c.secondsLeft >= 1, 'every phase has a positive remaining length at an integer second');
      checks++;
    }
  }
  assert.ok(checks > 10_000);
});
