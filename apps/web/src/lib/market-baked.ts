// The build-time baked history (src/data/blindbook-history.json, written by tools/market-snapshot.ts) as a history base for the market store.
// It is the COLD FALLBACK: the store offers it to chooseBase next to the Worker snapshot and the IndexedDB cache, and it wins only with a
// strictly newer cursor (market-source.ts documents the order). The file is untrusted input like the other bases: every event is re-encoded
// as the raw log it was decoded from and goes through market-core's decodeLog (the same decoder as an eth_getLogs answer), the events are
// folded with applyEvents, packed with buildSnapshot and checked by validateSnapshot. A baked base is therefore an ordinary snapshot whose
// cursor is the baked head, so the store reads only blocks above it from the chain. Any malformed part rejects the whole file (null).
// Nothing here throws. Dependency-free like market-core / market-snap.
import { TOPICS, applyEvents, decodeLog, newLedger, type MarketEvent, type RawLog, type Schedule } from './market-core.ts';
import { buildSnapshot, validateSnapshot, type MarketSnapshot, type SnapshotIdentity } from './market-snap.ts';

/** Events baked into the build (tools/market-snapshot.ts) so the page only has to fetch what happened after `head`. Bigints are strings. */
export type HistorySnapshot = { chainId: number; book: string; head: number; events: { e: string; b: number; i: number; t: string; a: Record<string, any> }[] };
/** Upper bound on the events of one baked file (today's file has about 7,300 in 2.3 MB). */
export const MAX_BAKED_EVENTS = 500_000;

const KIND: Record<string, keyof typeof TOPICS> = { Committed: 'commit', Revealed: 'reveal', Fill: 'fill', EpochCleared: 'clear' };
const HEX32 = /^0x[0-9a-fA-F]{64}$/; const ADDR = /^0x[0-9a-fA-F]{40}$/;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** A uint256 argument (decimal string as baked, or a plain number) as a 32-byte hex word; null when it is not a non-negative integer. */
function word(v: unknown): string | null {
  let n: bigint;
  if (typeof v === 'string' && /^\d{1,78}$/.test(v)) n = BigInt(v);
  else if (int(v)) n = BigInt(v);
  else return null;
  const h = n.toString(16); return h.length > 64 ? null : h.padStart(64, '0');
}

/** One baked event as the raw log it was decoded from (the inverse of viem's decoding); null when a field is missing or malformed. */
function toRawLog(x: unknown): RawLog | null {
  if (!x || typeof x !== 'object') return null;
  const { e, b, i, t, a } = x as Record<string, unknown>;
  const kind = typeof e === 'string' && has(KIND, e) ? KIND[e] : undefined;
  if (!kind || !int(b) || !int(i) || typeof t !== 'string' || !HEX32.test(t) || !a || typeof a !== 'object' || Array.isArray(a)) return null;
  const g = a as Record<string, unknown>;
  const epoch = word(g.epoch);
  if (typeof g.market !== 'string' || !HEX32.test(g.market) || epoch === null) return null;
  const topics = [TOPICS[kind], g.market, '0x' + epoch];
  let words: Array<string | null>;
  if (kind === 'clear') words = [g.price, g.volume, g.buys, g.sells, g.forfeited].map(word);
  else {
    if (typeof g.trader !== 'string' || !ADDR.test(g.trader)) return null;
    topics.push('0x' + '0'.repeat(24) + g.trader.slice(2));
    if (kind === 'commit') words = [word(g.index), typeof g.hash === 'string' && HEX32.test(g.hash) ? g.hash.slice(2) : null];
    else if (kind === 'reveal') words = [g.index, g.side, g.price, g.units].map(word);
    else words = [g.index, g.side, g.units, g.price].map(word);
  }
  if (words.some((w) => w === null)) return null;
  return { topics, data: '0x' + words.join(''), blockNumber: '0x' + b.toString(16), logIndex: '0x' + i.toString(16), transactionHash: t };
}

/** The baked file's events, decoded and checked against this deployment; null when anything is off (another chain or book, a malformed event). */
export function bakedEvents(x: unknown, id: SnapshotIdentity): { head: number; events: MarketEvent[] } | null {
  try {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const f = x as Record<string, unknown>;
    if (f.chainId !== id.chainId || typeof f.book !== 'string' || f.book.toLowerCase() !== id.book.toLowerCase()) return null;
    if (!int(f.head) || f.head < id.deployBlock || !Array.isArray(f.events) || f.events.length > MAX_BAKED_EVENTS) return null;
    const head = f.head; const events: MarketEvent[] = [];
    for (const raw of f.events) {
      const log = toRawLog(raw); const ev = log && decodeLog(log);
      if (!ev || ev.block < id.deployBlock || ev.block > head) return null; // cursor invariant: nothing above the baked head
      events.push(ev);
    }
    return { head, events };
  } catch { return null; }
}

/**
 * The baked file as a validated snapshot of this deployment (cursor = head = the baked head, complete), built with the on-chain `schedule`,
 * or null. headTime is 0: the file carries no block time (the store takes the chain clock from its own polls).
 */
export function bakedSnapshot(x: unknown, id: SnapshotIdentity, schedule: Schedule, now: number): MarketSnapshot | null {
  try {
    const r = bakedEvents(x, id); if (!r) return null;
    const ledger = newLedger(); applyEvents(ledger, r.events, schedule);
    const snap = buildSnapshot(ledger, { chainId: id.chainId, book: id.book, deployBlock: id.deployBlock, cursor: r.head, head: r.head, headTime: 0, builtAt: now, complete: true }, schedule);
    return validateSnapshot(snap, id);
  } catch { return null; }
}
