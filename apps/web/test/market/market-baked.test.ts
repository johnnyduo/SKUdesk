// node --test test/market/market-baked.test.ts   (from apps/web)
// The build-time baked history (src/data/blindbook-history.json, written by tools/market-snapshot.ts) as the cold fallback base of the
// store, and the RPC's 10,000-log cap (ranges are split, not retried).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEvents, clearPoints, decodeLogs, newLedger, traderOrder, type RawLog } from '../../src/lib/market-core.ts';
import { buildSnapshot, hydrate, validateSnapshot } from '../../src/lib/market-snap.ts';
import { memoryKV, writeCache } from '../../src/lib/market-cache.ts';
import { bakedSnapshot, type HistorySnapshot } from '../../src/lib/market-baked.ts';
import { createMarketStore, type MarketConfig, type MarketStore } from '../../src/lib/market.ts';
import { FAKE_SCHEDULE, startFakeRpc } from './helpers/fake-rpc.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
// the six markets of the book the fixture logs were captured from (the first BlindBook, 2026-10-03): the Accessories entries of the catalog
const CATALOG = (JSON.parse(readFileSync(new URL('../../src/data/catalog.json', import.meta.url), 'utf8')).markets as { category: string }[]).filter((m) => m.category === 'Accessories');
const BOOK = '0x2BA62631d74827aBF2f7467B20370dC2DC59aa11';
const DEPLOY = 127690064, HEAD = 127999300;
const ID = { chainId: 46630, book: BOOK.toLowerCase(), deployBlock: DEPLOY };
const FULL = (() => { const l = newLedger(); applyEvents(l, decodeLogs(FX.logs), FAKE_SCHEDULE); return l; })();
const NAME = { commit: 'Committed', reveal: 'Revealed', fill: 'Fill', clear: 'EpochCleared' } as const;
const blockOf = (l: RawLog) => parseInt(l.blockNumber, 16);

