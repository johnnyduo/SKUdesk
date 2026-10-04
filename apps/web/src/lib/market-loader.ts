// Newest-first history loading for the market store. Pure scheduling: the caller supplies fetchRange and folds the events.
// The newest chunks load first so the last price and the recent chart paint early; older history backfills behind them.
// Order does not matter for correctness (market-core's merge is order-independent); it only decides what is usable first.
import type { ClearPoint, MarketEvent } from './market-core.ts';

export type Range = { from: number; to: number };
/** Newest block range whose every chunk is loaded with no hole up to the head end; `complete` once every chunk is in. */
export type LoadProgress = { contiguousFrom: number; done: number; total: number; complete: boolean };

/** [from, to] in chunks of `size` blocks, newest first. Empty when from > to. */
export function planRanges(from: number, to: number, size: number): Range[] {
  const out: Range[] = [];
  if (!(size > 0) || from > to) return out;
  for (let hi = to; hi >= from; hi -= size) out.push({ from: Math.max(from, hi - size + 1), to: hi });
  return out;
}

/**
 * True when the last price of every market can be trusted: its newest traded clear lies inside the contiguous loaded region
 * (so no newer trade can be hiding in a chunk that has not arrived yet), or the whole range is loaded.
 */
export function readyFor(clears: Record<string, ClearPoint[]>, marketIds: string[], p: LoadProgress): boolean {
  if (p.complete) return true;
  // An empty market list must not make a partial load look ready: `every` over nothing is true, so refuse explicitly.
  if (marketIds.length === 0) return false;
  return marketIds.every((id) => {
    const pts = clears[id.toLowerCase()] ?? [];
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].volume > 0) return pts[i].block >= p.contiguousFrom;
    return false;
  });
}

/** The node's refusal of a getLogs whose result is too large ("more than 10000 results", "response size exceeded", ...). Same words as tools/market-snapshot.ts. */
export const LIMIT_ERROR = /limit|too many|exceed|more than/i;
/** Rate limiting also says "limit"/"too many" but is NOT about the range: it is retried with backoff, never split (splitting would double the request rate). */
const RATE_LIMIT = /rate.?limit|too many requests|\b429\b/i;
/** True when the error says the range holds too many logs. Looks at viem's `details` (the node's own message) when present, else at the message. */
export function isLimitError(e: unknown): boolean {
  const x = e as { details?: unknown; message?: unknown } | null | undefined;
  const text = typeof x?.details === 'string' && x.details ? x.details : typeof x?.message === 'string' ? x.message : '';
  return !!text && LIMIT_ERROR.test(text) && !RATE_LIMIT.test(text);
}
/**
 * Fetches `r`; when the node refuses it as too large (isLimitError), fetches its two halves instead (lower half first, so the result stays in
 * chain order), recursively. The recursion stops at a single block: a one-block range that is still refused rejects with that error, so the
 * depth is at most log2(range size) and the request count at most 2n - 1 for n blocks. Any other error propagates unchanged (one request).
 */
export async function splitOnLimit<T>(r: Range, fetchOnce: (r: Range) => Promise<T[]>): Promise<T[]> {
  try { return await fetchOnce(r); }
  catch (e) {
    if (r.to <= r.from || !isLimitError(e)) throw e;
    const mid = Math.floor((r.from + r.to) / 2);
    const lo = await splitOnLimit({ from: r.from, to: mid }, fetchOnce);
    const hi = await splitOnLimit({ from: mid + 1, to: r.to }, fetchOnce);
    return [...lo, ...hi];
  }
}

export type Backfill = { run(concurrency: number): Promise<LoadProgress>; progress(): LoadProgress; stop(): void };
/**
 * Loads `ranges` (newest first) with a small worker pool. onChunk runs once per successfully loaded range, in completion order.
 * A range counts as done only after its onChunk returned: if fetchRange or onChunk throws, the range stays pending, run() rejects
 * with the first error after the in-flight ranges settle, and calling run() again retries only what is still missing (the fetch
 * may repeat; market-core's merge is idempotent). Overlapping run() calls share the one pass in flight (no double fetch).
 * stop() makes workers finish their current range and take no new one.
 * Retry/backoff is intentionally NOT done here: the store (market.ts) must implement it and handle the run() rejection.
 */
export function createBackfill(ranges: Range[], fetchRange: (r: Range) => Promise<MarketEvent[]>, onChunk: (events: MarketEvent[], r: Range, p: LoadProgress) => void): Backfill {
  const done: boolean[] = ranges.map(() => false); let stopped = false; let current: Promise<LoadProgress> | null = null;
  const progress = (): LoadProgress => {
    let k = 0; while (k < ranges.length && done[k]) k++;
    const contiguousFrom = k === 0 ? (ranges.length ? ranges[0].to + 1 : 0) : ranges[k - 1].from;
    const n = done.filter(Boolean).length;
    return { contiguousFrom, done: n, total: ranges.length, complete: n === ranges.length };
  };
  async function pass(concurrency: number): Promise<LoadProgress> {
    const queue = ranges.map((_, i) => i).filter((i) => !done[i]); let next = 0; let firstError: unknown = null;
    const worker = async () => {
      while (!stopped && firstError === null && next < queue.length) {
        const i = queue[next++];
        try {
          const ev = await fetchRange(ranges[i]); if (stopped) return;
          done[i] = true; // onChunk must see this range counted in its progress...
          try { onChunk(ev, ranges[i], progress()); } catch (e) { done[i] = false; throw e; } // ...but a throwing onChunk un-counts it
        }
        catch (e) { if (firstError === null) firstError = e; }
      }
    };
    // NaN/0/negative -> 1 worker; Infinity or more than the work -> one worker per pending range (never a RangeError).
    const workers = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : concurrency > 0 ? queue.length : 1;
    await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, worker));
    if (firstError !== null) throw firstError;
    return progress();
  }
  function run(concurrency: number): Promise<LoadProgress> {
    if (current) return current;
    const p = pass(concurrency).finally(() => { current = null; });
    current = p; return p;
  }
  return { run, progress, stop: () => { stopped = true; } };
}
