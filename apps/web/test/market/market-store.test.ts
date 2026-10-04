// node --test test/market/market-store.test.ts   (from apps/web)
// The real store (viem + market-core) against a local fake JSON-RPC that serves the captured chain logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { TOPICS, applyEvents, clearPoints, decodeLogs, fillRows, liveBooks, newLedger, traderOrder, type RawLog } from '../../src/lib/market-core.ts';
import { buildSnapshot, hotFrom, hydrate as hydrateReal } from '../../src/lib/market-snap.ts';
import { memoryKV, readCache, writeCache, type KV } from '../../src/lib/market-cache.ts';
import { TRAIL_BLOCKS, createMarketStore, type MarketConfig, type MarketStore } from '../../src/lib/market.ts';
import { FAKE_SCHEDULE, startFakeRpc } from './helpers/fake-rpc.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
// the six markets of the book the fixture logs were captured from (the first BlindBook, 2026-10-03): the Accessories entries of the catalog
const CATALOG = (JSON.parse(readFileSync(new URL('../../src/data/catalog.json', import.meta.url), 'utf8')).markets as { category: string }[]).filter((m) => m.category === 'Accessories');
const BOOK = '0x2BA62631d74827aBF2f7467B20370dC2DC59aa11';
// The real deployment block (src/data/blindbook.json). The fixture starts at 127690104, so a later deployBlock would leave the first events out of every chain-path load.
const DEPLOY = 127690064, HEAD = 127999300;
const ID = { chainId: 46630, book: BOOK.toLowerCase(), deployBlock: DEPLOY };
const FULL = (() => { const l = newLedger(); applyEvents(l, decodeLogs(FX.logs), FAKE_SCHEDULE); return l; })();
const cfg = (rpc: string, over: Partial<MarketConfig> = {}): MarketConfig => ({ chain: { id: 46630, name: 'test', rpc, explorer: '' }, book: BOOK, deployBlock: DEPLOY, catalog: CATALOG, pollMs: 600_000, logChunk: 3000, snapshotUrl: null, ...over });
async function until(store: MarketStore, pred: (s: ReturnType<MarketStore['getState']>) => boolean, ms = 8000) {
  const t = Date.now(); while (Date.now() - t < ms) { if (pred(store.getState())) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout; state: ' + JSON.stringify({ ready: store.getState().ready, complete: store.getState().historyComplete, error: store.getState().error }));
}
const snapUpTo = (cursor: number, complete = true) => {
  const l = newLedger(); applyEvents(l, decodeLogs(FX.logs.filter((x) => parseInt(x.blockNumber, 16) <= cursor)), FAKE_SCHEDULE);
  return buildSnapshot(l, { ...ID, cursor, head: cursor, headTime: 1, builtAt: 1, complete }, FAKE_SCHEDULE);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });

