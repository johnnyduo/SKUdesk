// TypeScript mirror of BlindBook's clearing algorithm (packages/contracts/src/BlindBook.sol: _best, _allocate, _settle).
// The UI uses it to show an INDICATIVE clearing price while orders are being revealed; the final price always comes
// from the on-chain EpochCleared event. A differential test (book-parity) runs this against the real contract on hundreds
// of random books, so the two cannot drift apart silently. Pure: no imports, safe to unit test.
export type BookOrder = { side: 0 | 1; price: number; units: number; revealed?: boolean };
export type Clearing = { price: number; volume: number; fills: number[]; lo: number; hi: number };

/** Uniform-price call auction. `orders` is in commit order (the index is the time priority). Unrevealed orders are ignored. */
export function clearBook(orders: BookOrder[], tick = 1): Clearing {
  const live = (o: BookOrder) => o.revealed !== false;
  const n = orders.length; const fills = new Array<number>(n).fill(0);
  // V(p) = min(units bid at >= p, units offered at <= p) at every revealed price; the maximum is always attained at one of them
  const vs = orders.map((o) => {
    if (!live(o)) return 0; let d = 0, s = 0;
    for (const q of orders) { if (!live(q)) continue; if (q.side === 0) { if (q.price >= o.price) d += q.units; } else if (q.price <= o.price) s += q.units; }
    return Math.min(d, s);
  });
  const volume = Math.max(0, ...vs);
  if (volume === 0) return { price: 0, volume: 0, fills, lo: 0, hi: 0 };
  let lo = Infinity, hi = 0;
  orders.forEach((o, i) => { if (live(o) && vs[i] === volume) { lo = Math.min(lo, o.price); hi = Math.max(hi, o.price); } });
  const price = Math.floor(Math.floor((lo + hi) / 2) / tick) * tick;
  // price-time priority: buys by price desc, sells by price asc, ties by commit order; fill each side up to the volume
  for (const side of [0, 1] as const) {
    let remaining = volume; const taken = new Array<boolean>(n).fill(false);
    while (remaining > 0) {
      let best = -1;
      for (let i = 0; i < n; i++) {
        const o = orders[i]; if (taken[i] || !live(o) || o.side !== side) continue;
        if (side === 0 ? o.price < price : o.price > price) continue;
        if (best < 0 || (side === 0 ? o.price > orders[best].price : o.price < orders[best].price)) best = i;
      }
      if (best < 0) break;
      taken[best] = true; const f = Math.min(orders[best].units, remaining); fills[best] = f; remaining -= f;
    }
  }
  return { price, volume, fills, lo, hi };
}

/** Aggregate depth for charts: cumulative units at or beyond each price, per side. */
export function depth(orders: BookOrder[]): { bids: { price: number; units: number }[]; asks: { price: number; units: number }[] } {
  const live = orders.filter((o) => o.revealed !== false);
  const bids = [...new Set(live.filter((o) => o.side === 0).map((o) => o.price))].sort((a, b) => b - a).map((p) => ({ price: p, units: live.filter((o) => o.side === 0 && o.price >= p).reduce((s, o) => s + o.units, 0) }));
  const asks = [...new Set(live.filter((o) => o.side === 1).map((o) => o.price))].sort((a, b) => a - b).map((p) => ({ price: p, units: live.filter((o) => o.side === 1 && o.price <= p).reduce((s, o) => s + o.units, 0) }));
  return { bids, asks };
}
