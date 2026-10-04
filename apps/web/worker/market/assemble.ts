// Pure string assembly of the snapshot parts from D1 rows. The per-minute path only concatenates stored JSON (no parse), which
// keeps the cron inside the Free plan's 10 ms CPU budget; only the about-hourly cold graduation parses and re-compacts.
//
// Guarantees of the body snapshotBody() returns (the wire format is src/lib/market-snap.ts MarketSnapshot; validateSnapshot is strict):
//   - books are unique by (market, epoch) (primary key) and ordered by (epoch, market); orders inside a book ascend by index
//     (market-core keeps them sorted; toSnapBook truncates a book to LIMITS.ordersPerBook = 512 orders, the contract allows 24);
//   - every block is <= the snapshot cursor: the ingest writes the parts and the cursor in ONE batch, the hot part records the cursor
//     it was built at ("cur") and snapshotBody refuses a part that is newer than the meta row it is paired with (torn read);
//   - `complete` is a freshness flag (head - cursor <= LAG_OK_BLOCKS and the cron ran within STALE_AFTER_MS), not cursor === head;
//   - the body never exceeds MAX_BODY_BYTES: each part is cut to PART_MAX_BYTES (hot: hashes dropped, then the oldest epochs move
//     out of the hot window and keep only their clear; cold: the oldest folded points are dropped), so 2 x PART_MAX_BYTES + header
//     stays far below the client's limit (MAX_BODY_BYTES). A body that is oversize anyway is not emitted (null).
//     All JSON here is ASCII (hex, digits, ASCII keys), so string length equals byte length.
import { compactClears, fromSnapClear, toSnapClear, LIMITS, SNAPSHOT_VERSION, type SnapClear } from '../../src/lib/market-snap.ts';
import type { Schedule } from '../../src/lib/market-core.ts';
import { D1_VALUE_LIMIT, type EpochRow, type MetaRow, type PartRow } from './repo.ts';

/** A snapshot whose cursor is further behind the head than this is flagged incomplete (about 6 minutes of blocks). */
export const LAG_OK_BLOCKS = 2400;
/** A snapshot whose cron has not run for this long is flagged incomplete. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
/** One part (and so one D1 value) stays below D1's 2 MB value limit; hot + cold + header is then far below MAX_SNAPSHOT_BYTES. */
export const PART_MAX_BYTES = D1_VALUE_LIMIT;
/**
 * The client refuses a body above this (src/lib/market-source.ts MAX_SNAPSHOT_BYTES; a test pins the two equal). Not imported: that
 * module is browser code (DOM types) and does not type-check under the Worker's tsconfig.
 */
export const MAX_BODY_BYTES = 5_000_000;
export const EMPTY_HOT = '{"clears":{},"books":[]}';

/**
 * hot part: books with epoch >= hotFrom (book_json with commit hashes from hashFrom on, lite_json before), and the clears of the
 * epochs in [coldUntil, hotFrom) grouped by market. Rows must be ordered by (epoch, market). `cursor` (the block the part is
 * consistent with) is recorded as "cur" so a reader can detect a part that is newer than its meta row.
 */
export function hotBody(rows: EpochRow[], coldUntil: number, hotFrom: number, hashFrom: number, cursor?: number): string {
  const books: string[] = []; const clears = new Map<string, string[]>();
  for (const r of rows) {
    if (r.epoch >= hotFrom) books.push(r.epoch >= hashFrom ? r.book_json : r.lite_json);
    else if (r.epoch >= coldUntil && r.clear_json) { const l = clears.get(r.market) ?? []; l.push(r.clear_json); clears.set(r.market, l); }
  }
  const c = [...clears.entries()].map(([m, l]) => `${JSON.stringify(m)}:[${l.join(',')}]`).join(',');
  return `{${cursor === undefined ? '' : `"cur":${cursor},`}"clears":{${c}},"books":[${books.join(',')}]}`;
}

export type HotFit = { body: string; hotFrom: number; trimmed: boolean };
/**
 * hotBody cut to `maxBytes` and to the snapshot's book cap (LIMITS.books): first the oldest epochs beyond the book cap leave the hot
 * window, then commit hashes are dropped, then more of the oldest epochs leave until it fits. An epoch that leaves the hot window
 * keeps its clearing point in hot.clears, so the price history is intact; only its books (orders, fills) are no longer shipped.
 * The result can still exceed maxBytes only when the clears alone do (the caller then refuses to store it).
 */
