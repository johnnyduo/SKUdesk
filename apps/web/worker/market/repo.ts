// D1 repository for the market snapshot tables (migrations/0002_market.sql). Bulk reads and writes go through json_each so one
// statement handles many rows: the Free plan allows 50 D1 queries per invocation, and every row counts against the daily budget.
import { fromSnapBook, toSnapBook, toSnapClear } from '../../src/lib/market-snap.ts';
import type { CoreBook } from '../../src/lib/market-core.ts';

export type MarketTarget = { rpc: string; book: string; chainId: number; deployBlock: number };
export type MetaRow = {
  id: 1; schema_version: number; chain_id: number; book: string; deploy_block: number; schedule_json: string | null;
  next_block: number; anchor_block: number | null; anchor_hash: string | null; head_block: number; head_time: number; cold_until: number; updated_at: number; lease_until: number;
};
export type MetaPatch = Partial<Pick<MetaRow, 'schedule_json' | 'next_block' | 'anchor_block' | 'anchor_hash' | 'head_block' | 'head_time' | 'cold_until' | 'updated_at'>>;
export type EpochRow = { market: string; epoch: number; book_json: string; lite_json: string; clear_json: string | null };
export type PartRow = { part: 'hot' | 'cold'; body: string; built_at: number };
export const UPSERT_CHUNK = 100;
export const LOAD_CHUNK = 400;
/** Real D1 rejects a string/row value above 2 MB and a statement above 100 KB (the fake enforces the same). Stay well below. */
export const D1_VALUE_LIMIT = 1_900_000;
export const D1_CHUNK_BYTES = 1_000_000;
/** Defensive cap for rowsFrom: one more than the snapshot's book cap (16384) so a caller can detect overflow. */
export const ROWS_LIMIT = 16_385;

export class D1ValueTooLargeError extends Error {
  readonly code = 'D1_VALUE_TOO_LARGE';
  constructor(what: string, bytes: number) { super(`D1_VALUE_TOO_LARGE: ${what} is ${bytes} bytes, limit ${D1_VALUE_LIMIT}`); this.name = 'D1ValueTooLargeError'; }
}
const enc = new TextEncoder();
const bytesOf = (s: string) => enc.encode(s).length;
const lc = (b: CoreBook): CoreBook => (b.market === b.market.toLowerCase() ? b : { ...b, market: b.market.toLowerCase() });

export async function getMeta(db: D1Database): Promise<MetaRow | null> {
  return db.prepare('SELECT * FROM mk_meta WHERE id = 1').first<MetaRow>();
}

export const LEASE_MS = 120_000;
/**
 * Cron lease: one run at a time. Creates the meta row if it does not exist yet (a placeholder at the deploy block, which is what
 * resetMarket would write, but with schema_version 0, so the run sees it as a foreign deployment and wipes leftover market rows
 * after its chain check instead of trusting them), then takes the lease only if nobody holds an unexpired one. Returns the lease expiry (pass it to
 * releaseLease) or null when another run holds it. One round trip; a crashed holder blocks the ingest for LEASE_MS at most.
 */
