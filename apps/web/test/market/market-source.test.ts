// node --test test/market/market-source.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEvents, decodeLogs, newLedger, type RawLog } from '../../src/lib/market-core.ts';
import { buildSnapshot, type MarketSnapshot } from '../../src/lib/market-snap.ts';
import { AHEAD_TOLERANCE, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_GAP, chooseBase, fetchSnapshot } from '../../src/lib/market-source.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
const SCHED = { t0: 1790958692, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2_000_000 };
const ID = { chainId: 46630, book: '0x2ba62631d74827abf2f7467b20370dc2dc59aa11', deployBlock: 127690064 };
const snapAt = (cursor: number, complete = true): MarketSnapshot => { const l = newLedger(); applyEvents(l, decodeLogs(FX.logs), SCHED); return buildSnapshot(l, { ...ID, cursor, head: cursor + 12, headTime: 1, builtAt: 1, complete }, SCHED); };
const res = (body: string, status = 200, type = 'application/json; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } });

test('chooseBase: a partial or stale server snapshot is never used as current', () => {
  const head = 128_100_000;
  assert.equal(chooseBase(head, snapAt(head - 100, false), null), null, 'complete:false (backfill still running)');
  assert.equal(chooseBase(head, snapAt(head - MAX_SNAPSHOT_GAP - 1), null), null, 'too far behind the chain');
  assert.equal(chooseBase(head, snapAt(head + AHEAD_TOLERANCE + 1), null), null, 'claims blocks the chain has not produced');
  assert.equal(chooseBase(head, snapAt(head - MAX_SNAPSHOT_GAP), null)?.source, 'snapshot');
  assert.equal(chooseBase(head, snapAt(head + AHEAD_TOLERANCE), null)?.source, 'snapshot');
});

test('chooseBase: the cache may be old (its gap loads newest-first), the newest cursor wins, server wins ties', () => {
  const head = 128_100_000;
  assert.equal(chooseBase(head, null, snapAt(head - 5_000_000))?.source, 'cache');
  assert.equal(chooseBase(head, null, snapAt(head - 10, false)), null);
  assert.equal(chooseBase(head, snapAt(head - 900), snapAt(head - 100))?.source, 'cache');
  assert.equal(chooseBase(head, snapAt(head - 100), snapAt(head - 100))?.source, 'snapshot');
  assert.equal(chooseBase(head, snapAt(head - 100), snapAt(head - 900))?.snap.cursor, head - 100);
  assert.equal(chooseBase(head, null, null), null);
});

test('chooseBase: a rejected server snapshot falls back to the cache; a cache ahead of the chain is rejected; an unusable head gives null', () => {
  const head = 128_100_000;
  assert.equal(chooseBase(head, snapAt(head - MAX_SNAPSHOT_GAP - 1), snapAt(head - 5_000))?.source, 'cache', 'stale server, usable cache');
  assert.equal(chooseBase(head, snapAt(head - 50, false), snapAt(head - 5_000))?.source, 'cache', 'partial server, usable cache');
  assert.equal(chooseBase(head, null, snapAt(head + AHEAD_TOLERANCE + 1)), null, 'cache from the future (wrong chain state) is never a base');
  assert.equal(chooseBase(head, snapAt(head + AHEAD_TOLERANCE + 1), snapAt(head - 5_000))?.source, 'cache', 'ahead server, usable cache');
  for (const bad of [NaN, Infinity, -1, 1.5, undefined as unknown as number]) assert.equal(chooseBase(bad, snapAt(100), snapAt(100)), null, `head ${String(bad)}`);
  const s = snapAt(head - 100);
  assert.equal(chooseBase(head, s, null)?.snap.schedule.epochLen, SCHED.epochLen, 'the schedule stays on the chosen snapshot for the store to compare');
});

test('fetchSnapshot: valid JSON passes; 404, HTML from a static host, invalid body, network error and timeout give null', async () => {
  const good = JSON.stringify(snapAt(127999285));
  assert.ok(await fetchSnapshot(async () => res(good), '/api/market/snapshot', ID));
  assert.equal(await fetchSnapshot(async () => res('{"error":{"code":"NOT_FOUND"}}', 404), '/x', ID), null);
  assert.equal(await fetchSnapshot(async () => res('<!doctype html>', 200, 'text/html'), '/x', ID), null);
  assert.equal(await fetchSnapshot(async () => res('{"v":1}'), '/x', ID), null);
  assert.equal(await fetchSnapshot(async () => res('not json'), '/x', ID), null);
  assert.equal(await fetchSnapshot(async () => { throw new TypeError('offline'); }, '/x', ID), null);
  const t = Date.now();
  const hang = (_u: any, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  assert.equal(await fetchSnapshot(hang as typeof fetch, '/x', ID, 60), null);
  assert.ok(Date.now() - t < 1000);
});

test('fetchSnapshot: 304, a snapshot of another deployment, a null body and a synchronous throw all give null and never throw', async () => {
  const good = JSON.stringify(snapAt(127999285));
  assert.equal(await fetchSnapshot(async () => new Response(null, { status: 304, headers: { 'content-type': 'application/json' } }), '/x', ID), null);
  assert.equal(await fetchSnapshot(async () => res(good), '/x', { ...ID, deployBlock: ID.deployBlock + 1 }), null, 'other deployment');
  assert.equal(await fetchSnapshot(async () => res(good), '/x', { ...ID, chainId: 1 }), null, 'other chain');
  assert.equal(await fetchSnapshot(async () => res('null'), '/x', ID), null);
  assert.equal(await fetchSnapshot((() => { throw new Error('sync'); }) as unknown as typeof fetch, '/x', ID), null);
  assert.equal(await fetchSnapshot(async () => ({ ok: true, headers: { get: () => { throw new Error('boom'); } } }) as unknown as Response, '/x', ID), null);
  assert.equal(await fetchSnapshot(async () => res(good, 200, ''), '/x', ID), null, 'missing content-type');
});

test('fetchSnapshot: never reads or parses more than MAX_SNAPSHOT_BYTES (declared length, streamed body, text fallback)', async () => {
  const big = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1);
  assert.equal(await fetchSnapshot(async () => res(big), '/x', ID), null, 'oversized body');
  const declared = new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_SNAPSHOT_BYTES + 1) } });
  let textCalled = false; const orig = declared.text.bind(declared); declared.text = () => { textCalled = true; return orig(); };
  assert.equal(await fetchSnapshot(async () => declared, '/x', ID), null, 'declared oversize');
  assert.equal(textCalled, false, 'a declared oversize body is not read');
  // an endless stream with no content-length must be cut off, not buffered forever
  let pulled = 0; let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1_000_000)); }, cancel() { cancelled = true; } });
  const t = Date.now();
  assert.equal(await fetchSnapshot(async () => new Response(endless, { status: 200, headers: { 'content-type': 'application/json' } }), '/x', ID, 2000), null);
  assert.ok(cancelled && pulled <= MAX_SNAPSHOT_BYTES / 1_000_000 + 4 && Date.now() - t < 1500, `pulled ${pulled}`);
  // a Response-like without a stream body falls back to text() and is still bounded
  const noBody = { ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: null, text: async () => big } as unknown as Response;
  assert.equal(await fetchSnapshot(async () => noBody, '/x', ID), null);
});