/** The fixture in the format tools/market-snapshot.ts writes: viem-decoded args, bigints as decimal strings, side a number, checksum-cased trader. */
function toBaked(head: number, over: Partial<HistorySnapshot> = {}): HistorySnapshot {
  const events = decodeLogs(FX.logs.filter((l) => blockOf(l) <= head)).map((e) => {
    const a: Record<string, any> = { market: e.market, epoch: String(e.epoch) };
    if (e.kind === 'clear') Object.assign(a, { price: String(e.price), volume: String(e.volume), buys: String(e.buys), sells: String(e.sells), forfeited: String(e.forfeited) });
    else {
      Object.assign(a, { trader: '0x' + e.trader.slice(2).toUpperCase(), index: String(e.index) });
      if (e.kind === 'commit') a.hash = e.hash; else Object.assign(a, { side: e.side, price: String(e.price), units: String(e.units) });
    }
    return { e: NAME[e.kind], b: e.block, i: e.logIndex, t: e.tx, a };
  });
  return { chainId: 46630, book: BOOK, head, events, ...over };
}
const ledgerUpTo = (head: number) => { const l = newLedger(); applyEvents(l, decodeLogs(FX.logs.filter((x) => blockOf(x) <= head)), FAKE_SCHEDULE); return l; };
const cfg = (rpc: string, over: Partial<MarketConfig> = {}): MarketConfig => ({ chain: { id: 46630, name: 'test', rpc, explorer: '' }, book: BOOK as `0x${string}`, deployBlock: DEPLOY, catalog: CATALOG, pollMs: 600_000, logChunk: 3000, snapshotUrl: null, ...over });
async function until(store: MarketStore, pred: (s: ReturnType<MarketStore['getState']>) => boolean, ms = 8000) {
  const t = Date.now(); while (Date.now() - t < ms) { if (pred(store.getState())) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout; state: ' + JSON.stringify({ ready: store.getState().ready, complete: store.getState().historyComplete, error: store.getState().error }));
}

// the conversion (pure)

test('bakedSnapshot: the baked events go through the log decoder into a validated, complete base whose cursor is the baked head', () => {
  const H0 = 127990000;
  const snap = bakedSnapshot(toBaked(H0), ID, FAKE_SCHEDULE, 5);
  assert.ok(snap);
  assert.equal(snap!.cursor, H0); assert.equal(snap!.head, H0); assert.equal(snap!.complete, true); assert.deepEqual(snap!.schedule, FAKE_SCHEDULE);
  assert.deepEqual(validateSnapshot(snap, ID), snap, 'the same validator as the server snapshot and the cache accepts it unchanged');
  const l = newLedger(); hydrate(l, snap!);
  assert.deepEqual(clearPoints(l), clearPoints(ledgerUpTo(H0)), 'same clears as folding the raw chain logs up to the baked head');
  assert.deepEqual(snap, buildSnapshot(ledgerUpTo(H0), { ...ID, cursor: H0, head: H0, headTime: 0, builtAt: 5, complete: true }, FAKE_SCHEDULE), 'identical to a snapshot of the chain-built ledger');
});

test('bakedSnapshot: used only when chainId and book match (book compared case-insensitively)', () => {
  assert.ok(bakedSnapshot(toBaked(HEAD), ID, FAKE_SCHEDULE, 1));
  assert.ok(bakedSnapshot(toBaked(HEAD, { book: BOOK.toLowerCase() }), ID, FAKE_SCHEDULE, 1));
  assert.ok(bakedSnapshot(toBaked(HEAD, { book: '0x' + BOOK.slice(2).toUpperCase() }), ID, FAKE_SCHEDULE, 1));
  assert.equal(bakedSnapshot(toBaked(HEAD, { chainId: 1 }), ID, FAKE_SCHEDULE, 1), null, 'another chain');
  assert.equal(bakedSnapshot(toBaked(HEAD, { book: '0x' + '1'.repeat(40) }), ID, FAKE_SCHEDULE, 1), null, 'another contract');
});

test('bakedSnapshot: a malformed baked file is rejected (null) and never throws', () => {
  const good = toBaked(HEAD);
  const ev = (i: number, patch: (e: any) => void) => { const c = structuredClone(good) as any; patch(c.events[i]); return c; };
  const clearAt = good.events.findIndex((e) => e.e === 'EpochCleared'); const fillAt = good.events.findIndex((e) => e.e === 'Fill'); const commitAt = good.events.findIndex((e) => e.e === 'Committed');
  const bad: Array<[string, unknown]> = [
    ['null', null], ['string', 'x'], ['array', []], ['empty object', {}],
    ['events not a list', { ...good, events: 'x' }], ['head missing', { ...good, head: undefined }], ['head fractional', { ...good, head: 1.5 }],
    ['head before the deployment', { ...good, head: DEPLOY - 1 }], ['chainId a string', { ...good, chainId: '46630' }], ['book not a string', { ...good, book: 7 }],
    ['event above the head', { ...good, head: HEAD - 1000 }], ['event below the deployment', ev(0, (e) => { e.b = DEPLOY - 1; })],
    ['event null', { ...good, events: [null, ...good.events] }], ['unknown event name', ev(0, (e) => { e.e = 'MarketListed'; })],
    ['bad tx hash', ev(0, (e) => { e.t = '0x1234'; })], ['bad market id', ev(clearAt, (e) => { e.a.market = '0xabc'; })],
    ['epoch not a number', ev(clearAt, (e) => { e.a.epoch = 'abc'; })], ['negative epoch', ev(clearAt, (e) => { e.a.epoch = '-1'; })],
    ['price over 2^52', ev(clearAt, (e) => { e.a.price = String(2n ** 60n); })], ['price a float', ev(clearAt, (e) => { e.a.price = 1.5; })],
    ['missing volume', ev(clearAt, (e) => { delete e.a.volume; })], ['side 2', ev(fillAt, (e) => { e.a.side = 2; })],
    ['trader not an address', ev(fillAt, (e) => { e.a.trader = 'bob'; })], ['commit hash too short', ev(commitAt, (e) => { e.a.hash = '0x12'; })],
    ['args not an object', ev(0, (e) => { e.a = 'x'; })], ['logIndex negative', ev(0, (e) => { e.i = -1; })], ['block a string', ev(0, (e) => { e.b = String(e.b); })],
  ];
  for (const [name, x] of bad) {
    let out: unknown = 'threw';
    assert.doesNotThrow(() => { out = bakedSnapshot(x, ID, FAKE_SCHEDULE, 1); }, name);
    assert.equal(out, null, name);
  }
  assert.ok(bakedSnapshot(good, ID, FAKE_SCHEDULE, 1), 'the unmodified file still passes (the cases above each break one thing)');
});

// the store

test('store: a baked base is hydrated and only blocks after its head are requested; source baked; same final views', async () => {
  const H0 = 127990000;
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  let loads = 0;
  const store = createMarketStore(cfg(rpc.url, { loadSnapshot: async () => { loads++; return toBaked(H0); } }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    const s = store.getState();
    assert.equal(s.source, 'baked'); assert.equal(s.error, undefined); assert.equal(loads, 1);
    assert.equal(s.snapshotHead, H0, 'the baked head is the last block the stored copy covers');
    assert.deepEqual(s.traders, traderOrder(FULL), 'wallet order is the same as from one pass over the chain');
    assert.deepEqual(s.clears, clearPoints(FULL));
    assert.ok(rpc.logRanges.length >= 1);
    assert.equal(Math.min(...rpc.logRanges.map((r: number[]) => r[0])), H0 + 1, 'the first block asked for is head + 1');
    assert.ok(rpc.logRanges.every(([f, t]: number[]) => f > H0 && t <= HEAD), 'nothing at or below the baked head is requested');
  } finally { store.stop(); await rpc.close(); }
});

test('store: the synchronous `snapshot` config works the same way', async () => {
  const H0 = 127995000;
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const store = createMarketStore(cfg(rpc.url, { snapshot: toBaked(H0) }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete);
    assert.equal(store.getState().source, 'baked'); assert.deepEqual(store.getState().clears, clearPoints(FULL));
    assert.ok(rpc.logRanges.every(([f]: number[]) => f > H0));
  } finally { store.stop(); await rpc.close(); }
});

test('store: a failing loadSnapshot, a baked file of another book or chain, or a malformed one: chain load from the deployment, no error', async () => {
  const cases: Array<[string, Partial<MarketConfig>]> = [
    ['rejects', { loadSnapshot: async () => { throw new Error('chunk failed to load'); } }],
    ['other book', { loadSnapshot: async () => toBaked(127990000, { book: '0x' + '2'.repeat(40) }) }],
    ['other chain', { loadSnapshot: async () => toBaked(127990000, { chainId: 1 }) }],
    ['malformed', { loadSnapshot: async () => ({ chainId: 46630, book: BOOK, head: 127990000, events: [{ e: 'Fill', b: 'x' }] }) as any }],
  ];
  for (const [name, over] of cases) {
    const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
    const store = createMarketStore(cfg(rpc.url, over));
    try {
      await store.start(); await until(store, (s) => s.historyComplete);
      const s = store.getState();
      assert.equal(s.source, 'rpc', name); assert.equal(s.error, undefined, name); assert.deepEqual(s.clears, clearPoints(FULL), name);
      assert.equal(Math.min(...rpc.logRanges.map((r: number[]) => r[0])), DEPLOY, name + ': read from the deployment block');
    } finally { store.stop(); await rpc.close(); }
  }
});

test('store: baked vs cache goes through chooseBase (the newer cursor wins)', async () => {
  for (const [cacheAt, bakedAt, want] of [[127999000, 127990000, 'cache'], [127990000, 127999000, 'baked']] as const) {
    const kv = memoryKV(); const l = ledgerUpTo(cacheAt);
    await writeCache(kv, ID, buildSnapshot(l, { ...ID, cursor: cacheAt, head: cacheAt, headTime: 1, builtAt: 1, complete: true }, FAKE_SCHEDULE), Date.now());
    const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
    const store = createMarketStore(cfg(rpc.url, { kv, loadSnapshot: async () => toBaked(bakedAt) }));
    try {
      await store.start(); await until(store, (s) => s.historyComplete);
      assert.equal(store.getState().source, want); assert.deepEqual(store.getState().clears, clearPoints(FULL));
      assert.ok(rpc.logRanges.every(([f]: number[]) => f > Math.max(cacheAt, bakedAt)), want + ': only blocks above the winning cursor');
    } finally { store.stop(); await rpc.close(); }
  }
});

// the RPC's log cap

test('store: a range the RPC refuses for too many logs is split (not retried) and the load completes', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD, maxLogs: 40 });
  const store = createMarketStore(cfg(rpc.url, { logChunk: 30000, retryWaitsMs: [0, 5000] })); // a retry of the refused range would take 5 s: the test would time out
  try {
    await store.start(); await until(store, (s) => s.historyComplete, 4000);
    const s = store.getState();
    assert.equal(s.error, undefined); assert.deepEqual(s.clears, clearPoints(FULL));
    assert.ok(rpc.logRanges.some(([f, t]: number[]) => t - f + 1 < 30000 && t !== HEAD), 'some planned chunk was split');
    const accepted = rpc.logRanges.filter(([f, t]: number[]) => FX.logs.filter((x) => blockOf(x) >= f && blockOf(x) <= t).length <= 40);
    assert.ok(accepted.length > rpc.logRanges.length / 2, 'every refusal led to smaller requests');
  } finally { store.stop(); await rpc.close(); }
});

test('store: other getLogs errors (rate limiting) are retried with backoff on the same range, never split', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD, failGetLogs: 3 });
  const store = createMarketStore(cfg(rpc.url, { logChunk: 30000, retryWaitsMs: [0, 10, 10, 10] }));
  try {
    await store.start(); await until(store, (s) => s.historyComplete, 8000);
    assert.deepEqual(store.getState().clears, clearPoints(FULL));
    for (const [f, t] of rpc.logRanges as number[][]) assert.ok(t - f + 1 === 30000 || f === DEPLOY || t === HEAD, `planned chunk only: ${f}-${t}`);
  } finally { store.stop(); await rpc.close(); }
});
