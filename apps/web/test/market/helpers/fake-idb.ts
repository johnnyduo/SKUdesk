// A minimal in-memory IndexedDB for Node tests: exactly the surface market-cache.ts indexedDbKV uses (open + upgrade, one object store,
// get/put/delete in a transaction, versionchange/close), with the browser's asynchronous event order. Not a general IndexedDB.
// Modes: 'ok' (default), 'error' (open fails), 'blocked' (open is blocked by another tab), 'abort' (every transaction aborts).
type Req = { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void; onblocked?: () => void };
export type FakeIDB = {
  open(name: string, version: number): Req;
  /** name -> store -> key -> value: what was really written */
  data: Map<string, Map<string, Map<string, unknown>>>;
  opens: number; upgrades: number; mode: 'ok' | 'error' | 'blocked' | 'abort';
  /** fires versionchange on every open connection (another tab upgrades or deletes the database) */
  versionChange(): void;
};

export function fakeIndexedDB(): FakeIDB {
  const later = (f: () => void) => setTimeout(f, 0);
  const conns: any[] = [];
  const idb: FakeIDB = {
    data: new Map(), opens: 0, upgrades: 0, mode: 'ok',
    versionChange() { for (const c of [...conns]) c.onversionchange?.(); },
    open(name) {
      idb.opens++; const req: Req = {};
      later(() => {
        if (idb.mode === 'error') { req.error = new Error('UnknownError'); req.onerror?.(); return; }
        if (idb.mode === 'blocked') { req.onblocked?.(); return; }
        let stores = idb.data.get(name); const fresh = !stores; if (!stores) { stores = new Map(); idb.data.set(name, stores); }
        const db: any = {
          objectStoreNames: { contains: (s: string) => stores!.has(s) },
          createObjectStore: (s: string) => { stores!.set(s, new Map()); },
          close: () => { const i = conns.indexOf(db); if (i >= 0) conns.splice(i, 1); },
          transaction: (s: string, _mode: string) => {
            const t: any = {}; const map = stores!.get(s);
            const done = (r: Req, v?: unknown) => { r.result = v; later(() => (idb.mode === 'abort' ? t.onabort?.() : t.oncomplete?.())); return r; };
            t.objectStore = () => ({
              get: (k: string) => done({}, map?.get(k)),
              put: (v: unknown, k: string) => { if (idb.mode !== 'abort') map?.set(k, v); return done({}, k); },
              delete: (k: string) => { if (idb.mode !== 'abort') map?.delete(k); return done({}); },
            });
            return t;
          },
        };
        conns.push(db); req.result = db;
        if (fresh) { idb.upgrades++; req.onupgradeneeded?.(); }
        req.onsuccess?.();
      });
      return req;
    },
  };
  return idb;
}
