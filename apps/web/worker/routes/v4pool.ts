// GET /api/v4/pool: read-only view of the Uniswap v4 reference pool (tIP16P / stable test token) on Robinhood Chain
// Testnet. The pool comes from resolvePoolConfig (defaults, or the V4_* wrangler vars after a re-pool).
// One JSON-RPC read of the public RPC (eth_blockNumber + two extsload calls). Upstream bodies are never echoed.
import type { V4PoolResponse } from '../api-types.ts';
import type { AppEnv, Fetch } from '../env.ts';
import { HttpError, json } from '../http.ts';
import { log } from '../log.ts';
import type { Ctx } from '../router.ts';
import { enforceRateLimit, rateKey } from '../security.ts';
import {
  EXTSLOAD_SELECTOR, decodeLiquidity, decodeSlot0, explorerAddress, isTickInRange, liquiditySlot, priceStablePerUnit,
  resolvePoolConfig, stableToken, unitToken, type V4PoolConfig, type V4PoolVars,
} from '../v4/pool.ts';

export const DEFAULT_RPC = 'https://rpc.testnet.chain.robinhood.com';
// v2: body gained stableSymbol / unitSymbol / roles / priceStablePerUnit; the pool id is part of the key so a
// re-pointed pool never serves the previous pool's cached body.
export const CACHE_KEY_PREFIX = 'v4pool:v2:';
export const cacheKey = (poolId: string): string => CACHE_KEY_PREFIX + poolId.toLowerCase();
export const FRESH_MS = 30_000;
const KV_TTL_SECONDS = 60; // KV needs expirationTtl >= 60; freshness is judged from fetchedAtMs
const RPC_TIMEOUT_MS = 8_000;
const NOTE = 'Secondary reference venue for a test token pair. Not a hook and not the sealed-bid market.';
const QUANTITY = /^0x[0-9a-fA-F]{1,15}$/;

type Cached = { fetchedAtMs: number; body: V4PoolResponse };

function rpcUrl(env: { ROBINHOOD_RPC?: string }): string {
  const v = typeof env.ROBINHOOD_RPC === 'string' ? env.ROBINHOOD_RPC.trim() : '';
  return v.startsWith('https://') ? v : DEFAULT_RPC;
}

async function rpc(fetchFn: Fetch, url: string, id: number, method: string, params: unknown[], signal: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal });
  } catch {
    throw new HttpError(502, 'FEED_UPSTREAM', 'v4 pool rpc unavailable');
  }
  if (!res.ok) throw new HttpError(502, 'FEED_UPSTREAM', 'v4 pool rpc unavailable');
  let body: unknown;
  try { body = await res.json(); } catch { throw new HttpError(502, 'FEED_UPSTREAM', 'v4 pool rpc bad response'); }
  const result = (body as { result?: unknown } | null)?.result;
  if (typeof result !== 'string') throw new HttpError(502, 'FEED_UPSTREAM', 'v4 pool rpc bad response');
  return result;
}

const extsload = (cfg: V4PoolConfig, fetchFn: Fetch, url: string, id: number, slot: string, signal: AbortSignal) =>
  rpc(fetchFn, url, id, 'eth_call', [{ to: cfg.poolManager, data: EXTSLOAD_SELECTOR + slot.slice(2) }, 'latest'], signal);

function staticParts(cfg: V4PoolConfig) {
  const unitRole = cfg.unitIsToken0 ? 'token0' : 'token1';
  return {
    chainId: cfg.chainId,
    poolManager: cfg.poolManager,
    poolId: cfg.poolId,
    token0: { ...cfg.token0 },
    token1: { ...cfg.token1 },
    stableSymbol: stableToken(cfg).symbol,
    unitSymbol: unitToken(cfg).symbol,
    roles: { unit: unitRole, stable: unitRole === 'token0' ? 'token1' : 'token0' },
    fee: cfg.fee,
    tickSpacing: cfg.tickSpacing,
    hooks: null,
    tickLower: cfg.tickLower,
    tickUpper: cfg.tickUpper,
    note: NOTE,
    explorer: { poolManager: explorerAddress(cfg.poolManager), token0: explorerAddress(cfg.token0.address), token1: explorerAddress(cfg.token1.address) },
  } as const;
}

