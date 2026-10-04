// Compact snapshot of the market ledger: the wire format of GET /api/market/snapshot AND of the browser's IndexedDB cache.
// Shared by the Worker and the browser, dependency-free (imports only market-core).
//   cold  clearing points only, compacted: the newest FULL_KEEP per market at full resolution, older ones folded per hour
//   hot   full books (orders, traders, fills) for the newest HOT_EPOCHS epochs that had orders, plus any clears not in cold
// validateSnapshot is strict on purpose: anything from the network or from storage is untrusted until it passes. It returns a REBUILT
// copy (whitelisted fields only, fresh objects), so nothing the input carried beyond the format ever reaches the ledger.
//
// Contract for readers:
//   - `cursor` is the last block fully included; callers apply only events with block > cursor. No datum in a valid snapshot has a
//     block above the cursor. `complete` is a freshness flag chosen by the producer (the Worker sets it when the cursor is close to
//     the head and the cron is recent); it is NOT "cursor === head", so validation only requires cursor <= head.
//   - hydrate REPLACES the ledger's content with the snapshot (it never merges into existing data) and records, per market, the highest
//     epoch that is summed into a folded point (ledger.foldedThrough). applyEvents ignores clear events at or below that epoch, so an
//     overlapping poll cannot double count or overwrite an aggregate. This is defense in depth; callers should still not re-apply
//     events at or below the cursor.
//   - Caps: the worst case this module produces is LIMITS.markets markets x HOT_EPOCHS epochs of books (64 x 160 = 10240 books), each
//     with at most the contract's 24 orders; the LIMITS leave margin over that, and buildSnapshot cuts a book that still exceeds
//     ordersPerBook (keeps the lowest order indexes), so its output always validates for a ledger with at most LIMITS.markets markets.
import { clearTime, noteTrader, type ClearPoint, type CoreBook, type CoreClear, type CoreOrder, type Ledger, type Schedule } from './market-core.ts';

export const SNAPSHOT_VERSION = 1;
export const HOT_EPOCHS = 160;   // ~2 h of epochs with books: sealed book, recent results, trade tape
export const HASH_EPOCHS = 30;   // commit hashes kept only for the newest epochs (the sealed book shows them)
export const FULL_KEEP = 600;    // newest clears per market kept at full resolution (change% needs 120)
export const BUCKET_SEC = 3600;  // older clears fold into one traded and one no-trade point per hour
export const AGG_KEEP = 720;     // at most this many folded points per market; older ones are dropped. Each hour holds up to two (traded and no-trade),
                                 // so this retains 15 days when both kinds occur every hour, up to 30 days when only one does
export const TX_KEEP = 40;       // tx hash kept on the newest clears per market (the epochs table shows 30)
export const MAX_FOLD_N = 100_000; // upper bound on the epochs one folded point may stand for (an hour holds ~80)
// books: 64 markets x HOT_EPOCHS = 10240 at worst, so 16384 is margin; ordersPerBook: the contract allows 24 orders per market-epoch.
export const LIMITS = { clearsPerMarket: 4000, markets: 64, books: 16384, ordersPerBook: 512 } as const;

export type SnapOrder = { i: number; t: string; h?: string; s?: 0 | 1; p?: number; u?: number; f?: number };
/** k = block of the clear; n/hi/lo only on folded points. */
export type SnapClear = { e: number; p: number; v: number; b: number; s: number; f: number; k: number; tx?: string; n?: number; hi?: number; lo?: number };
export type SnapBook = { m: string; e: number; fb: number; lb: number; o: SnapOrder[]; c?: SnapClear };
export type MarketSnapshot = {
  v: 1; chainId: number; book: string; deployBlock: number;
  /** last block fully included (inclusive); readers continue from cursor + 1 */
  cursor: number; head: number; headTime: number; builtAt: number; complete: boolean;
  schedule: Schedule;
  cold: Record<string, SnapClear[]>;
  hot: { clears: Record<string, SnapClear[]>; books: SnapBook[] };
};
export type SnapshotIdentity = { chainId: number; book: string; deployBlock: number };

