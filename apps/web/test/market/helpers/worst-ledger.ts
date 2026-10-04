// Synthetic worst-case ledgers shared by market-cache-worst.test.ts and market-cache-fit.test.ts (all 18 catalog markets, 30 000 epochs of clears).
import { readFileSync } from 'node:fs';
import { newLedger, type ClearPoint, type CoreBook, type Ledger } from '../../../src/lib/market-core.ts';
import { HOT_EPOCHS } from '../../../src/lib/market-snap.ts';
import { cacheId } from '../../../src/lib/market-cache.ts';
import assert from 'node:assert/strict';

export const CATALOG = JSON.parse(readFileSync(new URL('../../../src/data/catalog.json', import.meta.url), 'utf8')).markets as { id: string }[];
export const SCHED = { t0: 1790958692, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2_000_000 };
export const ID = { chainId: 46630, book: '0x2ba62631d74827abf2f7467b20370dc2dc59aa11', deployBlock: 127690064 };
export const HISTORY_EPOCHS = 30_000, TOP = 30_000;   // newest epoch number
export const hex = (n: number, len: number) => '0x' + n.toString(16).padStart(len, '0');
export const mkt = (i: number) => hex(0xa0000 + i, 64);
const wallet = (i: number) => hex(0xb000 + i, 40);

export type Shape = { marketsPerEpoch: number; orders: number };
/** A ledger with `HISTORY_EPOCHS` epochs of clears per market (alternating traded / no-trade, so every hour holds both kinds) and the hot window's books. */
export function ledgerOf({ marketsPerEpoch, orders }: Shape): Ledger {
  const l = newLedger(); const markets = CATALOG.map((_, i) => mkt(i)); const n = markets.length;
  assert.equal(n, 18, 'the catalog has 18 markets');
  const quoted = (e: number, mi: number) => ((mi - e * marketsPerEpoch) % n + n) % n < marketsPerEpoch;   // keeper-style rotation, or every market
  for (const [mi, m] of markets.entries()) {
    const byE = new Map<number, ClearPoint>();
    for (let e = TOP - HISTORY_EPOCHS + 1; e <= TOP; e++) {
      if (!quoted(e, mi)) continue;
      byE.set(e, { epoch: e, time: SCHED.t0 + e * 45 + 35, price: 1_000_000 + ((e * 7 + mi) % 99_999), volume: e % 2 ? 24 : 0, buys: 12, sells: 12, forfeited: 1, tx: hex(e * 100 + mi, 64), block: 127_690_064 + e * 90 });
    }
    l.clears.set(m, byE);
    for (let e = TOP - HOT_EPOCHS + 1; e <= TOP; e++) {
      if (!quoted(e, mi)) continue;
      const b: CoreBook = { market: m, epoch: e, firstBlock: 127_690_064 + e * 90, lastBlock: 127_690_064 + e * 90 + 89, orders: [], clear: { price: 1_000_000 + (e % 99_999), volume: 24, buys: 12, sells: 12, forfeited: 0, tx: hex(e * 100 + mi, 64), block: 127_690_064 + e * 90 + 80 } };
      for (let i = 0; i < orders; i++) b.orders.push({ index: i, trader: wallet(i % 6), hash: hex(e * 1000 + i + mi, 64), side: (i % 2) as 0 | 1, price: 1_000_000 + i * 997, units: 24, filled: 24 });
      l.books.set(`${m}:${e}`, b);
      byE.set(e, { epoch: e, time: SCHED.t0 + e * 45 + 35, ...b.clear!, price: b.clear!.price });   // as in a real ledger: the clearing point IS the book's clear
    }
  }
  return l;
}
export const CURSOR = 135_000_000;   // above every block the synthetic ledger holds (127_690_064 + 30_000 x 90 + 80)
export const META = { ...ID, cursor: CURSOR, head: CURSOR, headTime: 1, builtAt: 1, complete: true };
export const envelope = (snap: unknown) => JSON.stringify({ k: cacheId(ID), savedAt: 1, body: snap });
export const TODAY: Shape = { marketsPerEpoch: 1, orders: 6 }, WORST: Shape = { marketsPerEpoch: 18, orders: 24 };
