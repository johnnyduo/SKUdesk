// Shared core of the /market data layer. Runs unchanged in the browser (lib/market.ts), in the Worker (cron ingest and the
// snapshot route) and in Node tests. Dependency-free on purpose: no viem, no DOM, no Workers globals.
//   decodeLog    raw eth_getLogs entry -> MarketEvent (only the four BlindBook market events; anything else is null)
//   applyEvents  folds events into a Ledger. Order-independent and idempotent: any arrival order (newest chunk first,
//                overlapping re-reads, duplicates) ends in the same state. Conflicting duplicates of a clear (same market and
//                epoch) or of a fill (same order) are resolved by the greater (block, tx hash) pair, never by arrival order.
//   traderOrder  every trader wallet seen, ordered by the position of its earliest known order (stable labels for wallets)
//   views        clear points per market, fills, live books, per-market summaries, all derived in chronological order.

export const TOPICS = {
  commit: '0x35b40b32da2f1b3785ff0610aa3cc6be770cc1a7a4f925c46b906a81b937dacf', // Committed(bytes32,uint256,uint256,address,bytes32)
  reveal: '0x9387de0c497d7c0d28fd9ae5059019c782ed124c45a7e177653e8caa2b389e01', // Revealed(bytes32,uint256,uint256,address,uint8,uint256,uint256)
  fill: '0x0322763aeeb80b92cfe722292ea1e9ee7a3a31c26e086701b5e06a17a293dce6', // Fill(bytes32,uint256,uint256,address,uint8,uint256,uint256)
  clear: '0xbb2d1e15bc81d4183ebf63b19acfc5ac6c5f42b21e0d3842a127f69603d0c11a', // EpochCleared(bytes32,uint256,uint256,uint256,uint256,uint256,uint256)
} as const;
/** topic0 filter for eth_getLogs: any of the four market events. */
export const MARKET_TOPICS: string[] = [TOPICS.commit, TOPICS.reveal, TOPICS.fill, TOPICS.clear];

export type RawLog = { topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string; removed?: boolean };
type EventBase = { market: string; epoch: number; block: number; logIndex: number; tx: string };
export type MarketEvent =
  | (EventBase & { kind: 'commit'; index: number; trader: string; hash: string })
  | (EventBase & { kind: 'reveal'; index: number; trader: string; side: 0 | 1; price: number; units: number })
  | (EventBase & { kind: 'fill'; index: number; trader: string; side: 0 | 1; units: number; price: number })
  | (EventBase & { kind: 'clear'; price: number; volume: number; buys: number; sells: number; forfeited: number });

export type Schedule = { t0: number; epochLen: number; commitEnd: number; revealEnd: number; bond: number };
export type CoreOrder = { index: number; trader: string; hash: string; side?: 0 | 1; price?: number; units?: number; filled?: number };
export type CoreClear = { price: number; volume: number; buys: number; sells: number; forfeited: number; tx: string; block: number };
export type CoreBook = { market: string; epoch: number; orders: CoreOrder[]; clear?: CoreClear; firstBlock: number; lastBlock: number };
/** One clearing point. `n`, `high`, `low` are set only on aggregated (downsampled) points: n epochs folded into one. */
export type ClearPoint = { epoch: number; time: number; price: number; volume: number; buys: number; sells: number; forfeited: number; tx: string; block: number; n?: number; high?: number; low?: number };
export type FillRow = { epoch: number; marketId: string; index: number; trader: string; side: 0 | 1; units: number; price: number; tx: string; block: number; time: number };
/** books: every loaded (market, epoch) book. clears: clearing points by market, including old ones that have no book (from a snapshot). */
export type Ledger = {
  books: Map<string, CoreBook>; clears: Map<string, Map<number, ClearPoint>>;
  /** Per market: the highest epoch already summed into an aggregated (folded) clear point. Set by hydrate; clear events at or below it are ignored. */
  foldedThrough?: Map<string, number>;
  /** Per trader wallet (lowercase): the (block, logIndex) of its earliest known order. Created on first use; see traderOrder. */
  traderFirst?: Map<string, { block: number; logIndex: number }>;
};

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEXNUM = /^0x[0-9a-f]+$/;
/** A 32-byte word as a safe integer; NaN when it would not fit in 52 bits (never silently rounded). */
function uint(word: string): number {
  if (word.length !== 64) return NaN;
  const t = word.replace(/^0+/, '');
  if (t.length > 13) return NaN;
  return t ? parseInt(t, 16) : 0;
}
function hexInt(s: string): number {
  const v = String(s ?? '').toLowerCase();
  if (!HEXNUM.test(v) || v.length > 15) return NaN;
  return parseInt(v.slice(2), 16);
}
const ok = (...ns: number[]) => ns.every((n) => Number.isSafeInteger(n) && n >= 0);

