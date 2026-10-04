// Every-minute market ingest (cron). Reads new BlindBook logs from the public RPC with bounded work per run, folds them into
// per-(market, epoch) rows with the shared market-core merge, and rebuilds the pre-serialized snapshot parts.
//
// Budget per run (Workers Free plan): at most MAX_SUBREQUESTS fetches (limit 50), well under 40 D1 statements (limit 50), at most
// MAX_LOGS_PER_RUN logs decoded (CPU limit 10 ms). Catch-up from the deploy block spreads over many runs.
//
// Merge: READ-MERGE-WRITE. The touched books are loaded from D1 (loadBooks), the ledger is seeded with them, the new events are
// applied (market-core, idempotent and order independent), and only books whose canonical JSON changed are upserted. Nothing relies
// on cross-run fill arbitration. A book stored with more than LIMITS.ordersPerBook (512) orders is cut to 512 by toSnapBook when it
// is written (the contract allows 24, so this is a bound, not a practical limit).
//
// Reorg safety: logs are read only up to head - CONFIRMATIONS, the last OVERLAP_BLOCKS are re-read every run (idempotent merge), and
// the hash of the last ingested block is checked on the next run; a mismatch (or an anchor above the head) deletes the books touched
// since the rewind point and re-reads them from their first block.
//
// Consistency: the snapshot parts and the cursor are written in ONE batch, so a reader never sees parts that miss books the cursor
// already covers; if that batch cannot be built the cursor still advances (see 'parts_unavailable') and the hot part is dropped, so
// the snapshot is unavailable rather than wrong, and the next run rebuilds it.
//
// Overlapping runs: a lease in the meta row (mk_meta.lease_until, repo.acquireLease). A run takes it with one conditional UPDATE, a
// second run that finds it unexpired returns reason 'busy' without reading or writing anything, and the owner releases it in a
// finally block. A crashed run blocks the ingest for LEASE_MS (2 minutes) at most, and the cron simply continues afterwards.
// Everything else stays idempotent as a second line of defence (upserts only rewrite changed content, the cursor and the parts move
// together), so a run that outlives its lease cannot corrupt rows; at worst the cursor moves backwards and the next run re-reads.
//
// Not shipped by design: a clear that arrives for an epoch below mk_meta.cold_until (older than the hot window plus the
// graduation lag, ~2 h; the reorg rewind is only REWIND_BLOCKS ~ 5 min deep and the 256-block overlap ~ 40 s) is stored in its row but
// never reaches the cold part, which only grows forward from cold_until. A late log that old does not occur on a healthy chain.
import { MARKET_TOPICS, applyEvents, bookKey, decodeLogs, newLedger, type CoreBook, type MarketEvent, type RawLog, type Schedule } from '../../src/lib/market-core.ts';
import { HASH_EPOCHS, HOT_EPOCHS, LIMITS } from '../../src/lib/market-snap.ts';
import type { AppEnv, Deps } from '../env.ts';
import { RpcError, blockCall, hexInt, logsCall, rpcBatch, scheduleCalls, type RpcCall } from './rpc.ts';
import { D1ValueTooLargeError, ROWS_LIMIT, acquireLease, bookJson, deleteFromBlock, getMeta, getPart, loadBooks, maxEpoch, metaUpdate, purgeBefore, putPart, releaseLease, resetMarket, rewindStart, rowsExtra, rowsFrom, upsertBooks, type EpochRow, type MarketTarget, type MetaPatch, type MetaRow } from './repo.ts';
import { fitHot, graduate, hotBody, partCursor, PART_MAX_BYTES, type HotFit } from './assemble.ts';

