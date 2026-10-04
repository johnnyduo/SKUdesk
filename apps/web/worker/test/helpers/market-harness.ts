// Shared setup of the market ingest tests: fixture logs, a harness around the local fake RPC and an in-memory D1.
import { readFileSync } from 'node:fs';
import { applyEvents, decodeLogs, newLedger, type RawLog } from '../../../src/lib/market-core.ts';
import { validateSnapshot } from '../../../src/lib/market-snap.ts';
import { runMarketIngest } from '../../market/ingest.ts';
import { getMeta, getParts } from '../../market/repo.ts';
import { snapshotBody } from '../../market/assemble.ts';
import { baseEnv, testDeps, FIXED_NOW_MS } from './fakes.ts';
import { sqliteD1 } from './d1.ts';
import { FAKE_SCHEDULE } from '../../../test/market/helpers/fake-rpc.mjs';

export const FX = JSON.parse(readFileSync(new URL('../../../test/market/fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
export const MIGRATIONS = ['0001_init.sql', '0002_market.sql'].map((f) => new URL('../../migrations/' + f, import.meta.url).pathname);
export const BOOK = '0x2BA62631d74827aBF2f7467B20370dC2DC59aa11';
export const DEPLOY = 127948000, HEAD = 127999300;
export const ID = { chainId: 46630, book: BOOK.toLowerCase(), deployBlock: DEPLOY };
export const ledgerOf = (logs: RawLog[]) => { const l = newLedger(); applyEvents(l, decodeLogs(logs), FAKE_SCHEDULE); return l; };
export const FULL = ledgerOf(FX.logs);

// Real fetch against the local fake RPC; counts HTTP requests (= Worker subrequests) and D1 statements per run.
export function harness(rpcUrl: string, over: Record<string, unknown> = {}, fetchImpl?: (i: any, init: any) => Promise<Response>) {
  const db = sqliteD1(MIGRATIONS); let requests = 0; let statements = 0; const sql: string[] = [];
  const counted = { ...db, prepare: (q: string) => { statements++; sql.push(q); return db.prepare(q); }, batch: db.batch };
  const env = baseEnv({ DB: counted, MARKET_RPC_URL: rpcUrl, MARKET_BOOK: BOOK, MARKET_CHAIN_ID: '46630', MARKET_DEPLOY_BLOCK: String(DEPLOY), ...over });
  let now = FIXED_NOW_MS;
  const deps = testDeps({ fetch: (i: any, init: any) => { requests++; return (fetchImpl ?? fetch)(i, init); }, nowMs: () => now });
  return { db, sql, env: env as any, deps: deps as any, tick: (ms = 60_000) => { now += ms; }, now: () => now, take: () => { const r = { requests, statements }; requests = 0; statements = 0; return r; } };
}
export async function snapshotOf(h: ReturnType<typeof harness>) {
  const meta = (await getMeta(h.db as any))!; const body = snapshotBody(meta, await getParts(h.db as any), h.now());
  return body === null ? null : validateSnapshot(JSON.parse(body), ID);
}
export async function catchUp(h: ReturnType<typeof harness>, max = 30) {
  let s; let runs = 0;
  do { s = await runMarketIngest(h.env, h.deps); runs++; h.tick(); } while (s.reason !== 'caught_up' && s.reason !== 'error' && runs < max);
  return { s, runs };
}