/** A JSON-RPC pass-through in front of the fake RPC that records the eth_getLogs ranges and can inject failures or stray logs. */
type Proxy = { url: string; ranges: Array<[number, number]>; close(): Promise<void> };
async function startProxy(target: string, o: { fail?: (method: string, from: number) => boolean; failCode?: number; delayLogsMs?: number; noise?: (from: number, to: number) => RawLog[] } = {}): Promise<Proxy> {
  const ranges: Array<[number, number]> = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const send = (x: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
      const { id, method, params = [] } = JSON.parse(body);
      const f = method === 'eth_getLogs' ? parseInt(params[0].fromBlock, 16) : 0, t = method === 'eth_getLogs' ? parseInt(params[0].toBlock, 16) : 0;
      if (method === 'eth_getLogs') ranges.push([f, t]);
      if (o.fail?.(method, f)) return send({ jsonrpc: '2.0', id, error: { code: o.failCode ?? -32000, message: 'injected failure' } });
      if (method === 'eth_getLogs' && o.delayLogsMs) await sleep(o.delayLogsMs);
      try {
        const out: any = await (await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json();
        if (method === 'eth_getLogs' && o.noise && Array.isArray(out.result)) out.result.push(...o.noise(f, t));
        send(out);
      } catch { res.destroy(); } // the target was closed while a delayed request was in flight (end of a test)
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, ranges, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
const CLEAR_MARKET = FX.logs.find((l) => l.topics[0] === TOPICS.clear)!.topics[1];
/** A well-formed EpochCleared for a far-future epoch: it shows up in the clears if (and only if) the store accepts events outside the range it asked for. */
const rawClear = (epoch: number, block: number, price = 777, volume = 5, tx = 'ab'.repeat(32)): RawLog => ({ topics: [TOPICS.clear, CLEAR_MARKET, '0x' + epoch.toString(16).padStart(64, '0')], data: '0x' + [price, volume, 1, 1, 0].map((n) => n.toString(16).padStart(64, '0')).join(''), blockNumber: '0x' + block.toString(16), transactionHash: '0x' + tx, logIndex: '0x0' });
const strayClear = (block: number): RawLog => rawClear(999999, block);
const ledgerOf = (logs: RawLog[]) => { const l = newLedger(); applyEvents(l, decodeLogs(logs), FAKE_SCHEDULE); return l; };
/** The fixture with one market's trades after block 127960000 removed: its last trade lies far back, so ready must wait for the older chunks. */
const LOGS_OLD_MARKET = (() => {
  const old = FX.logs.find((l) => l.topics[0] === TOPICS.clear && parseInt(l.blockNumber, 16) === 127998270)!.topics[1];
  return FX.logs.filter((l) => !(l.topics[1] === old && parseInt(l.blockNumber, 16) > 127960000));
})();
/** Records every state the store publishes (ready, complete, source, last epochs). */
function watch(store: MarketStore) {
  const seen: Array<{ ready: boolean; complete: boolean; source: string; last: number[] }> = [];
  store.subscribe(() => { const s = store.getState(); seen.push({ ready: s.ready, complete: s.historyComplete, source: s.source, last: s.markets.map((m) => m.lastEpoch) }); });
  return seen;
}

test('chain path: newest-first backfill ends with exactly the one-pass ledger; ready and complete flip; source rpc', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    const s = store.getState();
    assert.equal(s.ready, true); assert.equal(s.source, 'rpc'); assert.equal(s.error, undefined);
    assert.deepEqual(s.clears, clearPoints(FULL));
    assert.deepEqual(s.fills, fillRows(FULL, FAKE_SCHEDULE));
    assert.equal(s.markets[0].last, 1113); assert.equal(s.markets[0].lastEpoch, 1139);
    assert.equal(store.getBook(s.markets[0].marketId, 1136)?.orders.length, 5);
    assert.ok(rpc.calls.filter((c) => c === 'eth_getLogs').length >= 18, 'one request per 3000-block chunk');
    // the views other components read keep their shape
    const live = liveBooks(FULL);
    for (const [id, b] of Object.entries(live)) { assert.equal(s.live[id].epoch, b.epoch); assert.deepEqual(s.live[id].orders.map((o) => o.index), b.orders.map((o) => o.index)); }
    assert.equal(store.booksSince(0).length, FULL.books.size);
    assert.equal(store.windowFrom(), hotFrom(FULL.books.values()));
  } finally { store.stop(); await rpc.close(); }
});

test('snapshot path: hydrates, loads only the gap after the cursor, same final views; source snapshot', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url, { snapshotUrl: '/api/market/snapshot', fetch: (async () => json(snapUpTo(127999000))) as typeof fetch }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    const s = store.getState();
    assert.equal(s.source, 'snapshot');
    assert.deepEqual(s.clears, clearPoints(FULL));
    assert.equal(rpc.calls.filter((c) => c === 'eth_getLogs').length, 1, 'gap of 300 blocks = one request');
  } finally { store.stop(); await rpc.close(); }
});

test('an incomplete snapshot is ignored (chain path); a broken snapshot endpoint falls back too', async () => {
  for (const f of [async () => json(snapUpTo(127999000, false)), async () => new Response('<html>', { status: 404, headers: { 'content-type': 'text/html' } }), async () => { throw new TypeError('offline'); }]) {
    const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
    const store = createMarketStore(cfg(rpc.url, { snapshotUrl: '/api/market/snapshot', fetch: f as typeof fetch }));
    try { await store.start(); await until(store, (s) => s.historyComplete); assert.equal(store.getState().source, 'rpc'); assert.deepEqual(store.getState().clears, clearPoints(FULL)); }
    finally { store.stop(); await rpc.close(); }
  }
});

test('cache path: a completed load writes the cache; the next visit starts from it', async () => {
  const kv = memoryKV();
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const a = createMarketStore(cfg(rpc.url, { kv }));
  try { await a.start(); await until(a, (s) => s.historyComplete); await until(a, () => kv.data.size === 1); } finally { a.stop(); }
  rpc.calls.length = 0;
  const b = createMarketStore(cfg(rpc.url, { kv }));
  try {
    await b.start(); await until(b, (s) => s.historyComplete);
    assert.equal(b.getState().source, 'cache');
    assert.deepEqual(b.getState().clears, clearPoints(FULL));
    assert.equal(rpc.calls.filter((c) => c === 'eth_getLogs').length, 1, 'the cache is written TRAIL_BLOCKS behind the tip, so the next visit re-reads that window (one request)');
  } finally { b.stop(); await rpc.close(); }
});