export function fitHot(rows: EpochRow[], coldUntil: number, hotFrom: number, hashFrom: number, cursor: number | undefined, maxBytes = PART_MAX_BYTES): HotFit {
  const per = new Map<number, { n: number; lite: number }>();
  for (const r of rows) {
    if (r.epoch < hotFrom) continue;
    const p = per.get(r.epoch) ?? { n: 0, lite: 0 }; p.n++; p.lite += r.lite_json.length + 1; per.set(r.epoch, p);
  }
  const epochs = [...per.keys()].sort((a, b) => a - b);
  let skip = 0; let count = 0; for (const p of per.values()) count += p.n;
  while (skip < epochs.length - 1 && count > LIMITS.books) { count -= per.get(epochs[skip])!.n; skip++; }
  let hs = hashFrom;
  const build = () => hotBody(rows, coldUntil, skip ? epochs[skip] : hotFrom, hs, cursor);
  let body = build();
  if (body.length > maxBytes) { hs = Number.POSITIVE_INFINITY; body = build(); }
  for (let i = 0; i < 8 && body.length > maxBytes && skip < epochs.length - 1; i++) {
    const need = (body.length - maxBytes) * 1.1; let freed = 0;
    do { freed += per.get(epochs[skip])!.lite; skip++; } while (freed < need && skip < epochs.length - 1);
    body = build();
  }
  return { body, hotFrom: skip ? epochs[skip] : hotFrom, trimmed: skip > 0 };
}

/**
 * cold part after moving the clears of epochs in [coldUntil, newColdUntil) out of the hot window, re-compacted per market.
 * A clear at or below a market's newest cold epoch is not added again (re-running a range is idempotent). When the result is above
 * maxBytes every market keeps only its newest K points (largest K that fits), which are the ones the chart needs.
 */
export function graduate(coldBody: string | null, rows: EpochRow[], coldUntil: number, newColdUntil: number, schedule: Schedule, maxBytes = PART_MAX_BYTES): string {
  const cold: Record<string, SnapClear[]> = coldBody ? JSON.parse(coldBody) : {};
  for (const r of rows) {
    if (r.epoch < coldUntil || r.epoch >= newColdUntil || !r.clear_json) continue;
    const list = (cold[r.market] ??= []);
    if (list.length && r.epoch <= list[list.length - 1].e) continue;
    list.push(JSON.parse(r.clear_json) as SnapClear);
  }
  const out: Record<string, SnapClear[]> = {};
  for (const [m, list] of Object.entries(cold)) out[m] = compactClears(list.map((c) => fromSnapClear(c, schedule)), schedule).map((c) => toSnapClear(c.epoch, c, !!c.tx));
  const body = JSON.stringify(out);
  if (body.length <= maxBytes) return body;
  const cut = (k: number) => JSON.stringify(Object.fromEntries(Object.entries(out).map(([m, l]) => [m, l.slice(-k)])));
  let lo = 0, hi = Math.max(...Object.values(out).map((l) => l.length));
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cut(mid).length <= maxBytes) lo = mid; else hi = mid - 1; }
  return cut(lo);
}

export function isComplete(meta: MetaRow, nowMs: number): boolean {
  const cursor = meta.next_block - 1;
  return meta.head_block > 0 && cursor >= meta.deploy_block && meta.head_block - cursor <= LAG_OK_BLOCKS && nowMs - meta.updated_at <= STALE_AFTER_MS;
}

/** The cursor a hot part was built at (see hotBody), or null when the body does not carry one. */
export function partCursor(body: string): number | null {
  const m = /^\{"cur":(\d{1,15}),/.exec(body.slice(0, 40));
  return m ? Number(m[1]) : null;
}

/**
 * The full MarketSnapshot JSON text (see src/lib/market-snap.ts), or null when there is nothing servable: no schedule or head yet,
 * cursor outside [deploy block, head], no hot part (or no cold part after the first graduation), a part newer than the meta row
 * (the two were read around a cron write: ask again), or a body above MAX_BODY_BYTES.
 * Read the meta row BEFORE the parts and pair them from one request; the cursor below is meta's.
 */
export function snapshotBody(meta: MetaRow, parts: { hot: PartRow | null; cold: PartRow | null }, nowMs: number): string | null {
  const cursor = meta.next_block - 1;
  if (!meta.schedule_json || meta.head_block === 0 || cursor < meta.deploy_block || cursor > meta.head_block) return null;
  if (!parts.hot || (!parts.cold && meta.cold_until > 0)) return null;
  const cur = partCursor(parts.hot.body);
  if (cur !== null && cur > cursor) return null;
  const builtAt = Math.max(meta.updated_at, parts.hot.built_at);
  const body = `{"v":${SNAPSHOT_VERSION},"chainId":${meta.chain_id},"book":${JSON.stringify(meta.book)},"deployBlock":${meta.deploy_block},"cursor":${cursor},`
    + `"head":${meta.head_block},"headTime":${meta.head_time},"builtAt":${builtAt},"complete":${isComplete(meta, nowMs)},"schedule":${meta.schedule_json},`
    + `"cold":${parts.cold?.body ?? '{}'},"hot":${parts.hot.body}}`;
  return body.length > MAX_BODY_BYTES ? null : body;
}
