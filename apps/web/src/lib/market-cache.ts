// Persistent browser cache of the market snapshot (IndexedDB), behind a tiny key-value interface so tests use an in-memory fake.
// Rules: one key, a versioned envelope, a TTL and a size cap. ANY failure (no IndexedDB, private mode, quota, corrupt or foreign
// data, a hung open) reads as "no cache": the page then loads normally. Nothing here can block the first paint or throw.
import { HASH_EPOCHS, HOT_EPOCHS, SNAPSHOT_VERSION, buildSnapshot, validateSnapshot, type MarketSnapshot, type SnapshotIdentity, type SnapshotMeta } from './market-snap.ts';
import type { Ledger, Schedule } from './market-core.ts';

export type KV = { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; del(key: string): Promise<void> };
export const CACHE_KEY = 'market-snapshot';
export const CACHE_SCHEMA = 1;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_BYTES = 3_000_000;
export const CACHE_READ_TIMEOUT_MS = 800;
export const CACHE_WRITE_TIMEOUT_MS = 5000;
/** Window between cache writes, and the back-off after a failed one. */
export const CACHE_WRITE_EVERY_MS = 5 * 60 * 1000;

/** Identity of a cache entry: schema + snapshot format + chain + contract + deployment. Anything else is ignored and deleted. */
export const cacheId = (id: SnapshotIdentity) => `v${CACHE_SCHEMA}.${SNAPSHOT_VERSION}:${id.chainId}:${id.book.toLowerCase()}:${id.deployBlock}`;
type Envelope = { k: string; savedAt: number; body: MarketSnapshot };

export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

export async function readCache(kv: KV, id: SnapshotIdentity, nowMs: number, timeoutMs = CACHE_READ_TIMEOUT_MS): Promise<MarketSnapshot | null> {
  let raw: string | undefined;
  try { raw = await withTimeout(Promise.resolve().then(() => kv.get(CACHE_KEY)), timeoutMs, undefined); } catch { return null; }
  if (raw === undefined) return null;
  try {
    if (typeof raw !== 'string' || raw.length > CACHE_MAX_BYTES) throw new Error('size');
    const env = JSON.parse(raw) as Envelope;
    if (!env || env.k !== cacheId(id) || typeof env.savedAt !== 'number' || nowMs - env.savedAt > CACHE_TTL_MS || env.savedAt > nowMs + 60_000) throw new Error('stale');
    const snap = validateSnapshot(env.body, id);
    if (!snap) throw new Error('invalid');
    return snap;
  } catch {
    void Promise.resolve().then(() => kv.del(CACHE_KEY)).catch(() => undefined);
    return null;
  }
}

/** Stores the snapshot; false when it is too large, storage refuses or does not answer in time. Never throws. */
export async function writeCache(kv: KV, id: SnapshotIdentity, snap: MarketSnapshot, nowMs: number, timeoutMs = CACHE_WRITE_TIMEOUT_MS): Promise<boolean> {
  try {
    const raw = JSON.stringify({ k: cacheId(id), savedAt: nowMs, body: snap } satisfies Envelope);
    if (raw.length > CACHE_MAX_BYTES) return false;
    return await withTimeout(Promise.resolve().then(() => kv.set(CACHE_KEY, raw)).then(() => true), timeoutMs, false);
  } catch { return false; }
}

/** Size of the stored entry (the envelope as written). */
const entryBytes = (id: SnapshotIdentity, snap: MarketSnapshot, nowMs: number) => JSON.stringify({ k: cacheId(id), savedAt: nowMs, body: snap } satisfies Envelope).length;

/**
 * The snapshot of `ledger` that fits the cache cap, or null when even the clearing points alone do not. The same shrinking order as the Worker's
 * fitHot (worker/market/assemble.ts): whole size first, then without commit hashes, then fewer hot epochs (newest kept; every clear stays, the
 * ones of dropped books move to the cold part). buildSnapshot does the work, so the result is exactly what readCache/validateSnapshot accept.
 */