export function toSnapOrder(o: CoreOrder, keepHash: boolean): SnapOrder {
  const s: SnapOrder = { i: o.index, t: o.trader };
  if (keepHash && o.hash) s.h = o.hash;
  if (o.side !== undefined) s.s = o.side;
  if (o.price !== undefined) s.p = o.price;
  if (o.units !== undefined) s.u = o.units;
  if (o.filled !== undefined) s.f = o.filled;
  return s;
}
export function toSnapClear(epoch: number, c: CoreClear | ClearPoint, keepTx: boolean): SnapClear {
  const s: SnapClear = { e: epoch, p: c.price, v: c.volume, b: c.buys, s: c.sells, f: c.forfeited, k: c.block };
  if (keepTx && c.tx) s.tx = c.tx;
  const cp = c as ClearPoint;
  if (cp.n !== undefined && cp.n > 1) { s.n = cp.n; s.hi = cp.high; s.lo = cp.low; }
  return s;
}
export function toSnapBook(b: CoreBook, keepHash: boolean): SnapBook {
  const s: SnapBook = { m: b.market, e: b.epoch, fb: b.firstBlock, lb: b.lastBlock, o: b.orders.slice(0, LIMITS.ordersPerBook).map((o) => toSnapOrder(o, keepHash)) };
  if (b.clear) s.c = toSnapClear(b.epoch, b.clear, true);
  return s;
}
export function fromSnapClear(c: SnapClear, schedule: Schedule | undefined): ClearPoint {
  const p: ClearPoint = { epoch: c.e, time: clearTime(schedule, c.e), price: c.p, volume: c.v, buys: c.b, sells: c.s, forfeited: c.f, tx: c.tx ?? '', block: c.k };
  if (c.n !== undefined && c.n > 1) { p.n = c.n; p.high = c.hi; p.low = c.lo; }
  return p;
}
export function fromSnapBook(s: SnapBook): CoreBook {
  const b: CoreBook = { market: s.m, epoch: s.e, firstBlock: s.fb, lastBlock: s.lb, orders: s.o.map((o) => {
    const r: CoreOrder = { index: o.i, trader: o.t, hash: o.h ?? '' };
    if (o.s !== undefined) r.side = o.s; if (o.p !== undefined) r.price = o.p; if (o.u !== undefined) r.units = o.u; if (o.f !== undefined) r.filled = o.f;
    return r;
  }) };
  if (s.c) b.clear = { price: s.c.p, volume: s.c.v, buys: s.c.b, sells: s.c.s, forfeited: s.c.f, tx: s.c.tx ?? '', block: s.c.k };
  return b;
}

function fold(into: ClearPoint | undefined, p: ClearPoint): ClearPoint {
  const hi = p.high ?? p.price, lo = p.low ?? p.price, n = p.n ?? 1;
  if (!into) return { ...p, tx: '', n, high: hi, low: lo };
  const traded = p.volume > 0;
  return {
    epoch: p.epoch, time: p.time, block: p.block, tx: '', price: traded ? p.price : into.price,
    volume: into.volume + p.volume, buys: into.buys + p.buys, sells: into.sells + p.sells, forfeited: into.forfeited + p.forfeited,
    n: (into.n ?? 1) + n, high: Math.max(into.high ?? into.price, hi), low: traded ? Math.min(into.low ?? into.price, lo) : (into.low ?? into.price),
  };
}

/** Compacts one market's clears (ascending by epoch). Associative: compact(compact(a) ++ b) equals compact(a ++ b) for b newer than a. */
export function compactClears(points: ClearPoint[], schedule: Schedule | undefined): ClearPoint[] {
  const sorted = [...points].sort((a, b) => a.epoch - b.epoch);
  const cut = Math.max(0, sorted.length - FULL_KEEP);
  const full = sorted.slice(cut).map((p, i, arr) => (i < arr.length - TX_KEEP && p.tx ? { ...p, tx: '' } : p));
  const buckets = new Map<string, ClearPoint>();
  for (const p0 of sorted.slice(0, cut)) {
    const p = p0.time ? p0 : { ...p0, time: clearTime(schedule, p0.epoch) };
    const key = `${Math.floor(p.time / BUCKET_SEC)}:${p.volume > 0 ? 't' : 'z'}`;
    buckets.set(key, fold(buckets.get(key), p));
  }
  const folded = [...buckets.values()].sort((a, b) => a.epoch - b.epoch).slice(-AGG_KEEP).map((p) => (p.n === 1 ? (({ n: _n, high: _h, low: _l, ...rest }) => rest)(p) : p));
  return [...folded, ...full];
}

