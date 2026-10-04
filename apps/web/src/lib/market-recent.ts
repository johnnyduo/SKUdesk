// "Recent results" of one market for the sealed book: the FINAL on-chain result of each of the last cleared epochs, newest first.
// Aggregated (folded, hourly) history points summarise many epochs, so they are skipped. An epoch whose book is not loaded still
// shows its clearing result, just without the order list. Pure: no React, no I/O.
import type { ClearPoint, EpochBook, OrderRow } from './market.ts';

export const RECENT_EPOCHS = 5;
export type RecentEpoch = {
  epoch: number; price: number; volume: number; forfeited: number; tx: string; block: number; time: number;
  orders: OrderRow[] | null; buyOrders: number | null; sellOrders: number | null;
};

export function recentEpochs(points: readonly ClearPoint[] | undefined, getBook: (epoch: number) => EpochBook | undefined, limit = RECENT_EPOCHS): RecentEpoch[] {
  if (!points) return [];
  const sorted = [...points].sort((a, b) => a.epoch - b.epoch);
  const out: RecentEpoch[] = []; const seen = new Set<number>();
  for (let i = sorted.length - 1; i >= 0 && out.length < limit; i--) {
    const p = sorted[i];
    if ((p.n !== undefined && p.n > 1) || seen.has(p.epoch)) continue;
    seen.add(p.epoch);
    const book = getBook(p.epoch);
    const orders = book && book.orders.length ? [...book.orders].sort((a, b) => a.index - b.index) : null;
    const revealed = orders ? orders.filter((o) => o.side !== undefined) : null;
    out.push({
      epoch: p.epoch, price: p.price, volume: p.volume, forfeited: p.forfeited, tx: p.tx, block: p.block, time: p.time, orders,
      buyOrders: revealed ? revealed.filter((o) => o.side === 0).length : null,
      sellOrders: revealed ? revealed.filter((o) => o.side === 1).length : null,
    });
  }
  return out;
}