export const SCHEMA_VERSION = 1;
export const CONFIRMATIONS = 12;        // ~2 s of blocks: logs are read only up to head - 12
export const OVERLAP_BLOCKS = 256;      // re-read every run (~40 s of blocks): a load-balanced getLogs node that serves a few hundred blocks behind its tip cannot leave a permanent hole
export const CHUNK_BLOCKS = 2000;       // ~300 logs at full bot activity (~250 KB of JSON)
export const MIN_CHUNK_BLOCKS = 64;     // floor of the window when the RPC keeps refusing the range
export const MAX_LOG_CALLS = 4;         // successful log requests per run
export const MAX_LOGS_PER_RUN = 1200;   // ~1 MB of JSON: about 3-4 ms of parse + decode, well inside 10 ms CPU
export const MAX_SUBREQUESTS = 6;       // 1 head/anchor(/schedule) batch + log requests, failed ones included; asserted by the tests
// Books touched per run (blocks above the old cursor); a run that would exceed it ingests a shorter block window and the rest follows.
// 100 because of the Free plan's 10 ms CPU: serialising a changed book (bookJson, then toSnapBook twice in the upsert) costs
// about 8-17 us per order, so 600 books of 12-24 orders measured 5-10 ms for bookJson alone.
export const MAX_BOOKS_PER_RUN = 100;
export const MAX_RUN_BYTES = 3_000_000; // estimated JSON bytes written per run (each book is stored three times: book, lite, clear)
const EVENT_BYTES = 700;                // per event: one order or clear in book_json, lite_json and clear_json
export const REWIND_BLOCKS = 2000;      // reorg rewind depth (~5 min); far inside the hot window
export const GRADUATE_EPOCHS = 80;      // move clears to the cold part once 80 epochs (~1 h) left the hot window
export const RETAIN_EPOCHS = 3840;      // keep rows ~2 days behind the cold boundary, then delete them
/** JSON-RPC error codes (and our own short codes) that mean "this log range is too large for the node": -32005 limit exceeded, -32602 invalid params (range too wide), -32000 server error. */
const RANGE_RPC_CODES = new Set([-32005, -32602, -32000]);
const RANGE_CODES = new Set(['RPC_TOO_BIG']);

export type IngestSummary = {
  ran: boolean; reason?: string; code?: string; rpcCode?: number; reorg: boolean; calls: number; logs: number; books: number;
  /** books that had to be written with fewer orders (D1 value limit) / that could not be written at all */
  trimmed: number; skipped: number; capped: boolean;
  from: number; to: number; cursor: number; head: number; rebuilt: boolean; graduated: boolean;
};
/** Test knobs; production passes none. */
export type RunCaps = { maxBooks?: number; maxBytes?: number; partMaxBytes?: number };

/** Short fixed-code error of the ingest itself (never carries upstream text). */
class IngestError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'IngestError'; this.code = code; }
}

/** https only; plain http is accepted for an explicit localhost / 127.0.0.1 host (local tests and `wrangler dev`). */
export function rpcUrlOk(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch { return false; }
}

/** The market to ingest, from vars only (MARKET_RPC_URL, MARKET_BOOK, MARKET_CHAIN_ID, MARKET_DEPLOY_BLOCK); null when incomplete or insecure. */
export function marketTarget(env: AppEnv): MarketTarget | null {
  const rpc = env.MARKET_RPC_URL, book = env.MARKET_BOOK, chainId = Number(env.MARKET_CHAIN_ID), deployBlock = Number(env.MARKET_DEPLOY_BLOCK);
  if (!rpc || !rpcUrlOk(rpc) || !book || !/^0x[0-9a-fA-F]{40}$/.test(book) || !Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(deployBlock) || deployBlock <= 0) return null;
  return { rpc, book: book.toLowerCase(), chainId, deployBlock };
}

type Block = { number?: string; hash?: string; timestamp?: string } | null;

/** Decodes the five schedule getters (32-byte eth_call words) with BigInt; null when any is malformed, above 2^53 - 1, or inconsistent. */
export function parseSchedule(results: unknown[]): Schedule | null {
  if (results.length !== 5) return null;
  const [t0, epochLen, commitEnd, revealEnd, bond] = results.map((r) => {
    if (typeof r !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r)) return NaN;
    const v = BigInt(r);
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : NaN;
  });
  const s = { t0, epochLen, commitEnd, revealEnd, bond };
  return Object.values(s).every((v) => Number.isSafeInteger(v) && v >= 0) && epochLen > 0 && commitEnd < revealEnd && revealEnd < epochLen ? s : null;
}