function degraded(cfg: V4PoolConfig, nowMs: number, code: 'RPC_UNAVAILABLE' | 'RPC_BAD_RESPONSE' | 'POOL_NOT_INITIALIZED'): V4PoolResponse {
  return {
    mode: 'DEGRADED', ...staticParts(cfg),
    tick: null, sqrtPriceX96: null, priceMusdcPerUnit: null, priceStablePerUnit: null, liquidity: null, inRange: null, blockNumber: null,
    updatedAt: new Date(nowMs).toISOString(), error: { code },
  };
}

async function readChain(cfg: V4PoolConfig, fetchFn: Fetch, url: string, nowMs: number): Promise<V4PoolResponse> {
  const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
  let block: string; let slot0: string; let liq: string;
  try {
    [block, slot0, liq] = await Promise.all([
      rpc(fetchFn, url, 1, 'eth_blockNumber', [], signal),
      extsload(cfg, fetchFn, url, 2, cfg.stateSlot, signal),
      extsload(cfg, fetchFn, url, 3, liquiditySlot(cfg), signal),
    ]);
  } catch (err) {
    const bad = err instanceof HttpError && err.message.endsWith('bad response');
    return degraded(cfg, nowMs, bad ? 'RPC_BAD_RESPONSE' : 'RPC_UNAVAILABLE');
  }
  let s; let liquidity; let blockNumber;
  try {
    if (!QUANTITY.test(block)) throw new Error('bad block');
    blockNumber = Number(BigInt(block));
    s = decodeSlot0(slot0);
    liquidity = decodeLiquidity(liq);
  } catch {
    return degraded(cfg, nowMs, 'RPC_BAD_RESPONSE');
  }
  if (s.sqrtPriceX96 === 0n) return degraded(cfg, nowMs, 'POOL_NOT_INITIALIZED');
  const price = priceStablePerUnit(s.sqrtPriceX96, cfg);
  return {
    mode: 'REAL', ...staticParts(cfg),
    tick: s.tick, sqrtPriceX96: s.sqrtPriceX96.toString(), priceMusdcPerUnit: price, priceStablePerUnit: price,
    liquidity: liquidity.toString(), inRange: isTickInRange(s.tick, cfg), blockNumber,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

async function readCache(kv: Ctx['env']['CACHE'], cfg: V4PoolConfig, nowMs: number): Promise<V4PoolResponse | null> {
  try {
    const raw = await kv.get(cacheKey(cfg.poolId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Cached;
    if (typeof v?.fetchedAtMs !== 'number' || v.body?.mode !== 'REAL' || v.body.poolId !== cfg.poolId) return null;
    const age = nowMs - v.fetchedAtMs;
    return age >= 0 && age < FRESH_MS ? v.body : null;
  } catch {
    return null; // KV is a brake, not a dependency
  }
}

export async function v4Pool(c: Ctx): Promise<Response> {
  await enforceRateLimit(c.env.RL_READ, await rateKey(c.req, 'GET /api/v4/pool', false));
  const now = c.deps.nowMs();
  const { config: cfg, source } = resolvePoolConfig(c.env as AppEnv & V4PoolVars);
  if (source === 'default (invalid vars)') log({ level: 'warn', event: 'v4pool_vars_invalid', code: 'V4_VARS_INVALID', requestId: c.requestId });
  const hit = await readCache(c.env.CACHE, cfg, now);
  if (hit) { c.log.mode = 'REAL'; c.log.cache = 'HIT'; return json(hit, c.requestId); }
  const body = await readChain(cfg, c.deps.fetch, rpcUrl(c.env), now);
  c.log.mode = body.mode;
  c.log.cache = 'MISS';
  if (body.mode === 'REAL') {
    c.exec.waitUntil(c.env.CACHE.put(cacheKey(cfg.poolId), JSON.stringify({ fetchedAtMs: now, body } satisfies Cached), { expirationTtl: KV_TTL_SECONDS }).catch(() => {
      log({ level: 'warn', event: 'v4pool_cache_write_failed', code: 'KV_PUT_FAILED', requestId: c.requestId });
    }));
  } else {
    log({ level: 'warn', event: 'v4pool_degraded', code: body.error?.code, requestId: c.requestId });
  }
  return json(body, c.requestId);
}