export const newLedger = (): Ledger => ({ books: new Map(), clears: new Map() });
export const bookKey = (market: string, epoch: number) => `${market.toLowerCase()}:${epoch}`;
/** Unix seconds at which an epoch's clearing window opens (fills and clears are stamped with it). 0 without a schedule. */
export const clearTime = (s: Schedule | undefined, epoch: number) => (s ? s.t0 + epoch * s.epochLen + s.revealEnd : 0);

export function decodeLog(l: RawLog): MarketEvent | null {
  if (!l || l.removed === true || !Array.isArray(l.topics) || typeof l.data !== 'string') return null;
  const t0 = String(l.topics[0] ?? '').toLowerCase();
  const kind = t0 === TOPICS.commit ? 'commit' : t0 === TOPICS.reveal ? 'reveal' : t0 === TOPICS.fill ? 'fill' : t0 === TOPICS.clear ? 'clear' : null;
  if (!kind) return null;
  const market = String(l.topics[1] ?? '').toLowerCase(); const epochTopic = String(l.topics[2] ?? '').toLowerCase();
  if (!HEX32.test(market) || !HEX32.test(epochTopic)) return null;
  const data = l.data.toLowerCase(); const words = kind === 'commit' ? 2 : kind === 'clear' ? 5 : 4;
  if (!/^0x[0-9a-f]*$/.test(data) || data.length < 2 + 64 * words) return null;
  const w = (i: number) => data.slice(2 + 64 * i, 66 + 64 * i);
  const tx = String(l.transactionHash ?? '').toLowerCase();
  const base = { market, epoch: uint(epochTopic.slice(2)), block: hexInt(l.blockNumber), logIndex: hexInt(l.logIndex), tx };
  if (!ok(base.epoch, base.block, base.logIndex) || !HEX32.test(tx)) return null;
  if (kind === 'clear') {
    const [price, volume, buys, sells, forfeited] = [0, 1, 2, 3, 4].map((i) => uint(w(i)));
    return ok(price, volume, buys, sells, forfeited) ? { ...base, kind, price, volume, buys, sells, forfeited } : null;
  }
  const traderTopic = String(l.topics[3] ?? '').toLowerCase();
  if (!HEX32.test(traderTopic) || !/^0x0{24}/.test(traderTopic)) return null;
  const trader = '0x' + traderTopic.slice(26); const index = uint(w(0));
  if (!ok(index)) return null;
  if (kind === 'commit') return { ...base, kind, index, trader, hash: '0x' + w(1) };
  const side = uint(w(1));
  if (side !== 0 && side !== 1) return null;
  if (kind === 'reveal') { const price = uint(w(2)), units = uint(w(3)); return ok(price, units) ? { ...base, kind, index, trader, side, price, units } : null; }
  const units = uint(w(2)), price = uint(w(3));
  return ok(price, units) ? { ...base, kind, index, trader, side, units, price } : null;
}

/** Decodes a batch, drops everything that is not a market event, and returns them in chain order (block, logIndex). */
export function decodeLogs(logs: RawLog[]): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const l of logs) { const e = decodeLog(l); if (e) out.push(e); }
  return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

