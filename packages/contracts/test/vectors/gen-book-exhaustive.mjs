// EXHAUSTIVE book vectors in the same column format as book-vectors.json: EVERY book of 1..3 orders where each order is
// (side in {buy, sell}) x (price in {1,2,3} * tick) x (units in {1,2}), for tick 1 and tick 2 (12 order shapes, so
// 12 + 12^2 + 12^3 = 1884 books per tick, 3768 books in total). The expected answers come from the TypeScript mirror
// (apps/web/src/lib/book.ts). Consumed by ProofsClearing.t.sol, which clears every book with the real BlindBook clearing code
// and compares price, volume and every fill (and also checks each book against an in-Solidity brute-force oracle).
// Deterministic (no randomness). Regenerate with: node packages/contracts/test/vectors/gen-book-exhaustive.mjs
import { clearBook } from '../../../../apps/web/src/lib/book.ts';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function* allBooks(tick, maxN, prices, sizes) {
  const shapes = [];
  for (const side of [0, 1]) for (const k of prices) for (const u of sizes) shapes.push({ side, price: k * tick, units: u });
  for (let n = 1; n <= maxN; n++) {
    const idx = new Array(n).fill(0);
    while (true) {
      yield idx.map((i) => ({ ...shapes[i] }));
      let p = n - 1; while (p >= 0 && ++idx[p] === shapes.length) { idx[p] = 0; p--; }
      if (p < 0) break;
    }
  }
}

export function buildExhaustive() {
  const cols = { tick: [], n: [], actor: [], side: [], price: [], units: [], expPrice: [], expVolume: [], expFill: [] };
  for (const tick of [1, 2]) for (const orders of allBooks(tick, 3, [1, 2, 3], [1, 2])) {
    const res = clearBook(orders, tick);
    cols.tick.push(tick); cols.n.push(orders.length); cols.expPrice.push(res.price); cols.expVolume.push(res.volume);
    orders.forEach((o, i) => { cols.actor.push(i % 5); cols.side.push(o.side); cols.price.push(o.price); cols.units.push(o.units); cols.expFill.push(res.fills[i]); });
  }
  return cols;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const cols = buildExhaustive();
  fs.writeFileSync(new URL('./book-vectors-exhaustive.json', import.meta.url), JSON.stringify(cols));
  console.log('exhaustive books:', cols.n.length, 'orders:', cols.side.length, 'with trades:', cols.expVolume.filter((x) => x > 0).length);
}