test('fetchSnapshot: a hung fetch that ignores the abort signal, and a body that stalls, still end at the timeout', async () => {
  let t = Date.now();
  assert.equal(await fetchSnapshot((() => new Promise<Response>(() => {})) as unknown as typeof fetch, '/x', ID, 60), null);
  assert.ok(Date.now() - t < 1000, 'fetch ignoring the signal');
  t = Date.now();
  const stalled = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
  assert.equal(await fetchSnapshot(async () => new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } }), '/x', ID, 60), null);
  assert.ok(Date.now() - t < 1000, 'body that never ends');
  let signal: AbortSignal | undefined;
  await fetchSnapshot((async (_u: any, init?: RequestInit) => { signal = init?.signal ?? undefined; return res('x'); }) as typeof fetch, '/x', ID, 60);
  assert.ok(signal, 'the request is abortable');
  const good = JSON.stringify(snapAt(127999285));
  for (const bad of [0, -5, NaN]) assert.ok(await fetchSnapshot(async () => { await new Promise((r) => setTimeout(r, 15)); return res(good); }, '/x', ID, bad), `timeout ${bad} falls back to the default, not "abort now"`);
});

test('chooseBase with the baked build-time history: newest cursor wins; on a tie snapshot, then cache, then baked', () => {
  const head = 128_100_000;
  assert.equal(chooseBase(head, null, null, snapAt(head - 5_000_000))?.source, 'baked', 'any gap is fine (it loads newest-first)');
  assert.equal(chooseBase(head, null, null, snapAt(head - 10, false)), null, 'an incomplete one is not a base');
  assert.equal(chooseBase(head, null, null, snapAt(head + AHEAD_TOLERANCE + 1)), null, 'nor one ahead of the chain');
  assert.equal(chooseBase(head, snapAt(head - 900), null, snapAt(head - 100))?.source, 'baked', 'a newer baked file beats an older server snapshot');
  assert.equal(chooseBase(head, null, snapAt(head - 900), snapAt(head - 100))?.source, 'baked', '...and an older cache');
  assert.equal(chooseBase(head, null, snapAt(head - 100), snapAt(head - 900))?.source, 'cache');
  assert.equal(chooseBase(head, snapAt(head - 100), snapAt(head - 100), snapAt(head - 100))?.source, 'snapshot');
  assert.equal(chooseBase(head, null, snapAt(head - 100), snapAt(head - 100))?.source, 'cache');
  assert.equal(chooseBase(head, snapAt(head - MAX_SNAPSHOT_GAP - 1), null, snapAt(head - 3_000_000))?.source, 'baked', 'stale server snapshot: the baked one is the fallback');
});