const shortCode = (err: unknown): string => {
  if (err instanceof RpcError || err instanceof IngestError) return err.code;
  const c = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof c === 'string' && /^[A-Z0-9_]{1,40}$/.test(c) ? c : 'INTERNAL';
};
const rangeError = (err: unknown) => err instanceof RpcError && (RANGE_CODES.has(err.code) || (err.rpcCode !== undefined && RANGE_RPC_CODES.has(err.rpcCode)));
function scheduleOf(results: unknown[]): Schedule {
  const s = parseSchedule(results);
  if (!s) throw new IngestError('SCHEDULE_INVALID');
  return s;
}
const chainIdCall = (): RpcCall => ({ method: 'eth_chainId', params: [] });

/**
 * Upsert statements for `books`. A book whose row would pass D1's value limit (D1ValueTooLargeError) is split out and written with
 * fewer orders (the lowest indexes are kept, halving until it fits); one that cannot be written at all is skipped. Neither blocks the
 * cursor. All the other books stay in the normal chunked statements (the run's batch has to stay under the 50-statement limit).
 */
export async function writeBooks(db: D1Database, books: CoreBook[], upsert: typeof upsertBooks = upsertBooks): Promise<{ statements: D1PreparedStatement[]; trimmed: number; skipped: number }> {
  try { return { statements: upsert(db, books), trimmed: 0, skipped: 0 }; } catch (err) { if (!(err instanceof D1ValueTooLargeError)) throw err; }
  const good: CoreBook[] = []; const bad: CoreBook[] = [];
  for (const b of books) { try { upsert(db, [b]); good.push(b); } catch (err) { if (!(err instanceof D1ValueTooLargeError)) throw err; bad.push(b); } }
  const statements = good.length ? upsert(db, good) : [];
  let trimmed = 0, skipped = 0;
  for (const b of bad) {
    let cur = b; let done = false;
    for (let n = b.orders.length; n > 0; n = n >> 1) {
      cur = { ...b, orders: b.orders.slice(0, n >> 1) };
      try { statements.push(...upsert(db, [cur])); done = true; break; } catch (err) { if (!(err instanceof D1ValueTooLargeError)) throw err; }
    }
    if (done) trimmed++; else skipped++;
  }
  return { statements, trimmed, skipped };
}

/** Rows from `epoch` upward, oldest first, in pages that never cut an epoch: ROWS_LIMIT rows is a page boundary, not a silent cut. */
export async function readRows(db: D1Database, epoch: number, window?: { hotFrom: number; hashFrom: number }): Promise<EpochRow[]> {
  const all: EpochRow[] = []; let from = epoch;
  for (let page = 0; page < 4; page++) {
    const rows = await rowsFrom(db, from, undefined, window);
    if (rows.length < ROWS_LIMIT) { all.push(...rows); return all; }
    const last = rows[rows.length - 1].epoch; // that epoch may be cut short: take it whole on the next page
    const whole = rows.filter((r) => r.epoch < last);
    if (!whole.length) break;
    all.push(...whole); from = last;
  }
  throw new IngestError('ROWS_OVERFLOW');
}

/**
 * Adds the columns the slim read left out (lite_json of the hashed band, clear_json of the hot window) to `slim`, reading only
 * those from D1. Falls back to a full read when the hot window alone does not fit in one page.
 */
async function completeRows(db: D1Database, slim: EpochRow[], from: number, window: { hotFrom: number; hashFrom: number }): Promise<EpochRow[]> {
  const extra = await rowsExtra(db, window);
  if (extra.length >= ROWS_LIMIT) return readRows(db, from);
  const by = new Map(extra.map((r) => [r.market + ':' + r.epoch, r]));
  return slim.map((r) => {
    const x = r.epoch >= window.hotFrom ? by.get(r.market + ':' + r.epoch) : undefined;
    return x ? { ...r, lite_json: r.lite_json || x.lite_json, clear_json: x.clear_json } : r;
  });
}

