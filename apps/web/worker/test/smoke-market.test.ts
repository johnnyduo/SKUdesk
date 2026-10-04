import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { runMarketIngest, rpcUrlOk, CONFIRMATIONS, marketTarget } from '../market/ingest.ts';
import { BOOK, DEPLOY, FX, HEAD, catchUp, harness, snapshotOf } from './helpers/market-harness.ts';
import { startFakeRpc } from '../../test/market/helpers/fake-rpc.mjs';

// Source-level pins of the market block of worker/scripts/smoke.mjs (the script itself needs `wrangler dev` and a build, which
// unit tests do not run), plus an in-process run of the same ingest against the same fake RPC and fixture to derive the numbers
// the smoke expects. If the ingest changes (overlap, caps, hot window), this test says which numbers the smoke has to carry.
const SRC = readFileSync(new URL('../scripts/smoke.mjs', import.meta.url), 'utf8');

test('smoke market block: the numbers it expects equal an in-process ingest of the same fixture', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    const { runs } = await catchUp(h);
    const snap = (await snapshotOf(h))!;
    assert.ok(snap); assert.equal(snap.complete, true);
    assert.equal(snap.cursor, HEAD - CONFIRMATIONS);
    const m = /const MARKET_EXPECT = \{ cursor: (\d+), hotBooks: (\d+), maxRuns: (\d+) \};/.exec(SRC);
    assert.ok(m, 'smoke.mjs declares MARKET_EXPECT = { cursor, hotBooks, maxRuns }');
    assert.equal(Number(m[1]), snap.cursor, 'cursor');
    assert.equal(Number(m[2]), snap.hot.books.length, 'hot books');
    assert.ok(Number(m[3]) > runs, `maxRuns ${m[3]} leaves room over the ${runs} runs the catch-up needs`);
  } finally { await rpc.close(); }
});

test('smoke market block: the vars it overrides match the fixture and the fake RPC url is accepted by the ingest', () => {
  assert.match(SRC, new RegExp(`const MARKET_BOOK = '${BOOK}';`));
  assert.match(SRC, new RegExp(`const MARKET_DEPLOY_BLOCK = ${DEPLOY};`));
  assert.match(SRC, /const MARKET_CHAIN_ID = 46630;/);
  for (const k of ['MARKET_RPC_URL:', 'MARKET_BOOK:', 'MARKET_CHAIN_ID:', 'MARKET_DEPLOY_BLOCK:']) {
    assert.ok(SRC.includes(`'--var', '${k}' +`), `--var ${k} is passed to wrangler dev`);
  }
  assert.equal(rpcUrlOk('http://127.0.0.1:43210'), true);
  const target = marketTarget({ MARKET_RPC_URL: 'http://127.0.0.1:43210', MARKET_BOOK: BOOK, MARKET_CHAIN_ID: '46630', MARKET_DEPLOY_BLOCK: String(DEPLOY) } as any);
  assert.deepEqual(target, { rpc: 'http://127.0.0.1:43210', book: BOOK.toLowerCase(), chainId: 46630, deployBlock: DEPLOY });
});

test('smoke market block: fake RPC is closed, the 503 code and cache header are the current ones, the ingest goes through the scheduled handler', () => {
  assert.match(SRC, /await marketRpc\.close\(\);/);
  assert.match(SRC, /SNAPSHOT_UNAVAILABLE/);
  assert.doesNotMatch(SRC, /SNAPSHOT_NOT_READY/);
  assert.match(SRC, /s-maxage=30/);
  assert.match(SRC, /\/cdn-cgi\/handler\/scheduled\?cron=\*\+\*\+\*\+\*\+\*&time=/);
  assert.doesNotMatch(SRC, /cdn-cgi\/local\/scheduled/);
});

test('smoke market block: scheduled times are minute 1 of the hour plus multiples of 3 minutes, never a quarter hour (that would run the reconcile job)', () => {
  assert.match(SRC, /Date\.UTC\(2026, 9, 3, 12, 1, 0\) \+ i \* 3 \* 60_000/);
  const base = Date.UTC(2026, 9, 3, 12, 1, 0);
  for (let i = 0; i < 20; i++) assert.notEqual(new Date(base + i * 3 * 60_000).getUTCMinutes() % 15, 0);
});

test('smoke market block: sequential runs one scheduled minute apart never answer busy, because the lease is released after each run', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    for (let i = 0; i < 8; i++) { const s = await runMarketIngest(h.env, h.deps); assert.notEqual(s.reason, 'busy', `run ${i}`); }
  } finally { await rpc.close(); }
});