test('throttled getLogs is retried with backoff and the load still completes', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD, failGetLogs: 2 });
  const store = createMarketStore(cfg(rpc.url, { logChunk: 30000 }));
  try { await store.start(); await until(store, (s) => s.historyComplete, 15000); assert.deepEqual(store.getState().clears, clearPoints(FULL)); }
  finally { store.stop(); await rpc.close(); }
});

test('newest chunk first; after a snapshot only blocks above its cursor are requested and applied, and the gap is always filled up to the head', async () => {
  const CUR = 127990000; // a complete snapshot 9300 blocks behind the head: complete does not mean cursor === head
  for (const [name, over, first] of [['chain', {}, DEPLOY], ['snapshot', { snapshotUrl: '/s', fetch: (async () => json(snapUpTo(CUR))) as typeof fetch }, CUR + 1]] as const) {
    const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
    const px = await startProxy(rpc.url, { noise: (from) => [strayClear(from - 1)] }); // every answer also carries an event below the requested range
    const store = createMarketStore(cfg(px.url, over)); const seen = watch(store);
    try {
      await store.start(); await until(store, (s) => s.historyComplete);
      const s = store.getState();
      assert.equal(s.source, name === 'chain' ? 'rpc' : 'snapshot', name);
      assert.deepEqual(s.clears, clearPoints(FULL), name + ': nothing outside the requested ranges entered the ledger');
      assert.equal(px.ranges[0][1], HEAD, name + ': the first request is the newest chunk');
      assert.ok(px.ranges.every(([f, t]) => f >= first && t <= HEAD && t - f < 3000), name + ': ranges stay in (base cursor, head]');
      assert.equal(Math.min(...px.ranges.map((r) => r[0])), first, name + ': the whole gap is covered');
      // ready is only ever shown with final last prices (never from a partial load)
      const final = s.markets.map((m) => m.lastEpoch);
      for (const v of seen) if (v.ready) assert.deepEqual(v.last, final, name + ': a ready state never carries a stale last price');
      assert.ok(seen.some((v) => !v.ready), name + ': not ready from the start');
      assert.ok(seen.some((v) => v.ready && !v.complete), name + ': ready as soon as the newest chunk holds every last price, long before the history is complete');
    } finally { store.stop(); await px.close(); await rpc.close(); }
  }
});

test('ready is withheld while the newest trade of a market may still hide in a chunk that has not arrived', async () => {
  const logs = LOGS_OLD_MARKET;
  const rpc = await startFakeRpc({ logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url)); const seen = watch(store);
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    const final = store.getState().markets.map((m) => m.lastEpoch);
    assert.ok(final.every((e) => e >= 0), 'every market has a traded clear in the end');
    assert.ok(seen.some((v) => !v.ready && !v.complete && v.last.some((e) => e < 0) && v.last.some((e) => e >= 0)), 'the newer markets had prices while the old one had none');
    for (const v of seen) if (v.ready) assert.deepEqual(v.last, final, 'ready only once every last price is final');
    assert.ok(seen.some((v) => v.ready && !v.complete), 'ready came before the whole history was loaded');
  } finally { store.stop(); await rpc.close(); }
});

test('a snapshot whose schedule differs from the on-chain one is discarded and never shown', async () => {
  const other = { ...snapUpTo(127999000), schedule: { ...FAKE_SCHEDULE, bond: FAKE_SCHEDULE.bond + 1 } };
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url, { snapshotUrl: '/s', fetch: (async () => json(other)) as typeof fetch })); const seen = watch(store);
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    assert.equal(store.getState().source, 'rpc'); assert.deepEqual(store.getState().clears, clearPoints(FULL));
    assert.ok(seen.every((v) => v.source === 'rpc'), 'no state ever came from the mismatching snapshot');
    assert.ok(rpc.calls.filter((c) => c === 'eth_getLogs').length >= 18, 'the chain was read from the deployment');
  } finally { store.stop(); await rpc.close(); }
  // ...and the next candidate is used instead: a valid cache behind a mismatching server snapshot
  const kv = memoryKV(); await writeCache(kv, ID, snapUpTo(127999000), Date.now());
  const rpc2 = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const s2 = createMarketStore(cfg(rpc2.url, { kv, snapshotUrl: '/s', fetch: (async () => json({ ...other, cursor: 127999100, head: 127999100 })) as typeof fetch }));
  try {
    await s2.start(); await until(s2, (s) => s.historyComplete);
    assert.equal(s2.getState().source, 'cache'); assert.deepEqual(s2.getState().clears, clearPoints(FULL));
    assert.equal(rpc2.calls.filter((c) => c === 'eth_getLogs').length, 1);
  } finally { s2.stop(); await rpc2.close(); }
});