export async function runMarketIngest(env: AppEnv, deps: Deps, caps: RunCaps = {}): Promise<IngestSummary> {
  const now = deps.nowMs();
  const out: IngestSummary = { ran: false, reorg: false, calls: 0, logs: 0, books: 0, trimmed: 0, skipped: 0, capped: false, from: 0, to: 0, cursor: 0, head: 0, rebuilt: false, graduated: false };
  const t = marketTarget(env);
  if (!t) {
    const raw = env.MARKET_RPC_URL;
    return { ...out, reason: 'not_configured', ...(raw && !rpcUrlOk(raw) ? { code: 'RPC_URL_INSECURE' } : {}) };
  }
  const db = env.DB;
  let lease: number | null = null;
  try {
    lease = await acquireLease(db, t, now);
    if (lease === null) return { ...out, reason: 'busy' };
    return await ingest(db, t, deps, now, caps, out);
  } catch (err) {
    return { ...out, ran: false, reason: 'error', code: shortCode(err), ...rpcCodeOf(err) };
  } finally {
    if (lease !== null) { try { await releaseLease(db, lease); } catch { /* the lease expires by itself */ } }
  }
}

async function ingest(db: D1Database, t: MarketTarget, deps: Deps, now: number, caps: RunCaps, out: IngestSummary): Promise<IngestSummary> {
  const rpc = async (calls: RpcCall[]) => { out.calls++; return rpcBatch(deps.fetch, t.rpc, calls); };
  let meta = (await getMeta(db)) as MetaRow;
  // a different deployment (or schema) is only wiped after the node has proved to be on the right chain
  const foreign = meta.schema_version !== SCHEMA_VERSION || meta.chain_id !== t.chainId || meta.book !== t.book || meta.deploy_block !== t.deployBlock;
  // 1. head, chain id, the anchor block (reorg check) and, once, the schedule: one request
  const hasAnchor = !foreign && meta.anchor_block !== null && !!meta.anchor_hash;
  const needSchedule = foreign || !meta.schedule_json;
  const first: RpcCall[] = [blockCall('latest'), chainIdCall()];
  if (hasAnchor) first.push(blockCall(meta.anchor_block as number));
  if (needSchedule) first.push(...scheduleCalls(t.book));
  const res = await rpc(first);
  const latest = res[0] as Block; const head = hexInt(latest?.number); const headTime = hexInt(latest?.timestamp);
  if (!Number.isSafeInteger(head) || !Number.isSafeInteger(headTime)) throw new RpcError('RPC_BAD_HEAD');
  if (hexInt(res[1]) !== t.chainId) throw new RpcError('RPC_WRONG_CHAIN');
  const schedule: Schedule = needSchedule ? scheduleOf(res.slice(res.length - 5)) : JSON.parse(meta.schedule_json as string) as Schedule;
  if (foreign) meta = await resetMarket(db, t, SCHEMA_VERSION, now);
  out.head = head;
  let next = meta.next_block;
  // A node that is behind (head below our cursor, or without our anchor block) is not a reorg: nothing is written, not even its
  // lower head; a good node continues next minute. Only a REAL hash mismatch below rewinds. (A chain that restarted from a lower
  // height under the same chain id needs a new MARKET_DEPLOY_BLOCK / MARKET_BOOK, which resets the ingest.)
  if (head < next - 1) return { ...out, ran: false, reason: 'rpc_behind', cursor: next - 1 };
  const patch: MetaPatch = { head_block: head, head_time: headTime, updated_at: now };
  if (needSchedule) patch.schedule_json = JSON.stringify(schedule);
  if (hasAnchor) {
    const anchor = res[2] as Block;
    if (!anchor || !anchor.hash) return { ...out, ran: false, reason: 'rpc_behind', cursor: next - 1 };
    if (anchor.hash.toLowerCase() !== meta.anchor_hash) {
      out.reorg = true;
      const point = Math.max(t.deployBlock, (meta.anchor_block as number) - REWIND_BLOCKS);
      const start = await rewindStart(db, point); // books touched at/after `point` are dropped and re-read from their first block
      await db.batch([deleteFromBlock(db, point), metaUpdate(db, { next_block: start, anchor_block: null, anchor_hash: null, updated_at: now })]);
      next = start;
    }
  }
  // 2. logs, oldest first, from just before the cursor (overlap) up to head - CONFIRMATIONS, bounded per run
  const safe = head - CONFIRMATIONS;
  const cursorNow = next - 1;
  let to = cursorNow; let anchorHash: string | null = null; let events: MarketEvent[] = []; let logCalls = 0; let chunk = CHUNK_BLOCKS;
  let from = next;
  let stop: unknown = null;
  if (safe >= next) {
    from = Math.max(t.deployBlock, next - (next > t.deployBlock && !out.reorg ? OVERLAP_BLOCKS : 0));
    to = from - 1;
    while (to < safe && logCalls < MAX_LOG_CALLS && out.logs < MAX_LOGS_PER_RUN && out.calls < MAX_SUBREQUESTS) {
      // `chunk` is the number of NEW blocks (above the old cursor) per request: the first request also carries the re-read overlap
      // [from, next - 1] on top of it, so shrinking the window for a dense stretch keeps the overlap and shrinks the new part.
      const a = to + 1, b = Math.min(safe, Math.max(a, next) + chunk - 1);
      let r: unknown[];
      try { r = await rpc([logsCall(t.book, a, b, MARKET_TOPICS), blockCall(b)]); } catch (err) {
        if (rangeError(err) && chunk > MIN_CHUNK_BLOCKS) { chunk = Math.max(MIN_CHUNK_BLOCKS, chunk >> 1); stop = err; continue; } // too large for the node: retry the same start smaller
        stop = err; break;
      }
      const logs = Array.isArray(r[0]) ? (r[0] as RawLog[]) : [];
      const blk = r[1] as Block;
      if (!blk || !blk.hash) { stop = new RpcError('RPC_BEHIND'); break; } // the node does not have block b yet: do not advance past it
      // the per-run log cap counts logs ABOVE the old cursor only: the overlap re-read is idempotent and must not starve progress
      const fresh = logs.reduce((n, l) => n + (parseInt(l.blockNumber, 16) > cursorNow ? 1 : 0), 0);
      if (out.logs + fresh > MAX_LOGS_PER_RUN) { // this window would break the per-run log cap
        if (logCalls === 0 && chunk > MIN_CHUNK_BLOCKS) { chunk = Math.max(MIN_CHUNK_BLOCKS, chunk >> 1); continue; }
        break;
      }
      logCalls++; stop = null;
      out.logs += fresh; events.push(...decodeLogs(logs)); to = b; anchorHash = blk.hash.toLowerCase();
    }
  }
  out.from = from; out.to = to;
  if (to < from) {
    if (safe >= next) throw stop ?? new RpcError('RPC_NO_PROGRESS'); // blocks to read but none could be: an honest error, nothing written
    await finishWithoutBooks(db, meta, patch, schedule, cursorNow, now, caps, out); // no new confirmed block
    return { ...out, ran: true, reason: 'caught_up', cursor: cursorNow };
  }
  // 3. fold into the stored books (read-merge-write), ONCE, block by block. Blocks above the old cursor are counted against the
  // per-run caps (books touched, estimated bytes); when the next block would break a cap the run ends at the previous block. The
  // re-read overlap at or below the old cursor is always applied whole and never counts (it changes nothing in the normal case).
  const keys = [...new Map(events.map((e) => [bookKey(e.market, e.epoch), { m: e.market, e: e.epoch }])).values()];
  const stored = new Map<string, { book: CoreBook; json: string }>();
  for (const x of await loadBooks(db, keys)) stored.set(bookKey(x.book.market, x.book.epoch), x);
  const maxBooks = caps.maxBooks ?? MAX_BOOKS_PER_RUN, maxBytes = caps.maxBytes ?? MAX_RUN_BYTES;
  const ledger = newLedger(); const touched = new Set<string>(); const fresh = new Set<string>(); let est = 0; let lastNew = -1;
  for (let i = 0; i < events.length;) {
    const block = events[i].block; let j = i; while (j < events.length && events[j].block === block) j++;
    const group = events.slice(i, j);
    if (block > cursorNow) {
      const add = new Set(group.map((e) => bookKey(e.market, e.epoch)).filter((k) => !fresh.has(k)));
      let bytes = group.length * EVENT_BYTES; for (const k of add) bytes += 3 * (stored.get(k)?.json.length ?? 0);
      if (lastNew >= 0 && (fresh.size + add.size > maxBooks || est + bytes > maxBytes)) { events = events.slice(0, i); to = lastNew; anchorHash = null; out.capped = true; break; }
      for (const k of add) fresh.add(k);
      est += bytes; lastNew = block;
    }
    for (const e of group) { const k = bookKey(e.market, e.epoch); const x = stored.get(k); if (x && !ledger.books.has(k)) ledger.books.set(k, x.book); }
    for (const k of applyEvents(ledger, group, schedule)) touched.add(k);
    i = j;
  }
  const changed: CoreBook[] = [];
  for (const k of touched) { const b = ledger.books.get(k) as CoreBook; if (stored.get(k)?.json !== bookJson(b)) changed.push(b); }
  out.to = to; out.books = changed.length;
  const written = await writeBooks(db, changed);
  out.trimmed = written.trimmed; out.skipped = written.skipped;
  // The cursor never moves backwards (`next` is already the rewound cursor after a reorg). The window always reaches above the old
  // cursor, so the clamp only guards against a future change; a run that still does not advance says so ('no_progress').
  const newNext = Math.max(next, to + 1); const advanced = newNext > next;
  Object.assign(patch, { next_block: newNext, anchor_block: advanced && anchorHash ? to : null, anchor_hash: advanced ? anchorHash : null });
  out.cursor = newNext - 1;
  // 4. snapshot parts and cursor together, when something changed (or the parts lag behind the rows)
  const stale = changed.length > 0 || out.reorg || (await partsStale(db));
  if (stale) {
    if (written.statements.length) await db.batch(written.statements);
    await rebuildInto(db, meta, schedule, to, patch, now, caps, out);
  } else await db.batch([...written.statements, metaUpdate(db, patch)]);
  out.ran = true;
  if (!advanced && !out.reason) { out.reason = 'no_progress'; if (stop) { out.code = shortCode(stop); Object.assign(out, rpcCodeOf(stop)); } }
  else if (stop && !out.reason && to < safe) { out.code = shortCode(stop); Object.assign(out, rpcCodeOf(stop)); out.reason = 'partial'; }
  else if (!out.reason && to === safe) out.reason = 'caught_up';
  return out;
}

