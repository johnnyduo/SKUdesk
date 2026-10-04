// node --test test/market/market-idb.test.ts   (from apps/web)
// The production cache path without a browser: market-cache.ts indexedDbKV over a minimal in-memory IndexedDB (helpers/fake-idb.ts),
// the real store warm-starting from it, and market-app.ts's wiring (bundled with esbuild, like the site tests do).
// The real browser IndexedDB is covered by the Playwright probes (scripts/market-probe.cjs warm run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEvents, clearPoints, decodeLogs, newLedger, type RawLog } from '../../src/lib/market-core.ts';
import { buildSnapshot } from '../../src/lib/market-snap.ts';
import { CACHE_KEY, indexedDbKV, readCache, writeCache } from '../../src/lib/market-cache.ts';
import { createMarketStore, type MarketConfig, type MarketStore } from '../../src/lib/market.ts';
import { FAKE_SCHEDULE, startFakeRpc } from './helpers/fake-rpc.mjs';
import { fakeIndexedDB } from './helpers/fake-idb.ts';
import { loadNodeModule } from '../site/helpers/bundle.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
const CATALOG = JSON.parse(readFileSync(new URL('../../src/data/catalog.json', import.meta.url), 'utf8')).markets;
const BOOK = '0x2BA62631d74827aBF2f7467B20370dC2DC59aa11', DEPLOY = 127690064, HEAD = 127999300;
const ID = { chainId: 46630, book: BOOK.toLowerCase(), deployBlock: DEPLOY };
const FULL = (() => { const l = newLedger(); applyEvents(l, decodeLogs(FX.logs), FAKE_SCHEDULE); return l; })();
const SNAP = buildSnapshot(FULL, { ...ID, cursor: 127999285, head: 127999285, headTime: 1, builtAt: 1, complete: true }, FAKE_SCHEDULE);
const cfg = (rpc: string, over: Partial<MarketConfig> = {}): MarketConfig => ({ chain: { id: 46630, name: 'test', rpc, explorer: '' }, book: BOOK, deployBlock: DEPLOY, catalog: CATALOG, pollMs: 600_000, logChunk: 3000, snapshotUrl: null, ...over });
async function until(store: MarketStore, pred: (s: ReturnType<MarketStore['getState']>) => boolean, ms = 8000) {
  const t = Date.now(); while (Date.now() - t < ms) { if (pred(store.getState())) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
}
const withIdb = async (fn: (idb: ReturnType<typeof fakeIndexedDB>) => Promise<void>) => {
  const idb = fakeIndexedDB(); (globalThis as any).indexedDB = idb;
  try { await fn(idb); } finally { delete (globalThis as any).indexedDB; }
};

test('indexedDbKV round trip: one database "skudesk-market", one store "kv", created once, values really stored', () => withIdb(async (idb) => {
  const kv = indexedDbKV();
  assert.equal(await kv.get('a'), undefined);
  await kv.set('a', 'one'); assert.equal(await kv.get('a'), 'one');
  assert.equal(idb.data.get('skudesk-market')!.get('kv')!.get('a'), 'one');
  await kv.del('a'); assert.equal(await kv.get('a'), undefined);
  assert.equal(await indexedDbKV().get('a'), undefined); // a second connection (next visit) finds the store and does not upgrade again
  assert.equal(idb.upgrades, 1);
}));

test('a failing, blocked or aborting IndexedDB reads as "no cache" and the write reports false; nothing throws', async () => {
  for (const mode of ['error', 'blocked', 'abort'] as const) await withIdb(async (idb) => {
    idb.mode = mode; const kv = indexedDbKV();
    assert.equal(await readCache(kv, ID, Date.now()), null, mode);
    assert.equal(await writeCache(kv, ID, SNAP, Date.now()), false, mode);
  });
});

test('another tab upgrading the database (versionchange) closes our connection; the next call reopens and works', () => withIdb(async (idb) => {
  const kv = indexedDbKV(); await kv.set('a', '1'); assert.equal(idb.opens, 1);
  idb.versionChange();
  assert.equal(await kv.get('a'), '1'); assert.equal(idb.opens, 2);
}));

test('a cache entry of another book (a redeploy) is never read through IndexedDB, and it is deleted', () => withIdb(async (idb) => {
  const kv = indexedDbKV();
  assert.equal(await writeCache(kv, { ...ID, book: '0x' + '1'.repeat(40) }, SNAP, Date.now()), true);
  assert.equal(await readCache(kv, ID, Date.now()), null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(idb.data.get('skudesk-market')!.get('kv')!.has(CACHE_KEY), false);
}));

test('the real store over IndexedDB: the first visit writes the cache, the next visit starts from it (source "cache")', () => withIdb(async (idb) => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const a = createMarketStore(cfg(rpc.url, { kv: indexedDbKV() }));
  try { await a.start(); await until(a, (s) => s.historyComplete); await until(a, () => !!idb.data.get('skudesk-market')?.get('kv')?.has(CACHE_KEY)); } finally { a.stop(); }
  const b = createMarketStore(cfg(rpc.url, { kv: indexedDbKV() }));
  try {
    await b.start(); await until(b, (s) => s.historyComplete);
    assert.equal(b.getState().source, 'cache');
    assert.deepEqual(b.getState().clears, clearPoints(FULL));
  } finally { b.stop(); await rpc.close(); }
}));

test('market-app wires the production store: snapshot URL, IndexedDB cache when it exists, none in Node; one label helper with the registry', async () => {
  // a distinct export per load: esbuild drops comments, and an identical bundle would come back from the module cache
  const entry = (tag: string) => `export const tag = ${JSON.stringify(tag)};\nexport { MARKET_CONFIG, KEEPER_BOTS, labelWallet } from './src/lib/market-app.ts';`;
  await withIdb(async (idb) => {
    const app = await loadNodeModule<any>(entry('with indexedDB'));
    assert.equal(app.MARKET_CONFIG.snapshotUrl, '/api/market/snapshot');
    assert.ok(app.MARKET_CONFIG.kv, 'kv is wired');
    await app.MARKET_CONFIG.kv.set('probe', 'x');
    assert.equal(idb.data.get('skudesk-market')!.get('kv')!.get('probe'), 'x', 'the store cache goes to IndexedDB');
    assert.equal(app.labelWallet(app.KEEPER_BOTS.bots[0].address, []).name, 'Bot 1');
    assert.equal(app.labelWallet('0x' + 'a'.repeat(40), ['0x' + 'a'.repeat(40)]).name, 'Agent A');
  });
  const ssr = await loadNodeModule<any>(entry('no indexedDB (Astro build)'));
  assert.equal(ssr.MARKET_CONFIG.kv, undefined);
});

test('market-app survives an indexedDB getter that throws (sandboxed iframe, blocked storage): kv is undefined and the store still builds', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
  try {
    const app = await loadNodeModule<any>(`export const tag = 'throwing indexedDB getter';\nexport { MARKET_CONFIG, marketStore } from './src/lib/market-app.ts';`);
    assert.equal(app.MARKET_CONFIG.kv, undefined, 'no cache, but the module evaluated');
    assert.equal(app.MARKET_CONFIG.snapshotUrl, '/api/market/snapshot');
    assert.equal(app.marketStore.getState().ready, false, 'the page store exists and has not started');
  } finally { if (had) Object.defineProperty(globalThis, 'indexedDB', had); else delete (globalThis as any).indexedDB; }
});