export async function acquireLease(db: D1Database, t: MarketTarget, nowMs: number): Promise<number | null> {
  const until = nowMs + LEASE_MS;
  const [, took] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO mk_meta (id, schema_version, chain_id, book, deploy_block, schedule_json, next_block, anchor_block, anchor_hash, head_block, head_time, cold_until, updated_at, lease_until)
      VALUES (1, 0, ?1, ?2, ?3, NULL, ?3, NULL, NULL, 0, 0, 0, ?4, 0)`).bind(t.chainId, t.book.toLowerCase(), t.deployBlock, nowMs),
    db.prepare('UPDATE mk_meta SET lease_until = ?1 WHERE id = 1 AND lease_until <= ?2').bind(until, nowMs),
  ]);
  return took.meta.changes === 1 ? until : null;
}
/** Frees the lease taken with `until`; a no-op when it has expired and another run has taken over. */
export async function releaseLease(db: D1Database, until: number): Promise<void> {
  await db.prepare('UPDATE mk_meta SET lease_until = 0 WHERE id = 1 AND lease_until = ?1').bind(until).run();
}

/** Starts over from the deploy block: drops all market rows and rewrites the meta row (the lease of the calling run is kept). Used on first run and on any identity change. */
export async function resetMarket(db: D1Database, t: MarketTarget, schemaVersion: number, nowMs: number): Promise<MetaRow> {
  await db.batch([
    db.prepare('DELETE FROM mk_epochs'),
    db.prepare('DELETE FROM mk_snapshot'),
    db.prepare(`INSERT INTO mk_meta (id, schema_version, chain_id, book, deploy_block, schedule_json, next_block, anchor_block, anchor_hash, head_block, head_time, cold_until, updated_at)
      VALUES (1, ?1, ?2, ?3, ?4, NULL, ?4, NULL, NULL, 0, 0, 0, ?5)
      ON CONFLICT (id) DO UPDATE SET schema_version = excluded.schema_version, chain_id = excluded.chain_id, book = excluded.book, deploy_block = excluded.deploy_block,
        schedule_json = NULL, next_block = excluded.next_block, anchor_block = NULL, anchor_hash = NULL, head_block = 0, head_time = 0, cold_until = 0, updated_at = excluded.updated_at`).bind(schemaVersion, t.chainId, t.book.toLowerCase(), t.deployBlock, nowMs),
  ]);
  return (await getMeta(db))!;
}

const COLS = ['schedule_json', 'next_block', 'anchor_block', 'anchor_hash', 'head_block', 'head_time', 'cold_until', 'updated_at'] as const;
export function metaUpdate(db: D1Database, patch: MetaPatch): D1PreparedStatement {
  const keys = COLS.filter((k) => patch[k] !== undefined);
  if (!keys.length) return db.prepare('UPDATE mk_meta SET id = id WHERE id = 1');
  return db.prepare(`UPDATE mk_meta SET ${keys.map((k, i) => `${k} = ?${i + 1}`).join(', ')} WHERE id = 1`).bind(...keys.map((k) => patch[k] ?? null));
}

/** Books for the given (market, epoch) keys that already exist. */
export async function loadBooks(db: D1Database, keys: { m: string; e: number }[]): Promise<{ book: CoreBook; json: string }[]> {
  const out: { book: CoreBook; json: string }[] = [];
  for (let i = 0; i < keys.length; i += LOAD_CHUNK) {
    const { results } = await db.prepare(
      `SELECT book_json FROM mk_epochs WHERE (market, epoch) IN (SELECT json_extract(value, '$.m'), json_extract(value, '$.e') FROM json_each(?1))`,
    ).bind(JSON.stringify(keys.slice(i, i + LOAD_CHUNK).map((k) => ({ m: k.m.toLowerCase(), e: k.e })))).all<{ book_json: string }>();
    for (const r of results) out.push({ book: fromSnapBook(JSON.parse(r.book_json)), json: r.book_json });
  }
  return out;
}

/** Canonical serialization (market lower-cased); stored as book_json, so change detection compares like with like. */
export function bookJson(b: CoreBook): string { return JSON.stringify(toSnapBook(lc(b), true)); }

/**
 * Upserts books, one JSON parameter per statement. A chunk closes at UPSERT_CHUNK rows or when its serialized parameter would pass
 * D1_CHUNK_BYTES (D1 caps a bound value at 2 MB); a book above D1_VALUE_LIMIT on its own throws D1ValueTooLargeError before any
 * statement exists. A row only changes when its content does, so re-ingesting the same logs writes nothing.
 * Returns statements for one db.batch together with the meta update.
 */
export function upsertBooks(db: D1Database, books: CoreBook[]): D1PreparedStatement[] {
  const chunks: string[][] = [];
  let cur: string[] = []; let curBytes = 0;
  for (const raw of books) {
    const b = lc(raw);
    const row = JSON.stringify({
      m: b.market, e: b.epoch, fb: b.firstBlock, lb: b.lastBlock, book: bookJson(b), lite: JSON.stringify(toSnapBook(b, false)),
      clear: b.clear ? JSON.stringify(toSnapClear(b.epoch, b.clear, true)) : null,
    });
    const n = bytesOf(row);
    if (n > D1_VALUE_LIMIT) throw new D1ValueTooLargeError(`book ${b.market} epoch ${b.epoch}`, n);
    if (cur.length && (cur.length >= UPSERT_CHUNK || curBytes + n + 1 > D1_CHUNK_BYTES)) { chunks.push(cur); cur = []; curBytes = 0; }
    cur.push(row); curBytes += n + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((rows) => db.prepare(
    `INSERT INTO mk_epochs (market, epoch, first_block, last_block, book_json, lite_json, clear_json)
     SELECT json_extract(value, '$.m'), json_extract(value, '$.e'), json_extract(value, '$.fb'), json_extract(value, '$.lb'),
            json_extract(value, '$.book'), json_extract(value, '$.lite'), json_extract(value, '$.clear')
     FROM json_each(?1) WHERE true
     ON CONFLICT (market, epoch) DO UPDATE SET first_block = excluded.first_block, last_block = excluded.last_block,
       book_json = excluded.book_json, lite_json = excluded.lite_json, clear_json = excluded.clear_json
     WHERE excluded.first_block IS NOT mk_epochs.first_block OR excluded.last_block IS NOT mk_epochs.last_block
        OR excluded.book_json IS NOT mk_epochs.book_json OR excluded.lite_json IS NOT mk_epochs.lite_json
        OR excluded.clear_json IS NOT mk_epochs.clear_json`,
  ).bind(`[${rows.join(',')}]`));
}

/**
 * The columns a slim window read (rowsFrom with a window) leaves out and the over-cap fallback needs, for epochs >= hotFrom only:
 * lite_json from hashFrom (the hashed band shipped book_json instead) and clear_json (a dropped epoch keeps its clearing point).
 */
export async function rowsExtra(db: D1Database, window: { hotFrom: number; hashFrom: number }, limit = ROWS_LIMIT): Promise<EpochRow[]> {
  const { results } = await db.prepare(`SELECT market, epoch, '' AS book_json,
      CASE WHEN epoch >= ?2 THEN lite_json ELSE '' END AS lite_json, clear_json
      FROM mk_epochs WHERE epoch >= ?1 ORDER BY epoch, market LIMIT ?3`).bind(window.hotFrom, window.hashFrom, limit).all<EpochRow>();
  return results;
}

export async function maxEpoch(db: D1Database): Promise<number | null> {
  const r = await db.prepare('SELECT MAX(epoch) AS e FROM mk_epochs').first<{ e: number | null }>();
  return r?.e ?? null;
}

/**
 * Rows from `epoch` upward, oldest first, at most `limit` (default ROWS_LIMIT).
 * Without `window`: all five columns. With the hot window of the snapshot builder only the column each row ships is selected
 * (the others come back as ''/NULL): book_json for epoch >= hashFrom, lite_json for hotFrom <= epoch < hashFrom, clear_json for
 * epoch < hotFrom. A busy hot window is megabytes of JSON; D1 decoding the unused columns cost CPU on every rebuild.
 */
export async function rowsFrom(db: D1Database, epoch: number, limit = ROWS_LIMIT, window?: { hotFrom: number; hashFrom: number }): Promise<EpochRow[]> {
  const { results } = window
    ? await db.prepare(`SELECT market, epoch,
        CASE WHEN epoch >= ?3 THEN book_json ELSE '' END AS book_json,
        CASE WHEN epoch >= ?4 AND epoch < ?3 THEN lite_json ELSE '' END AS lite_json,
        CASE WHEN epoch < ?4 THEN clear_json END AS clear_json
        FROM mk_epochs WHERE epoch >= ?1 ORDER BY epoch, market LIMIT ?2`).bind(epoch, limit, window.hashFrom, window.hotFrom).all<EpochRow>()
    : await db.prepare('SELECT market, epoch, book_json, lite_json, clear_json FROM mk_epochs WHERE epoch >= ?1 ORDER BY epoch, market LIMIT ?2').bind(epoch, limit).all<EpochRow>();
  return results;
}

export async function getParts(db: D1Database): Promise<{ hot: PartRow | null; cold: PartRow | null }> {
  const { results } = await db.prepare('SELECT part, body, built_at FROM mk_snapshot').all<PartRow>();
  return { hot: results.find((r) => r.part === 'hot') ?? null, cold: results.find((r) => r.part === 'cold') ?? null };
}
export async function getPart(db: D1Database, part: 'hot' | 'cold'): Promise<PartRow | null> {
  return db.prepare('SELECT part, body, built_at FROM mk_snapshot WHERE part = ?1').bind(part).first<PartRow>();
}
export function putPart(db: D1Database, part: 'hot' | 'cold', body: string, builtAt: number): D1PreparedStatement {
  const n = bytesOf(body);
  if (n > D1_VALUE_LIMIT) throw new D1ValueTooLargeError(`snapshot part ${part}`, n);
  return db.prepare('INSERT INTO mk_snapshot (part, body, built_at) VALUES (?1, ?2, ?3) ON CONFLICT (part) DO UPDATE SET body = excluded.body, built_at = excluded.built_at').bind(part, body, builtAt);
}
export function purgeBefore(db: D1Database, epoch: number): D1PreparedStatement {
  return db.prepare('DELETE FROM mk_epochs WHERE epoch < ?1').bind(epoch);
}

/**
 * Reorg rewind, step 1 (read): every book touched at or after `fromBlock` will be dropped and must be re-read from its first block,
 * so ingestion restarts at the smallest first_block among them (or at fromBlock when none). Rare path; the query is served by idx_mk_epochs_last (migration 0002), so it does not scan every row.
 */
export async function rewindStart(db: D1Database, fromBlock: number): Promise<number> {
  const r = await db.prepare('SELECT MIN(first_block) AS b FROM mk_epochs WHERE last_block >= ?1').bind(fromBlock).first<{ b: number | null }>();
  return Math.min(fromBlock, r?.b ?? fromBlock);
}
/** Reorg rewind, step 2 (write, batched with the cursor move so the two can never diverge). */
export function deleteFromBlock(db: D1Database, fromBlock: number): D1PreparedStatement {
  return db.prepare('DELETE FROM mk_epochs WHERE last_block >= ?1').bind(fromBlock);
}
