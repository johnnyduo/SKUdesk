// Generates random books and the TypeScript mirror's answers, for the Solidity parity test (BlindBookParity.t.sol).
// Deterministic (seeded). Regenerate with: node packages/contracts/test/vectors/gen-book-vectors.mjs
import { clearBook } from '../../../../apps/web/src/lib/book.ts';
import fs from 'node:fs';
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(4663);
const cols = { tick: [], n: [], actor: [], side: [], price: [], units: [], expPrice: [], expVolume: [], expFill: [] };
const V = 400;
for (let v = 0; v < V; v++) {
  const tick = v % 3 === 0 ? 5 : 1; const maxT = tick === 5 ? 12 : 40; const n = 2 + Math.floor(r() * 14);
  const orders = [];
  for (let i = 0; i < n; i++) orders.push({ side: r() < 0.5 ? 0 : 1, price: tick * (1 + Math.floor(r() * maxT)), units: 1 + Math.floor(r() * 15), actor: Math.floor(r() * 5) });
  const res = clearBook(orders, tick);
  cols.tick.push(tick); cols.n.push(n); cols.expPrice.push(res.price); cols.expVolume.push(res.volume);
  for (let i = 0; i < n; i++) { cols.actor.push(orders[i].actor); cols.side.push(orders[i].side); cols.price.push(orders[i].price); cols.units.push(orders[i].units); cols.expFill.push(res.fills[i]); }
}
fs.writeFileSync(new URL('./book-vectors.json', import.meta.url), JSON.stringify(cols));
console.log('vectors:', V, 'orders:', cols.side.length, 'with trades:', cols.expVolume.filter((x) => x > 0).length);
