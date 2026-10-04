import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleScheduled, planScheduled } from '../cron.ts';
import { baseEnv, testDeps } from './helpers/fakes.ts';
import { sqliteD1 } from './helpers/d1.ts';

const MIGRATIONS = ['0001_init.sql', '0002_market.sql'].map((f) => new URL('../migrations/' + f, import.meta.url).pathname);
const at = (h: number, m: number) => Date.UTC(2026, 9, 3, h, m, 0);

async function capture(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = []; const orig = console.log; console.log = (s: string) => { lines.push(s); };
  try { await fn(); } finally { console.log = orig; }
  return lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'market_ingest' || l.event === 'cron');
}

test('planScheduled: the old */15 job keeps its quarter hours; every other minute ingests', () => {
  assert.equal(planScheduled('*/15 * * * *', at(12, 7)), 'reconcile');
  for (const m of [0, 15, 30, 45]) assert.equal(planScheduled('* * * * *', at(12, m)), 'reconcile');
  for (let m = 0; m < 60; m++) assert.equal(planScheduled('* * * * *', at(12, m)), m % 15 === 0 ? 'reconcile' : 'ingest', 'minute ' + m);
});

test('handleScheduled routes by minute and logs one line per run; neither path throws', async () => {
  const env = baseEnv({ DB: sqliteD1(MIGRATIONS) });
  const events = await capture(async () => {
    await handleScheduled({ cron: '* * * * *', scheduledTime: at(12, 1) }, env as any, testDeps() as any);
    await handleScheduled({ cron: '* * * * *', scheduledTime: at(12, 15) }, env as any, testDeps() as any);
  });
  assert.deepEqual(events.map((e) => e.event), ['market_ingest', 'cron']);
  assert.equal(events[0].reason, 'not_configured');
});

test('a quarter-hour invocation runs only the reconcile job (the ingest is skipped, so it cannot touch the 50-subrequest budget)', async () => {
  let rpcCalls = 0;
  const env = baseEnv({ DB: sqliteD1(MIGRATIONS), MARKET_RPC_URL: 'https://rpc.example', MARKET_BOOK: '0x' + '1'.repeat(40), MARKET_CHAIN_ID: '46630', MARKET_DEPLOY_BLOCK: '100' });
  const deps = testDeps({ fetch: async () => { rpcCalls++; throw new Error('boom'); } });
  const events = await capture(() => handleScheduled({ cron: '* * * * *', scheduledTime: at(3, 30) }, env as any, deps as any));
  assert.deepEqual(events.map((e) => e.event), ['cron']);
  assert.equal(rpcCalls, 0);
});

test('a busy lease is an info-level outcome, not an error, and the line carries only short codes and numbers', async () => {
  const env = baseEnv({ DB: sqliteD1(MIGRATIONS), MARKET_RPC_URL: 'https://rpc.example', MARKET_BOOK: '0x' + '1'.repeat(40), MARKET_CHAIN_ID: '46630', MARKET_DEPLOY_BLOCK: '100' });
  const deps = testDeps({ fetch: async () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"SECRET upstream text"}}') });
  const sched = (m: number) => handleScheduled({ cron: '* * * * *', scheduledTime: at(12, m) }, env as any, deps as any);
  const events = await capture(async () => { await sched(1); });
  assert.equal(events.length, 1);
  assert.equal(events[0].fatal, undefined);
  assert.ok(events[0].level === 'info' || events[0].level === 'error' || events[0].level === 'warn');
  assert.ok(!JSON.stringify(events[0]).includes('SECRET'));
  for (const [k, v] of Object.entries(events[0])) assert.ok(['string', 'number', 'boolean'].includes(typeof v) || v === null, k);

  // Hold the lease from another "worker": the next run reports busy at info level.
  await (env.DB as any).prepare('UPDATE mk_meta SET lease_until = ?').bind(at(12, 2) + 60_000).run();
  const busy = await capture(async () => { await handleScheduled({ cron: '* * * * *', scheduledTime: at(12, 2) }, env as any, { ...deps, nowMs: () => at(12, 2) } as any); });
  assert.equal(busy[0].reason, 'busy');
  assert.equal(busy[0].level, 'info');
  assert.equal(busy[0].code, undefined);
});

test('an unhandled throw in either task is logged once with a short code and never escapes', async () => {
  const boom = (name: string) => Object.defineProperty(baseEnv({ DB: sqliteD1(MIGRATIONS) }), name, { get() { throw new Error('secret detail ' + name); } });
  const ing = await capture(() => handleScheduled({ cron: '* * * * *', scheduledTime: at(12, 2) }, boom('MARKET_RPC_URL') as any, testDeps() as any));
  assert.equal(ing.length, 1);
  assert.deepEqual([ing[0].event, ing[0].fatal, ing[0].code, ing[0].level], ['market_ingest', true, 'INTERNAL', 'error']);
  const rec = await capture(() => handleScheduled({ cron: '* * * * *', scheduledTime: at(12, 0) }, boom('GOOGLE_SA_JSON') as any, testDeps() as any));
  assert.equal(rec.length, 1);
  assert.deepEqual([rec[0].event, rec[0].fatal, rec[0].code], ['cron', true, 'INTERNAL']);
  assert.ok(!JSON.stringify([ing, rec]).includes('secret detail'));
});

// wrangler.jsonc vs the committed deployment
// Strips // and /* */ comments outside string literals (JSONC), and trailing commas.
function parseJsonc(src: string): any {
  let out = ''; let i = 0; let inStr = false;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

test('parseJsonc handles comments, trailing commas and slashes inside strings', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,], }'), { a: 'http://x', b: [1] });
});

test('wrangler.jsonc: one every-minute trigger and MARKET_* vars equal to src/data/blindbook.json', () => {
  const wr = parseJsonc(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
  const bb = JSON.parse(readFileSync(new URL('../../src/data/blindbook.json', import.meta.url), 'utf8'));
  assert.deepEqual(wr.triggers.crons, ['* * * * *']);
  assert.equal(wr.vars.MARKET_BOOK, bb.book);
  assert.equal(wr.vars.MARKET_CHAIN_ID, String(bb.chainId));
  assert.equal(wr.vars.MARKET_DEPLOY_BLOCK, String(bb.deployBlock));
  assert.match(wr.vars.MARKET_RPC_URL, /^https:\/\//);
});
