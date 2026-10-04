// node --test test/market/market-cache.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEvents, decodeLogs, newLedger, type RawLog } from '../../src/lib/market-core.ts';
import { buildSnapshot } from '../../src/lib/market-snap.ts';
import { CACHE_KEY, CACHE_MAX_BYTES, CACHE_TTL_MS, cacheId, indexedDbKV, memoryKV, readCache, writeCache, type KV } from '../../src/lib/market-cache.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
const SCHED = { t0: 1790958692, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2_000_000 };
const ID = { chainId: 46630, book: '0x2ba62631d74827abf2f7467b20370dc2dc59aa11', deployBlock: 127690064 };
const NOW = 1_791_010_000_000;
const SNAP = (() => { const l = newLedger(); applyEvents(l, decodeLogs(FX.logs), SCHED); return buildSnapshot(l, { ...ID, cursor: 127999285, head: 127999285, headTime: 1791009990, builtAt: NOW, complete: true }, SCHED); })();

test('write then read returns the same snapshot; the key carries schema, chain, contract and deployment', async () => {
  const kv = memoryKV();
  assert.equal(await writeCache(kv, ID, SNAP, NOW), true);
  assert.deepEqual(await readCache(kv, ID, NOW + 1000), JSON.parse(JSON.stringify(SNAP)));
  assert.match(JSON.parse(kv.data.get(CACHE_KEY)!).k, /^v1\.1:46630:0x2ba62631d74827abf2f7467b20370dc2dc59aa11:127690064$/);
  assert.equal(cacheId(ID), JSON.parse(kv.data.get(CACHE_KEY)!).k);
});

test('expired, foreign, future-dated, corrupt or invalid entries read as no cache and are deleted', async () => {
  const cases: [string, (kv: ReturnType<typeof memoryKV>) => Promise<void>, number][] = [
    ['expired', async (kv) => { await writeCache(kv, ID, SNAP, NOW); }, NOW + CACHE_TTL_MS + 1],
    ['other deployment', async (kv) => { await writeCache(kv, { ...ID, deployBlock: 1 }, SNAP, NOW); }, NOW],
    ['future dated', async (kv) => { await writeCache(kv, ID, SNAP, NOW + 3_600_000); }, NOW],
    ['corrupt json', async (kv) => { kv.data.set(CACHE_KEY, '{"k":'); }, NOW],
    ['tampered body', async (kv) => { await writeCache(kv, ID, SNAP, NOW); const e = JSON.parse(kv.data.get(CACHE_KEY)!); e.body.hot.books[0].o[0].t = 'x'; kv.data.set(CACHE_KEY, JSON.stringify(e)); }, NOW],
    ['oversize', async (kv) => { kv.data.set(CACHE_KEY, 'x'.repeat(CACHE_MAX_BYTES + 1)); }, NOW],
  ];
  for (const [name, seed, at] of cases) {
    const kv = memoryKV(); await seed(kv);
    assert.equal(await readCache(kv, ID, at), null, name);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(kv.data.has(CACHE_KEY), false, `${name}: entry deleted`);
  }
});

test('storage that throws, rejects, hangs or does not exist never throws and never blocks', async () => {
  const throwing: KV = { get: () => { throw new Error('SecurityError'); }, set: () => { throw new Error('QuotaExceededError'); }, del: () => { throw new Error('x'); } };
  const rejecting: KV = { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('x'); }, del: async () => { throw new Error('x'); } };
  const hanging: KV = { get: () => new Promise(() => {}), set: () => new Promise(() => {}), del: () => new Promise(() => {}) };
  assert.equal(await readCache(throwing, ID, NOW), null);
  assert.equal(await readCache(rejecting, ID, NOW), null);
  const t = Date.now(); assert.equal(await readCache(hanging, ID, NOW, 50), null); assert.ok(Date.now() - t < 500, 'timed out quickly');
  assert.equal(await writeCache(throwing, ID, SNAP, NOW), false);
  assert.equal(await writeCache(rejecting, ID, SNAP, NOW), false);
  assert.equal(await readCache(indexedDbKV(), ID, NOW), null, 'no indexedDB in Node: reads as no cache');
  assert.equal(await writeCache(indexedDbKV(), ID, SNAP, NOW), false);
});

test('a snapshot over the size cap is not written', async () => {
  const kv = memoryKV(); const big = { ...SNAP, cold: { ['0x' + 'a'.repeat(64)]: Array.from({ length: 3999 }, (_, i) => ({ e: i, p: 1, v: 1, b: 1, s: 1, f: 0, k: 1, tx: '0x' + 'b'.repeat(64) })) } };
  for (let i = 0; i < 9; i++) (big.cold as any)['0x' + String(i).repeat(64)] = big.cold['0x' + 'a'.repeat(64)];
  assert.equal(await writeCache(kv, ID, big as any, NOW), false);
  assert.equal(kv.data.size, 0);
});

test('a hanging write resolves false in time; non-string and other-chain entries read as no cache', async () => {
  const hanging: KV = { get: () => new Promise(() => {}), set: () => new Promise(() => {}), del: () => new Promise(() => {}) };
  const t = Date.now(); assert.equal(await writeCache(hanging, ID, SNAP, NOW, 50), false); assert.ok(Date.now() - t < 500, 'write timed out quickly');
  const weird: KV = { get: async () => null as any, set: async () => {}, del: async () => {} };
  assert.equal(await readCache(weird, ID, NOW), null);
  const kv = memoryKV(); await writeCache(kv, { ...ID, chainId: 1 }, SNAP, NOW);
  assert.equal(await readCache(kv, ID, NOW), null, 'other chain');
});