const rpcCodeOf = (err: unknown): { rpcCode?: number } => (err instanceof RpcError && err.rpcCode !== undefined ? { rpcCode: err.rpcCode } : {});

/** No new books: freshness (head, updated_at) still advances in a one-statement write; parts are rebuilt only if they lag behind the rows. */
async function finishWithoutBooks(db: D1Database, meta: MetaRow, patch: MetaPatch, schedule: Schedule, cursor: number, now: number, caps: RunCaps, out: IngestSummary): Promise<void> {
  if (cursor >= meta.deploy_block && await partsStale(db)) await rebuildInto(db, meta, schedule, cursor, patch, now, caps, out);
  else await metaUpdate(db, patch).run();
}

/**
 * True when the hot part is missing, was built before the newest stored row, or carries no cursor. One cheap statement
 * (a 40-character prefix of the part and an index lookup), run on quiet minutes only.
 */
async function partsStale(db: D1Database): Promise<boolean> {
  const r = await db.prepare(`SELECT (SELECT substr(body, 1, 40) FROM mk_snapshot WHERE part = 'hot') AS h, (SELECT MAX(last_block) FROM mk_epochs) AS lb`).first<{ h: string | null; lb: number | null }>();
  if (r?.h == null) return true; // no hot part yet
  const cur = partCursor(r.h);
  return cur === null || (r.lb !== null && r.lb > cur);
}