function orderOf(b: CoreBook, index: number, trader: string): CoreOrder {
  let lo = 0, hi = b.orders.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (b.orders[mid].index < index) lo = mid + 1; else hi = mid; }
  if (b.orders[lo]?.index === index) return b.orders[lo];
  const o: CoreOrder = { index, trader, hash: '' }; b.orders.splice(lo, 0, o); return o;
}

type Stamp = { block: number; tx: string };
/** True when `a` is strictly later than `b` by (block, tx hash). Equal means the same event. */
const later = (a: Stamp, b: Stamp) => (a.block !== b.block ? a.block > b.block : a.tx > b.tx);
/** Per order: the fill that set `filled` (the winner among conflicting fills) and whether `side` came from it. Not part of the ledger shape. */
const fillWinner = new WeakMap<CoreOrder, Stamp & { side: boolean }>();

/** Lowers a wallet's recorded earliest position to (block, logIndex) when that is earlier. A min, so it is order-independent and idempotent. */
export function noteTrader(ledger: Ledger, trader: string, block: number, logIndex: number): void {
  const m = (ledger.traderFirst ??= new Map()); const k = trader.toLowerCase(); const cur = m.get(k);
  if (!cur || block < cur.block || (block === cur.block && logIndex < cur.logIndex)) m.set(k, { block, logIndex });
}
/**
 * Every trader wallet seen so far (lowercase), ordered by the (block, logIndex) of its earliest known order (any commit, reveal or fill; for
 * a wallet whose commit is loaded that is its first commit), ties by address. Same list for any arrival order of the same events, and equal to
 * "first Committed in chain order" once the history is complete. With older history still missing, a wallet sits where its earliest LOADED order
 * puts it, so the list can reorder while history backfills. Orders that came from a snapshot (hydrate) have no log position: they are placed at
 * (their book's firstBlock, their order index), which is exact in order within a book and approximate across books of different markets.
 */
export function traderOrder(ledger: Ledger): string[] {
  return [...(ledger.traderFirst ?? [])].sort((a, b) => a[1].block - b[1].block || a[1].logIndex - b[1].logIndex || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[0]);
}

/** Folds events into the ledger and returns the keys of the books it touched. Safe to call with duplicates and in any order. */
export function applyEvents(ledger: Ledger, events: MarketEvent[], schedule?: Schedule): Set<string> {
  const touched = new Set<string>();
  for (const e of events) {
    if (e.kind === 'clear' && e.epoch <= (ledger.foldedThrough?.get(e.market) ?? -1)) continue; // already inside a folded point: re-applying it would double count or overwrite the aggregate
    const k = bookKey(e.market, e.epoch); let b = ledger.books.get(k);
    if (!b) { b = { market: e.market, epoch: e.epoch, orders: [], firstBlock: e.block, lastBlock: e.block }; ledger.books.set(k, b); }
    if (e.block < b.firstBlock) b.firstBlock = e.block;
    if (e.block > b.lastBlock) b.lastBlock = e.block;
    if (e.kind === 'clear') {
      let m = ledger.clears.get(e.market); if (!m) { m = new Map(); ledger.clears.set(e.market, m); }
      const prevPoint = m.get(e.epoch); const prior = b.clear ?? prevPoint;
      const time = schedule ? clearTime(schedule, e.epoch) : prevPoint?.time ?? 0;
      if (!prior || later(e, prior)) {
        b.clear = { price: e.price, volume: e.volume, buys: e.buys, sells: e.sells, forfeited: e.forfeited, tx: e.tx, block: e.block };
        m.set(e.epoch, { epoch: e.epoch, time, price: e.price, volume: e.volume, buys: e.buys, sells: e.sells, forfeited: e.forfeited, tx: e.tx, block: e.block });
      } else if (prevPoint && !prevPoint.time) prevPoint.time = time;
    } else {
      const o = orderOf(b, e.index, e.trader); o.trader = e.trader; noteTrader(ledger, e.trader, e.block, e.logIndex);
      if (e.kind === 'commit') o.hash = e.hash;
      else if (e.kind === 'reveal') { o.side = e.side; o.price = e.price; o.units = e.units; const w = fillWinner.get(o); if (w) w.side = false; }
      else {
        const w = fillWinner.get(o);
        if (!w || later(e, w)) {
          o.filled = e.units;
          if (o.side === undefined || w?.side) { o.side = e.side; fillWinner.set(o, { block: e.block, tx: e.tx, side: true }); }
          else fillWinner.set(o, { block: e.block, tx: e.tx, side: false });
        }
      }
    }
    touched.add(k);
  }
  return touched;
}