test('the cache entry the store writes is accepted by the validator, from the chain path and from a snapshot base', async () => {
  for (const over of [{}, { snapshotUrl: '/s', fetch: (async () => json(snapUpTo(127999000))) as typeof fetch }]) {
    const kv = memoryKV(); const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
    const store = createMarketStore(cfg(rpc.url, { kv, ...over }));
    try {
      await store.start(); await until(store, (s) => s.historyComplete); await until(store, () => kv.data.size === 1);
      const snap = await readCache(kv, ID, Date.now());
      assert.ok(snap, 'validateSnapshot accepts our own entry'); assert.equal(snap!.cursor, HEAD - TRAIL_BLOCKS, 'cursor is TRAIL_BLOCKS behind the applied tip'); assert.equal(snap!.complete, true);
    } finally { store.stop(); await rpc.close(); }
  }
});

test('the cache is written off the hot path: ready and complete are published before the (slow) write finishes', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); const kv = memoryKV(); const set = kv.set;
  kv.set = async (k, v) => { await gate; return set(k, v); };
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url, { kv }));
  try { await store.start(); await until(store, (s) => s.historyComplete); assert.equal(store.getState().ready, true); assert.equal(kv.data.size, 0); release(); await until(store, () => kv.data.size === 1); }
  finally { release(); store.stop(); await rpc.close(); }
});

test('a hanging IndexedDB neither delays the chain requests nor stalls the load', async () => {
  const hang: KV = { get: () => new Promise(() => {}), set: () => new Promise(() => {}), del: () => new Promise(() => {}) };
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url, { kv: hang }));
  const t = Date.now(); const started = store.start();
  try {
    await until(store, () => rpc.calls.includes('eth_blockNumber'), 300); // asked for the head while the cache read is still pending
    await started; await until(store, (s) => s.historyComplete, 4000);
    assert.equal(store.getState().source, 'rpc'); assert.deepEqual(store.getState().clears, clearPoints(FULL));
    assert.ok(Date.now() - t < 3500, 'bounded by the cache read timeout, not by IndexedDB');
  } finally { store.stop(); await rpc.close(); }
});

test('a snapshot endpoint that never answers is given up on after a bounded wait', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url, { snapshotUrl: '/s', fetch: (() => new Promise(() => {})) as unknown as typeof fetch }));
  const t = Date.now();
  try { await store.start(); await until(store, (s) => s.historyComplete, 4000); assert.equal(store.getState().source, 'rpc'); assert.ok(Date.now() - t < 3500); }
  finally { store.stop(); await rpc.close(); }
});

