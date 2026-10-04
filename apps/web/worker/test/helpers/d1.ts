// D1-compatible fake backed by node:sqlite (built into Node 26). Applies the real migration files.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

type Stmt = {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ success: true; meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ success: true; results: T[] }>;
};

// Real D1 limits (https://developers.cloudflare.com/d1/platform/limits/): 2 MB per string/BLOB/row value, 100 KB per SQL statement.
// node:sqlite enforces neither, so the fake does, with SQLITE_TOOBIG like D1: a caller that breaches them fails in tests, not in production.
export const D1_MAX_VALUE_BYTES = 2_000_000;
export const D1_MAX_STATEMENT_BYTES = 100_000;
function checkLimits(sql: string, params: unknown[]) {
  if (Buffer.byteLength(sql) > D1_MAX_STATEMENT_BYTES) throw new Error('D1_ERROR: statement too long: SQLITE_TOOBIG');
  for (const v of params) {
    const n = typeof v === 'string' ? Buffer.byteLength(v) : v instanceof Uint8Array ? v.byteLength : 0;
    if (n > D1_MAX_VALUE_BYTES) throw new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG');
  }
}

export function sqliteD1(migrationFiles: string[] = [new URL('../../migrations/0001_init.sql', import.meta.url).pathname]) {
  const db = new DatabaseSync(':memory:');
  for (const file of migrationFiles) db.exec(readFileSync(file, 'utf8'));
  const make = (sql: string, params: unknown[]): Stmt => ({
    bind: (...values: unknown[]) => make(sql, values),
    async first<T>() {
      checkLimits(sql, params);
      const row = db.prepare(sql).get(...(params as never[]));
      return (row ? { ...row } : null) as T | null;
    },
    async run() {
      checkLimits(sql, params);
      const r = db.prepare(sql).run(...(params as never[]));
      return { success: true as const, meta: { changes: Number(r.changes) } };
    },
    async all<T>() {
      checkLimits(sql, params);
      const rows = db.prepare(sql).all(...(params as never[]));
      return { success: true as const, results: rows.map((r) => ({ ...r })) as T[] };
    },
  });
  // D1 batch: every statement in one transaction, all or nothing (https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
  // Batches from concurrent callers run one after the other (one connection: a second BEGIN would fail), as D1 serialises them.
  let tail: Promise<unknown> = Promise.resolve();
  function batch(stmts: Stmt[]) {
    const run = async () => {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (err) { db.exec('ROLLBACK'); throw err; }
    };
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
  }
  return { raw: db, prepare: (sql: string) => make(sql, []), batch };
}