/** Re-stamps every clear point's time once the schedule is known (points ingested before it carry time 0). */
export function stampTimes(ledger: Ledger, schedule: Schedule): void {
  for (const m of ledger.clears.values()) for (const c of m.values()) if (!c.time) c.time = clearTime(schedule, c.epoch);
}

/** Clearing points per market (lower-case market id), ascending by epoch. */
export function clearPoints(ledger: Ledger): Record<string, ClearPoint[]> {
  const out: Record<string, ClearPoint[]> = {};
  for (const [m, byEpoch] of ledger.clears) out[m] = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  return out;
}

/** Fills derived from the books (a Fill is emitted inside clear(), so its price and tx are the clearing price and tx). Newest first. */
export function fillRows(ledger: Ledger, schedule: Schedule | undefined, limit = 400): FillRow[] {
  const out: FillRow[] = [];
  for (const b of ledger.books.values()) {
    if (!b.clear) continue;
    for (const o of b.orders) if (o.filled && o.filled > 0) out.push({ epoch: b.epoch, marketId: b.market, index: o.index, trader: o.trader, side: o.side ?? 0, units: o.filled, price: b.clear.price, tx: b.clear.tx, block: b.clear.block, time: clearTime(schedule, b.epoch) });
  }
  return out.sort((a, b) => b.block - a.block || b.epoch - a.epoch || a.marketId.localeCompare(b.marketId) || b.index - a.index).slice(0, limit);
}

/** The newest book per market (the "live" epoch), orders sorted by index. */
export function liveBooks(ledger: Ledger): Record<string, CoreBook> {
  const out: Record<string, CoreBook> = {};
  for (const b of ledger.books.values()) { const cur = out[b.market]; if (!cur || b.epoch > cur.epoch) out[b.market] = b; }
  return out;
}

export type MarketSummary = { last: number; lastEpoch: number; change: number; prices: number[] };
/** Traded points the change% is measured over. */
export const CHANGE_WINDOW = 120;
/** First and last point of the change% window: the newest CHANGE_WINDOW traded points, never starting on an aggregated (folded, hourly) point. */
export function changeWindow(points: ClearPoint[]): { first?: ClearPoint; last?: ClearPoint } {
  const traded = points.filter((c) => c.volume > 0);
  if (!traded.length) return {};
  let i = Math.max(0, traded.length - CHANGE_WINDOW);
  while (i < traded.length - 1 && (traded[i].n ?? 1) > 1) i++; // an hourly aggregate stands for many epochs: it is no single opening price
  return { first: traded[i], last: traded[traded.length - 1] };
}

/** Last traded price, change over the last 120 traded points and a 60-point sparkline. `points` must be ascending by epoch. */
export function summarize(points: ClearPoint[]): MarketSummary {
  const traded = points.filter((c) => c.volume > 0);
  const { first, last } = changeWindow(points);
  return { last: last?.price ?? 0, lastEpoch: last?.epoch ?? -1, change: last && first && first.price ? (last.price - first.price) / first.price : 0, prices: traded.slice(-60).map((c) => c.price) };
}

export type RangeStats = { trades: number; high: number; low: number; volume: number };
/** High, low, volume and the number of traded epochs, counting aggregated points by their n/high/low. */
export function rangeStats(points: ClearPoint[]): RangeStats {
  let trades = 0, high = 0, low = 0, volume = 0;
  for (const c of points) {
    if (c.volume <= 0) continue;
    const hi = c.high ?? c.price, lo = c.low ?? c.price;
    trades += c.n ?? 1; volume += c.volume; high = Math.max(high, hi); low = low === 0 ? lo : Math.min(low, lo);
  }
  return { trades, high, low, volume };
}