export function fitSnapshot(ledger: Ledger, meta: SnapshotMeta, schedule: Schedule, id: SnapshotIdentity, nowMs: number, maxBytes = CACHE_MAX_BYTES): MarketSnapshot | null {
  const at = (hotEpochs: number, hashEpochs: number) => { const snap = buildSnapshot(ledger, meta, schedule, { hotEpochs, hashEpochs }); return { snap, bytes: entryBytes(id, snap, nowMs) }; };
  const full = at(HOT_EPOCHS, HASH_EPOCHS); if (full.bytes <= maxBytes) return full.snap;
  const noHash = at(HOT_EPOCHS, 0); if (noHash.bytes <= maxBytes) return noHash.snap;
  const cold = at(0, 0); if (cold.bytes > maxBytes) return null;   // the clearing points alone are over the cap: nothing sensible to store
  // bytes grow about linearly with the hot epochs: aim a little under the cap, then step down until it fits
  const perEpoch = Math.max(1, (noHash.bytes - cold.bytes) / HOT_EPOCHS);
  let hot = Math.min(HOT_EPOCHS - 1, Math.floor(((maxBytes - cold.bytes) / perEpoch) * 0.95));
  for (let i = 0; i < 8 && hot > 0; i++) {
    const r = at(hot, 0); if (r.bytes <= maxBytes) return r.snap;
    hot = Math.floor(hot * Math.min(0.9, (maxBytes / r.bytes) * 0.95));
  }
  return cold.snap;
}

/** fitSnapshot + writeCache. False when nothing fitting could be built or the write failed. Never throws. */
export async function writeFitted(kv: KV, id: SnapshotIdentity, ledger: Ledger, meta: SnapshotMeta, schedule: Schedule, nowMs: number, timeoutMs = CACHE_WRITE_TIMEOUT_MS): Promise<boolean> {
  try { const snap = fitSnapshot(ledger, meta, schedule, id, nowMs); return snap ? await writeCache(kv, id, snap, nowMs, timeoutMs) : false; } catch { return false; }
}

/**
 * When the cache may be written: at most once per `everyMs`, and after a failed write not again before `everyMs` has passed - even for a forced
 * write (a rebuild + serialize of a big snapshot must not repeat). The clock is injected for tests.
 */
export function createCacheGate(now: () => number = () => Date.now(), everyMs = CACHE_WRITE_EVERY_MS) {
  let last = -Infinity, blockedUntil = -Infinity;
  return {
    /** force skips the regular window only; it never skips the back-off after a failure. */
    allowed(force: boolean): boolean { const t = now(); return t >= blockedUntil && (force || t - last >= everyMs); },
    begin(): void { last = now(); },
    done(ok: boolean): void { blockedUntil = ok ? -Infinity : now() + everyMs; },
  };
}

export function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k), set: async (k, v) => { data.set(k, v); }, del: async (k) => { data.delete(k); } };
}

/** IndexedDB-backed KV (database "skudesk-market", store "kv"). Every operation rejects instead of throwing synchronously. */
export function indexedDbKV(dbName = 'skudesk-market', storeName = 'kv'): KV {
  let dbp: Promise<any> | null = null;
  const open = (): Promise<any> => (dbp ??= new Promise((resolve, reject) => {
    const idb = (globalThis as any).indexedDB; if (!idb) { reject(new Error('no indexedDB')); return; }
    const req = idb.open(dbName, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch { /* already closed */ } dbp = null; }; // another tab upgrades or deletes: let go and reopen on demand
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('idb open failed')); req.onblocked = () => reject(new Error('idb blocked'));
  }).catch((e) => { dbp = null; throw e; }));
  const tx = (mode: 'readonly' | 'readwrite', fn: (s: any) => any): Promise<any> => open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode); const r = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(r?.result); t.onerror = () => reject(t.error ?? new Error('idb tx failed')); t.onabort = () => reject(t.error ?? new Error('idb tx aborted'));
  }));
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).then((v) => (typeof v === 'string' ? v : undefined)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)).then(() => undefined),
    del: (k) => tx('readwrite', (s) => s.delete(k)).then(() => undefined),
  };
}