test('failed ranges are retried; a persistent failure surfaces an error without an unhandled rejection, and the next ticks recover', async () => {
  const unhandled: unknown[] = []; const on = (e: unknown) => { unhandled.push(e); }; process.on('unhandledRejection', on);
  let healed = false;
  const rpc = await startFakeRpc({ logs: LOGS_OLD_MARKET, head: HEAD });
  const px = await startProxy(rpc.url, { fail: (m, from) => m === 'eth_getLogs' && !healed && from < 127970000 }); // only the older ranges fail
  const store = createMarketStore(cfg(px.url, { pollMs: 150, retryWaitsMs: [0, 5] })); const seen = watch(store);
  try {
    await store.start(); await until(store, (s) => !!s.historyError);
    assert.equal(store.getState().error, undefined, 'data is loaded: no error banner for old history');
    assert.equal(store.getState().historyComplete, false);
    assert.equal(store.getState().ready, false, 'a partial load with a failed range is not published as ready');
    assert.ok(Object.keys(store.getState().clears).length > 0, 'the newest chunks did load');
    await new Promise((r) => setTimeout(r, 100)); const before = px.ranges.length; await new Promise((r) => setTimeout(r, 600));
    assert.equal(px.ranges.length, before, 'a failed run is not retried on every poll: the pause between runs grows');
    healed = true;
    await until(store, (s) => s.historyComplete && !s.historyError, 8000);
    const whole = newLedger(); applyEvents(whole, decodeLogs(LOGS_OLD_MARKET), FAKE_SCHEDULE);
    assert.deepEqual(store.getState().clears, clearPoints(whole));
    const final = store.getState().markets.map((m) => m.lastEpoch);
    for (const v of seen) if (v.ready) assert.deepEqual(v.last, final, 'ready was never published with a stale or partial last price');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', on); store.stop(); await px.close(); await rpc.close(); }
});

test('nothing loaded at all: a non-fatal error state, then the store initialises once the chain answers (hydrating the snapshot on a fresh ledger)', async () => {
  let down = true;
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url, { fail: () => down });
  const store = createMarketStore(cfg(px.url, { pollMs: 150, retryWaitsMs: [0, 5], snapshotUrl: '/s', fetch: (async () => json(snapUpTo(127999000))) as typeof fetch })); const seen = watch(store);
  try {
    await store.start();
    assert.ok(store.getState().error); assert.equal(store.getState().ready, true, 'error state: nothing to wait for'); assert.equal(store.getState().historyComplete, false);
    assert.equal(Object.keys(store.getState().clears).length, 0);
    down = false;
    await until(store, (s) => s.historyComplete && !s.error, 8000);
    assert.equal(store.getState().source, 'snapshot'); assert.deepEqual(store.getState().clears, clearPoints(FULL));
    const final = store.getState().markets.map((m) => m.lastEpoch);
    for (const v of seen) if (v.ready && v.last.some((e) => e >= 0)) assert.deepEqual(v.last, final, 'ready never accompanies a non-final last price');
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('a failed start with NO snapshot (RPC down at page load): clock and history both appear once the RPC answers; ready flips true; no permanent error', async () => {
  let down = true;
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url, { fail: () => down });
  const store = createMarketStore(cfg(px.url, { pollMs: 100, retryWaitsMs: [0, 5] }));
  try {
    await store.start();
    assert.ok(store.getState().error, 'the failed start shows an error'); assert.equal(store.getState().schedule, undefined, 'no clock yet');
    assert.equal(Object.keys(store.getState().clears).length, 0);
    down = false;
    await until(store, (s) => s.historyComplete && !s.error, 8000);
    const s = store.getState();
    assert.ok(s.schedule, 'the clock came back'); assert.equal(s.ready, true); assert.equal(s.source, 'rpc');
    assert.deepEqual(s.clears, clearPoints(FULL));
    assert.equal(s.error, undefined, 'no false permanent error'); assert.ok(s.lastBlock >= HEAD);
    await new Promise((r) => setTimeout(r, 400)); assert.equal(store.getState().error, undefined, 'and it stays clean while polling');
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('polling folds new blocks in bounded chunks after a long gap (a sleeping tab), without re-reading history', async () => {
  const rpc = await startFakeRpc({ logs: [...FX.logs, strayClear(HEAD + 100)], head: HEAD });
  const px = await startProxy(rpc.url);
  const store = createMarketStore(cfg(px.url, { pollMs: 50 }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    const marketId = CLEAR_MARKET; const n = px.ranges.length;
    assert.equal(store.getState().clears[marketId].some((c) => c.epoch === 999999), false);
    rpc.setHead(HEAD + 7000);
    await until(store, (s) => s.lastBlock === HEAD + 7000 && !!s.clears[marketId].some((c) => c.epoch === 999999));
    const polled = px.ranges.slice(n);
    assert.ok(polled.length >= 3 && polled.every(([f, t]) => f >= HEAD + 1 - TRAIL_BLOCKS && t - f < 3000 && t <= HEAD + 7000), 'only the trailing window and new blocks, in chunks');
    const covered = new Set<number>(); for (const [f, t] of polled) for (let b = f; b <= t; b += 1) covered.add(b);
    for (let b = HEAD + 1; b <= HEAD + 7000; b += 1) if (!covered.has(b)) assert.fail('block ' + b + ' was never read');
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('stop() ends the backfill: no further requests are made', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD, delayMs: 25 });
  const store = createMarketStore(cfg(rpc.url));
  await store.start(); await new Promise((r) => setTimeout(r, 120)); store.stop();
  await new Promise((r) => setTimeout(r, 150)); const n = rpc.calls.length;
  await new Promise((r) => setTimeout(r, 300)); assert.equal(rpc.calls.length, n); assert.equal(store.getState().historyComplete, false);
  await rpc.close();
});

// lagging getLogs node, silent history errors, base wait, retries, clock, hydrate fallback

test('a getLogs node that lags behind the head leaves no permanent gap, and the cache never persists one', async () => {
  const withStray = [...FX.logs, strayClear(HEAD + 100)];
  const EXPECT = ledgerOf(withStray);
  const kv = memoryKV();
  const rpc = await startFakeRpc({ logs: withStray, head: HEAD, lagLogs: 50 }); // getBlockNumber says HEAD, getLogs only answers up to HEAD - 50
  const a = createMarketStore(cfg(rpc.url, { kv, pollMs: 50 }));
  try {
    await a.start(); await until(a, (s) => s.historyComplete); await until(a, () => kv.data.size === 1);
    const snap = await readCache(kv, ID, Date.now());
    assert.ok(snap, 'valid entry'); assert.ok(snap!.cursor <= HEAD - TRAIL_BLOCKS, 'cache cursor at least TRAIL_BLOCKS behind the applied tip: ' + snap!.cursor);
    rpc.setHead(HEAD + 120); await until(a, (s) => s.lastBlock === HEAD + 120);
    rpc.setHead(HEAD + 5000);
    await until(a, (s) => s.lastBlock === HEAD + 5000 && !!s.clears[CLEAR_MARKET]?.some((c) => c.epoch === 999999));
    assert.deepEqual(a.getState().clears, clearPoints(EXPECT), 'events the lagging node hid at first (blocks HEAD-49..HEAD) arrived through the trailing re-read');
    assert.deepEqual(a.getState().fills, fillRows(EXPECT, FAKE_SCHEDULE));
  } finally { a.stop(); }
  rpc.setLag(0);
  const b = createMarketStore(cfg(rpc.url, { kv }));
  try { await b.start(); await until(b, (s) => s.historyComplete); assert.equal(b.getState().source, 'cache'); assert.deepEqual(b.getState().clears, clearPoints(EXPECT), 'the next visit starts from the cache and misses nothing'); }
  finally { b.stop(); await rpc.close(); }
});

test('a failed range of OLD history never puts the page into an error state once data is loaded; it retries silently and recovers', async () => {
  let fails = 0;
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url, { fail: (m, from) => m === 'eth_getLogs' && from < 127750000 && fails++ < 1 });
  const store = createMarketStore(cfg(px.url, { pollMs: 100, retryWaitsMs: [0] })); const states: Array<{ ready: boolean; error?: string; historyError?: string }> = [];
  store.subscribe(() => { const s = store.getState(); states.push({ ready: s.ready, error: s.error, historyError: s.historyError }); });
  try {
    await store.start(); await until(store, (s) => !!s.historyError, 10000);
    assert.equal(store.getState().ready, true); assert.equal(store.getState().error, undefined);
    await until(store, (s) => s.historyComplete, 10000);
    assert.ok(states.every((s) => !(s.ready && s.error)), 'no emitted state is ready with an error');
    assert.equal(store.getState().historyError, undefined, 'cleared once the backfill recovered');
    assert.deepEqual(store.getState().clears, clearPoints(FULL));
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('the snapshot gets its full timeout: one answering at about 2 s is used, one answering at 3 s is abandoned', async () => {
  for (const [delay, source, minLogs] of [[2000, 'snapshot', 1], [3000, 'rpc', 18]] as const) {
    const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
    const store = createMarketStore(cfg(rpc.url, { snapshotUrl: '/s', fetch: (async () => { await sleep(delay); return json(snapUpTo(127999000)); }) as typeof fetch }));
    try {
      await store.start(); await until(store, (s) => s.historyComplete, 8000);
      assert.equal(store.getState().source, source, 'answer after ' + delay + ' ms'); assert.deepEqual(store.getState().clears, clearPoints(FULL));
      const logs = rpc.calls.filter((c) => c === 'eth_getLogs').length; assert.ok(source === 'snapshot' ? logs === minLogs : logs >= minLogs, 'getLogs calls: ' + logs);
    } finally { store.stop(); await rpc.close(); }
  }
});

test('the store owns retries: one failing logical request costs exactly its own attempts (no multiplication by the HTTP client)', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url, { fail: (m) => m === 'eth_getLogs', failCode: -32005 }); // a code viem would retry on its own
  const store = createMarketStore(cfg(px.url, { deployBlock: HEAD - 2000, logChunk: 5000, retryWaitsMs: [0, 5] }));
  try { await store.start(); await until(store, (s) => !!s.error); await sleep(100); assert.equal(px.ranges.length, 2, 'two attempts of the one range, nothing more'); }
  finally { store.stop(); await px.close(); await rpc.close(); }
});

test('the chain clock advances before a long catch-up starts (no false chain-stalled banner for a sleeping tab)', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url, { delayLogsMs: 60 });
  const store = createMarketStore(cfg(px.url, { pollMs: 50 }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    const before = px.ranges.length; let atClock = -1;
    store.subscribe(() => { if (atClock < 0 && store.getState().lastBlock === HEAD + 20000) atClock = px.ranges.length; });
    rpc.setHead(HEAD + 20000);
    await until(store, (s) => s.lastBlock === HEAD + 20000, 2000);
    assert.equal(atClock, before, 'lastBlock moved before the first catch-up request');
    assert.ok(store.getState().lastBlockTime > 0);
    await until(store, () => px.ranges.length - before >= 7, 4000); // 20000 blocks + window in 3000-block chunks
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('a base that cannot be hydrated is skipped: the other candidate is tried before a full chain load', async () => {
  const kv = memoryKV(); await writeCache(kv, ID, snapUpTo(127999000), Date.now());
  const server = snapUpTo(127999100);
  const boom = (l: any, snap: any) => { if (snap.cursor === 127999100) throw new Error('bad snapshot'); return hydrateReal(l, snap); };
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const s1 = createMarketStore(cfg(rpc.url, { kv, snapshotUrl: '/s', fetch: (async () => json(server)) as typeof fetch, hydrateSnapshot: boom }));
  try { await s1.start(); await until(s1, (s) => s.historyComplete); assert.equal(s1.getState().source, 'cache'); assert.deepEqual(s1.getState().clears, clearPoints(FULL)); assert.equal(rpc.calls.filter((c) => c === 'eth_getLogs').length, 1); }
  finally { s1.stop(); }
  rpc.calls.length = 0;
  const s2 = createMarketStore(cfg(rpc.url, { kv, snapshotUrl: '/s', fetch: (async () => json(server)) as typeof fetch, hydrateSnapshot: () => { throw new Error('nothing hydrates'); } }));
  try { await s2.start(); await until(s2, (s) => s.historyComplete); assert.equal(s2.getState().source, 'rpc'); assert.deepEqual(s2.getState().clears, clearPoints(FULL)); assert.ok(rpc.calls.filter((c) => c === 'eth_getLogs').length >= 18); }
  finally { s2.stop(); await rpc.close(); }
});

test('a poll that runs while the backfill is in flight loses nothing and applies nothing twice', async () => {
  const withStray = [...FX.logs, strayClear(HEAD + 10)]; const EXPECT = ledgerOf(withStray);
  const rpc = await startFakeRpc({ logs: withStray, head: HEAD });
  const px = await startProxy(rpc.url, { delayLogsMs: 30 });
  const store = createMarketStore(cfg(px.url, { pollMs: 30 }));
  try {
    await store.start(); rpc.setHead(HEAD + 30);
    await until(store, (s) => s.historyComplete && !!s.clears[CLEAR_MARKET]?.some((c) => c.epoch === 999999));
    assert.equal(store.getState().clears[CLEAR_MARKET].filter((c) => c.epoch === 999999).length, 1);
    assert.deepEqual(store.getState().clears, clearPoints(EXPECT)); assert.deepEqual(store.getState().fills, fillRows(EXPECT, FAKE_SCHEDULE));
    assert.equal(store.booksSince(0).length, EXPECT.books.size);
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('a lower head neither fetches nor moves the cursor or the clock back', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url);
  const store = createMarketStore(cfg(px.url, { pollMs: 40 }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete); await until(store, (s) => s.lastBlock === HEAD);
    const n = px.ranges.length; rpc.setHead(HEAD - 10); await sleep(250);
    assert.equal(px.ranges.length, n, 'no request for a lower head'); assert.equal(store.getState().lastBlock, HEAD, 'the clock does not go back');
    rpc.setHead(HEAD + 5); await until(store, (s) => s.lastBlock === HEAD + 5); await until(store, () => px.ranges.length > n);
    assert.deepEqual(px.ranges[n], [HEAD + 1 - TRAIL_BLOCKS, HEAD + 5], 'continues from the unchanged cursor, re-reading the window');
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('a snapshot whose cursor is ahead of our head (within the tolerance) needs no request; polling waits and never goes below that cursor', async () => {
  const AHEAD = HEAD + 30; const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url);
  const store = createMarketStore(cfg(px.url, { pollMs: 40, snapshotUrl: '/s', fetch: (async () => json(snapUpTo(AHEAD))) as typeof fetch }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    assert.equal(store.getState().source, 'snapshot'); assert.equal(store.getState().ready, true);
    await sleep(250); assert.equal(px.ranges.length, 0, 'nothing requested while the head is behind the snapshot');
    rpc.setHead(HEAD + 100); await until(store, () => px.ranges.length > 0);
    assert.deepEqual(px.ranges[0], [AHEAD + 1, HEAD + 100], 'the trailing window stops at the base cursor');
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('a snapshot with aggregated points: the cache the store writes gives the next visit the same views', async () => {
  const CUR = 127990000;
  const synth = Array.from({ length: 700 }, (_, i) => rawClear(100 + i, 127700000 + i, 1000 + (i % 50), 1 + (i % 3), (100 + i).toString(16).padStart(64, '0')));
  const l = newLedger(); applyEvents(l, decodeLogs([...synth, ...FX.logs.filter((x) => parseInt(x.blockNumber, 16) <= CUR)]), FAKE_SCHEDULE);
  const snap = buildSnapshot(l, { ...ID, cursor: CUR, head: CUR, headTime: 1, builtAt: 1, complete: true }, FAKE_SCHEDULE);
  assert.ok(Object.values(snap.cold).some((list) => list.some((c) => (c.n ?? 1) > 1)), 'the snapshot carries folded points');
  const kv = memoryKV(); const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const views = (s: ReturnType<MarketStore['getState']>) => ({ clears: s.clears, markets: s.markets, fills: s.fills, live: s.live });
  const a = createMarketStore(cfg(rpc.url, { kv, snapshotUrl: '/s', fetch: (async () => json(snap)) as typeof fetch })); let first: ReturnType<typeof views>;
  try { await a.start(); await until(a, (s) => s.historyComplete); await until(a, () => kv.data.size === 1); first = views(a.getState()); assert.equal(a.getState().source, 'snapshot'); } finally { a.stop(); }
  const b = createMarketStore(cfg(rpc.url, { kv }));
  try { await b.start(); await until(b, (s) => s.historyComplete); assert.equal(b.getState().source, 'cache'); assert.deepEqual(views(b.getState()), first); } finally { b.stop(); await rpc.close(); }
});

test('one throttled head read in a poll after ready is retried by the store and never reaches the page as an error', async () => {
  let armed = false, hits = 0;
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url, { fail: (m) => m === 'eth_getBlockByNumber' && armed && hits++ < 1, failCode: -32005 });
  const store = createMarketStore(cfg(px.url, { pollMs: 50, retryWaitsMs: [0, 5] })); const bad: string[] = [];
  store.subscribe(() => { const s = store.getState(); if (s.ready && s.error) bad.push(s.error); });
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    armed = true; await until(store, () => hits >= 1, 2000); await sleep(300);
    assert.equal(bad.length, 0, 'no state is ready with an error: ' + bad[0]);
    rpc.setHead(HEAD + 3); await until(store, (s) => s.lastBlock === HEAD + 3);
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

test('a poll error is published only after two consecutive failed polls, and the next good poll clears it', async () => {
  let armed = false, fails = 0;
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const px = await startProxy(rpc.url, { fail: (m) => m === 'eth_getBlockByNumber' && armed && (fails++, true) });
  const store = createMarketStore(cfg(px.url, { pollMs: 30, retryWaitsMs: [0] })); const seen: Array<{ error?: string; fails: number }> = [];
  store.subscribe(() => seen.push({ error: store.getState().error, fails }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    armed = true; await until(store, (s) => !!s.error, 3000);
    assert.ok(fails >= 2, 'published after at least two failed polls (' + fails + ')');
    assert.ok(seen.filter((v) => v.error).every((v) => v.fails >= 2), 'never after the first failure alone');
    armed = false; await until(store, (s) => !s.error, 3000);
  } finally { store.stop(); await px.close(); await rpc.close(); }
});

// traders and snapshotHead (wallet labels and the "stored copy + live" chip)

test('traders: the chain path ends with the one-pass order of first orders; snapshotHead stays unset when the chain was the only source', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url));
  try {
    assert.deepEqual(store.getState().traders, []); assert.equal(store.getState().snapshotHead, undefined);
    await store.start(); await until(store, (s) => s.historyComplete);
    const s = store.getState();
    assert.deepEqual(s.traders, traderOrder(FULL));
    assert.ok(s.traders.length >= 5); assert.equal(s.snapshotHead, undefined);
  } finally { store.stop(); await rpc.close(); }
});

test('traders and snapshotHead: server snapshot base -> its cursor; the hot books give every wallet in the same order', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url, { snapshotUrl: '/api/market/snapshot', fetch: (async () => json(snapUpTo(127999000))) as typeof fetch }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    const s = store.getState();
    assert.equal(s.source, 'snapshot'); assert.equal(s.snapshotHead, 127999000);
    assert.deepEqual(s.traders, traderOrder(FULL));
  } finally { store.stop(); await rpc.close(); }
});

test('traders and snapshotHead: cache base -> the cached cursor (TRAIL_BLOCKS behind the tip); a later wallet keeps its place', async () => {
  const kv = memoryKV();
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const a = createMarketStore(cfg(rpc.url, { kv }));
  try { await a.start(); await until(a, (s) => s.historyComplete); await until(a, () => kv.data.size === 1); assert.equal(a.getState().snapshotHead, undefined); } finally { a.stop(); }
  const b = createMarketStore(cfg(rpc.url, { kv }));
  try {
    await b.start(); await until(b, (s) => s.historyComplete);
    const s = b.getState();
    assert.equal(s.source, 'cache'); assert.equal(s.snapshotHead, HEAD - TRAIL_BLOCKS, 'the cache is written TRAIL_BLOCKS behind the applied tip');
    assert.deepEqual(s.traders, traderOrder(FULL));
  } finally { b.stop(); await rpc.close(); }
});