const HEX32 = /^0x[0-9a-f]{64}$/; const ADDR = /^0x[0-9a-f]{40}$/;
const int = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Each clean* function returns a fresh, whitelisted copy of a valid value, or null when the value is invalid.
function cleanClear(c: unknown, cursor: number): SnapClear | null {
  if (!obj(c) || !int(c.e) || !int(c.p) || !int(c.v) || !int(c.b) || !int(c.s) || !int(c.f) || !int(c.k) || c.k > cursor) return null;
  const out: SnapClear = { e: c.e, p: c.p, v: c.v, b: c.b, s: c.s, f: c.f, k: c.k };
  if (c.tx !== undefined) { if (typeof c.tx !== 'string' || !HEX32.test(c.tx)) return null; out.tx = c.tx; }
  if (c.n !== undefined || c.hi !== undefined || c.lo !== undefined) {
    // folded point: n, hi and lo travel together and bracket the representative price
    if (!int(c.n, MAX_FOLD_N) || c.n < 1 || !int(c.hi) || !int(c.lo) || c.lo > c.p || c.p > c.hi) return null;
    out.n = c.n; out.hi = c.hi; out.lo = c.lo;
  }
  return out;
}
function cleanClearList(list: unknown, cursor: number): SnapClear[] | null {
  if (!Array.isArray(list) || list.length > LIMITS.clearsPerMarket) return null;
  const out: SnapClear[] = []; let prev = -1;
  for (const c of list) { const k = cleanClear(c, cursor); if (!k || k.e <= prev) return null; prev = k.e; out.push(k); }
  return out;
}
function cleanClearMap(m: unknown, cursor: number): Record<string, SnapClear[]> | null {
  if (!obj(m)) return null;
  const keys = Object.keys(m); if (keys.length > LIMITS.markets) return null;
  const out: Record<string, SnapClear[]> = {};
  for (const k of keys) { const l = HEX32.test(k) ? cleanClearList(m[k], cursor) : null; if (!l) return null; out[k] = l; }
  return out;
}
function cleanOrder(o: unknown): SnapOrder | null {
  if (!obj(o) || !int(o.i) || typeof o.t !== 'string' || !ADDR.test(o.t)) return null;
  const out: SnapOrder = { i: o.i, t: o.t };
  if (o.h !== undefined) { if (typeof o.h !== 'string' || !HEX32.test(o.h)) return null; out.h = o.h; }
  if (o.s !== undefined) { if (o.s !== 0 && o.s !== 1) return null; out.s = o.s; }
  if (o.p !== undefined) { if (!int(o.p)) return null; out.p = o.p; }
  if (o.u !== undefined) { if (!int(o.u)) return null; out.u = o.u; }
  if (o.f !== undefined) { if (!int(o.f)) return null; out.f = o.f; }
  return out;
}
function cleanBook(b: unknown, cursor: number): SnapBook | null {
  if (!obj(b) || typeof b.m !== 'string' || !HEX32.test(b.m) || !int(b.e) || !int(b.fb) || !int(b.lb) || b.fb > b.lb || b.lb > cursor) return null;
  if (!Array.isArray(b.o) || b.o.length > LIMITS.ordersPerBook) return null;
  const o: SnapOrder[] = []; let prev = -1;
  for (const x of b.o) { const k = cleanOrder(x); if (!k || k.i <= prev) return null; prev = k.i; o.push(k); } // indexes strictly ascending, so unique
  const out: SnapBook = { m: b.m, e: b.e, fb: b.fb, lb: b.lb, o };
  if (b.c !== undefined) { const c = cleanClear(b.c, cursor); if (!c || c.e !== b.e) return null; out.c = c; }
  return out;
}

/** Returns a sanitized copy of the snapshot when it is well-formed AND belongs to this chain, contract and deployment; otherwise null. Never throws. */
export function validateSnapshot(x: unknown, id: SnapshotIdentity): MarketSnapshot | null {
  try {
    if (!obj(x) || x.v !== SNAPSHOT_VERSION) return null;
    if (x.chainId !== id.chainId || typeof x.book !== 'string' || x.book.toLowerCase() !== id.book.toLowerCase() || x.deployBlock !== id.deployBlock) return null;
    if (!int(x.cursor) || !int(x.head) || !int(x.headTime) || !int(x.builtAt) || typeof x.complete !== 'boolean') return null;
    if (x.cursor < id.deployBlock || x.cursor > x.head) return null;
    const s = x.schedule;
    if (!obj(s) || !int(s.t0) || !int(s.epochLen) || !int(s.commitEnd) || !int(s.revealEnd) || !int(s.bond) || s.epochLen === 0) return null;
    if (!(s.commitEnd < s.revealEnd && s.revealEnd < s.epochLen)) return null;
    if (!obj(x.hot)) return null;
    const cold = cleanClearMap(x.cold, x.cursor), clears = cleanClearMap(x.hot.clears, x.cursor);
    if (!cold || !clears || !Array.isArray(x.hot.books) || x.hot.books.length > LIMITS.books) return null;
    const books: SnapBook[] = []; const seen = new Set<string>();
    for (const raw of x.hot.books) {
      const b = cleanBook(raw, x.cursor); const key = b && `${b.m}:${b.e}`;
      if (!b || seen.has(key!)) return null;
      seen.add(key!); books.push(b);
    }
    return {
      v: SNAPSHOT_VERSION, chainId: id.chainId, book: x.book, deployBlock: id.deployBlock,
      cursor: x.cursor, head: x.head, headTime: x.headTime, builtAt: x.builtAt, complete: x.complete,
      schedule: { t0: s.t0, epochLen: s.epochLen, commitEnd: s.commitEnd, revealEnd: s.revealEnd, bond: s.bond },
      cold, hot: { clears, books },
    };
  } catch { return null; }
}