/** Rebuilds the parts together with the cursor; if the parts cannot be stored the cursor still advances and the hot part is dropped. */
async function rebuildInto(db: D1Database, meta: MetaRow, schedule: Schedule, cursor: number, patch: MetaPatch, now: number, caps: RunCaps, out: IngestSummary): Promise<void> {
  try {
    Object.assign(out, await rebuildParts(db, meta.cold_until, schedule, now, { cursor, patch, partMaxBytes: caps.partMaxBytes }));
  } catch (err) {
    if (!(err instanceof D1ValueTooLargeError) && !(err instanceof IngestError)) throw err;
    await db.batch([metaUpdate(db, patch), db.prepare(`DELETE FROM mk_snapshot WHERE part = 'hot'`)]);
    out.reason = 'parts_unavailable'; out.code = shortCode(err);
  }
}

/**
 * Rebuilds the hot part and, when 80+ epochs have left the hot window, graduates their clears to the cold part. The cursor the parts are
 * consistent with is read from the meta row BEFORE the rows (or passed in by the ingest, which has just written it); `patch` (the
 * ingest's meta update) goes into the same batch as the parts so cursor and parts never diverge. The ingest ALWAYS passes `patch`, so
 * its rebuild batch carries the meta update (head, cursor, updated_at); a standalone caller without `patch` only writes the parts
 * (and cold_until when it graduates).
 */
export async function rebuildParts(db: D1Database, coldUntil: number, schedule: Schedule, nowMs: number, opts: { cursor?: number; patch?: MetaPatch; partMaxBytes?: number } = {}): Promise<{ rebuilt: boolean; graduated: boolean }> {
  const cap = Math.min(opts.partMaxBytes ?? PART_MAX_BYTES, PART_MAX_BYTES);
  const cursor = opts.cursor ?? ((await getMeta(db))?.next_block ?? 1) - 1;
  const max = await maxEpoch(db);
  const hotFrom = max === null ? 0 : Math.max(0, max - HOT_EPOCHS + 1);
  const hashFrom = max === null ? 0 : max - HASH_EPOCHS + 1;
  const from = Math.min(coldUntil, hotFrom);
  let rows = await readRows(db, from, { hotFrom, hashFrom }); // only the column each row ships (see rowsFrom)
  const stmts: D1PreparedStatement[] = []; let graduated = false; let cu = coldUntil;
  const metaPatch: MetaPatch = { ...(opts.patch ?? {}) };
  if (hotFrom - coldUntil >= GRADUATE_EPOCHS) {
    const cold = await getPart(db, 'cold');
    const body = graduate(cold?.body ?? null, rows, coldUntil, hotFrom, schedule, cap);
    if (body.length > cap) throw new D1ValueTooLargeError('snapshot part cold', body.length);
    stmts.push(putPart(db, 'cold', body, nowMs), purgeBefore(db, hotFrom - RETAIN_EPOCHS));
    metaPatch.cold_until = hotFrom; graduated = true; cu = hotFrom;
  }
  const nominal = Math.max(hotFrom, cu);
  let fit: HotFit = { body: hotBody(rows, cu, nominal, hashFrom, cursor), hotFrom: nominal, trimmed: false };
  if (fit.body.length > cap || rows.reduce((n, r) => n + (r.epoch >= nominal ? 1 : 0), 0) > LIMITS.books) {
    // too big: dropping hashes or the oldest epochs needs the other columns too (lite_json of the hashed epochs, clear_json of the dropped ones)
    rows = await completeRows(db, rows, from, { hotFrom, hashFrom });
    fit = fitHot(rows, cu, nominal, hashFrom, cursor, cap);
  }
  if (fit.body.length > cap) throw new D1ValueTooLargeError('snapshot part hot', fit.body.length);
  stmts.push(putPart(db, 'hot', fit.body, nowMs));
  if (Object.keys(metaPatch).length) stmts.push(metaUpdate(db, metaPatch));
  await db.batch(stmts);
  return { rebuilt: true, graduated };
}