/** Replaces the ledger's content with a validated snapshot (never merges). Events applied afterwards merge into the same books (same keys, same merge rules). */
export function hydrate(ledger: Ledger, snap: MarketSnapshot): void {
  ledger.books.clear(); ledger.clears.clear(); ledger.traderFirst = new Map();
  const floor = new Map<string, number>(); ledger.foldedThrough = floor;
  const put = (m: string, p: ClearPoint) => { let byE = ledger.clears.get(m); if (!byE) { byE = new Map(); ledger.clears.set(m, byE); } byE.set(p.epoch, p); };
  for (const part of [snap.cold, snap.hot.clears]) for (const [m, list] of Object.entries(part)) for (const c of list) {
    if ((c.n ?? 1) > 1 && c.e > (floor.get(m) ?? -1)) floor.set(m, c.e); // every epoch summed into this point is <= c.e
    put(m, fromSnapClear(c, snap.schedule));
  }
  for (const sb of snap.hot.books) {
    const b = fromSnapBook(sb);
    ledger.books.set(`${b.market}:${b.epoch}`, b);
    for (const o of b.orders) noteTrader(ledger, o.trader, b.firstBlock, o.index); // a snapshot keeps no log positions: the book's first block and the order index stand in
    if (sb.c) put(b.market, fromSnapClear(sb.c, snap.schedule));
  }
}

/** The newest epoch that has a book with orders, or -1. */
function newestWithOrders(books: Iterable<CoreBook>): number {
  let max = -1; for (const b of books) if (b.orders.length && b.epoch > max) max = b.epoch;
  return max;
}
/** First epoch of the hot window: `hotEpochs` (default HOT_EPOCHS) epochs ending at the newest epoch that has a book with orders. */
export function hotFrom(books: Iterable<CoreBook>, hotEpochs = HOT_EPOCHS): number {
  const max = newestWithOrders(books);
  return max < 0 ? 0 : Math.max(0, max - hotEpochs + 1);
}

export type SnapshotMeta = Omit<MarketSnapshot, 'v' | 'cold' | 'hot' | 'schedule'>;
/** Smaller snapshots on purpose (the browser cache fits its size cap with these): a shorter hot window, fewer epochs that keep commit hashes. */
export type BuildOptions = { hotEpochs?: number; hashEpochs?: number };
/**
 * Builds a snapshot from a ledger (used by the browser cache; the Worker assembles the same shape from D1 rows).
 * Hot = books of the HOT_EPOCHS epochs ending at the newest epoch with orders; their clears travel inside the books, every other clear goes cold
 * (so a shorter hot window (opts.hotEpochs) never loses a clearing point, it only ships fewer books).
 */
export function buildSnapshot(ledger: Ledger, meta: SnapshotMeta, schedule: Schedule, opts: BuildOptions = {}): MarketSnapshot {
  const hotEpochs = opts.hotEpochs ?? HOT_EPOCHS, hashEpochs = opts.hashEpochs ?? HASH_EPOCHS;
  const newest = newestWithOrders(ledger.books.values());
  const from = hotFrom(ledger.books.values(), hotEpochs);
  const books = [...ledger.books.values()].filter((b) => b.epoch >= from && b.epoch <= newest).sort((a, b) => a.epoch - b.epoch || a.market.localeCompare(b.market));
  const inHot = new Set(books.filter((b) => b.clear).map((b) => `${b.market}:${b.epoch}`));
  const cold: Record<string, SnapClear[]> = {};
  for (const [m, byE] of ledger.clears) {
    const rest = [...byE.values()].filter((c) => !inHot.has(`${m}:${c.epoch}`));
    if (rest.length) cold[m] = compactClears(rest, schedule).map((c) => toSnapClear(c.epoch, c, !!c.tx));
  }
  return {
    v: SNAPSHOT_VERSION, ...meta, schedule, cold,
    hot: { clears: {}, books: books.map((b) => toSnapBook(b, b.epoch > newest - hashEpochs)) },
  };
}
