import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, encodeAbiParameters, getAddress, toHex } from 'viem';
import { handleFetch } from '../app.ts';
import {
  DEFAULT_POOL, POOL, decodeLiquidity, decodeSlot0, isTickInRange, liquiditySlot, poolIdFor, priceStablePerUnit,
  priceToken1PerToken0, resolvePoolConfig, stateSlotFor, type V4PoolConfig,
} from '../v4/pool.ts';
import { keccak256 as keccakLocal, bytesToHex } from '../v4/keccak.ts';
import { FIXED_NOW_MS, baseEnv, fakeExec, jsonResponse, limiter, memKV, testDeps } from './helpers/fakes.ts';

const SQRT = 262650619782058807908119467889n;
const MUSDG = '0x0B71c1B397A9d33198e0A6a5701E12011AC84D95';
const pack = (sqrt: bigint, tick: number, protocolFee = 0, lpFee = 3000): string => {
  const t = BigInt.asUintN(24, BigInt(tick));
  const w = sqrt | (t << 160n) | (BigInt(protocolFee) << 184n) | (BigInt(lpFee) << 208n);
  return '0x' + w.toString(16).padStart(64, '0');
};
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

test('pool constants match the deployment file and the slot is keccak(poolId, 6)', () => {
  assert.equal(POOL.poolManager, getAddress(POOL.poolManager));
  assert.equal(POOL.token0.address, getAddress(POOL.token0.address));
  assert.equal(POOL.token1.address, getAddress(POOL.token1.address));
  assert.equal(POOL.stateSlot, keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [POOL.poolId as `0x${string}`, 6n])));
  assert.equal(liquiditySlot(), '0x2c06a2b62b70da3a4d7551113aa826f03a01355f7b8d671389058485389cce78');
  assert.deepEqual([POOL.fee, POOL.tickSpacing, POOL.tickLower, POOL.tickUpper, POOL.chainId], [3000, 60, -28080, -19860, 46630]);
});

test('decodeSlot0: live read-back vector (price 10.99, tick 23971, fee 3000, protocol fee 0)', () => {
  const s = decodeSlot0(pack(SQRT, 23971));
  assert.equal(s.sqrtPriceX96, SQRT);
  assert.equal(s.tick, 23971);
  assert.equal(s.protocolFee, 0);
  assert.equal(s.lpFee, 3000);
});

test('decodeSlot0: negative tick uses 24-bit two\'s complement', () => {
  assert.equal(decodeSlot0(pack(SQRT, -1)).tick, -1);
  assert.equal(decodeSlot0(pack(SQRT, -887272)).tick, -887272);
  assert.equal(decodeSlot0(pack(SQRT, 887272)).tick, 887272);
  assert.equal(decodeSlot0(pack(SQRT, -8388608)).tick, -8388608);
  assert.equal(decodeSlot0(pack(SQRT, 8388607)).tick, 8388607);
  // neighbouring fields do not leak into the tick
  const s = decodeSlot0(pack((1n << 160n) - 1n, -5, 0xffffff, 0xffffff));
  assert.deepEqual([s.sqrtPriceX96, s.tick, s.protocolFee, s.lpFee], [(1n << 160n) - 1n, -5, 0xffffff, 0xffffff]);
});

test('decodeSlot0 / decodeLiquidity reject anything that is not a 32-byte hex word', () => {
  for (const bad of ['', '0x', '0x12', 'nothex', '0x' + 'g'.repeat(64), '0x' + '0'.repeat(65), 7, null]) {
    assert.throws(() => decodeSlot0(bad as string), /bad word/, String(bad));
    assert.throws(() => decodeLiquidity(bad as string), /bad word/, String(bad));
  }
});

test('priceToken1PerToken0: exact decimal strings from BigInt math', () => {
  assert.equal(priceToken1PerToken0(SQRT), '10.990000'); // floor(sqrt) sits a hair under 10.99: rounds to nearest, not down
  assert.equal(priceToken1PerToken0(1n << 96n), '1.000000');
  assert.equal(priceToken1PerToken0(2n << 96n), '4.000000');
  assert.equal(priceToken1PerToken0(0n), '0.000000');
  assert.equal(priceToken1PerToken0(4295128739n), '0.000000'); // MIN_SQRT_PRICE
  assert.equal(priceToken1PerToken0(1461446703485210103287273052203988822378723970342n), '340256786836388094070642339899681172762.184832');
  // 0.5 price: sqrt(0.5) * 2^96 rounded down is within 1e-6
  const half = 56022770974786139918731938227n;
  assert.equal(priceToken1PerToken0(half), '0.500000');
});

test('decodeLiquidity: uint128 in the low bits, zero liquidity, max', () => {
  assert.equal(decodeLiquidity(word(17851181514n)), 17851181514n);
  assert.equal(decodeLiquidity(word(0n)), 0n);
  assert.equal(decodeLiquidity(word((1n << 128n) - 1n)), (1n << 128n) - 1n);
  assert.equal(decodeLiquidity(word((7n << 128n) | 5n)), 5n);
});

test('isTickInRange: lower inclusive, upper exclusive', () => {
  assert.equal(isTickInRange(-23972), true);
  assert.equal(isTickInRange(-28080), true);
  assert.equal(isTickInRange(-28081), false);
  assert.equal(isTickInRange(-19861), true);
  assert.equal(isTickInRange(-19860), false);
  assert.equal(isTickInRange(5), false);
  // an explicit config (the retired unit = currency0 pool shape) uses its own bounds
  assert.equal(isTickInRange(23971, { ...POOL, tickLower: 19860, tickUpper: 28080 }), true);
  assert.equal(isTickInRange(28080, { ...POOL, tickLower: 19860, tickUpper: 28080 }), false);
});

// route
const SITE = 'https://robinize.agent-dong.workers.dev';
const RPC = 'https://rpc.testnet.chain.robinhood.com';
type Call = { url: string; method: string; params: unknown[] };

// extsload goes through eth_call: selector 0x1e2eaeaf + slot
const EXTSLOAD = '0x1e2eaeaf';
function chainFetch(opts: { slot0?: string; liq?: string; block?: string; fail?: 'http' | 'throw' | 'rpcerror' | 'garbage'; cfg?: V4PoolConfig } = {}) {
  const cfg = opts.cfg ?? POOL;
  const calls: Call[] = [];
  const fn = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const body = JSON.parse(await req.text()) as { id: number; method: string; params: any[] };
    calls.push({ url: req.url, method: body.method, params: body.params });
    if (opts.fail === 'throw') throw new Error('SECRET-UPSTREAM-TEXT connect ECONNREFUSED');
    if (opts.fail === 'http') return new Response('SECRET-UPSTREAM-TEXT upstream exploded', { status: 503 });
    if (opts.fail === 'rpcerror') return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'SECRET-UPSTREAM-TEXT' } });
    if (opts.fail === 'garbage') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: 'SECRET-UPSTREAM-TEXT' });
    let result: string;
    if (body.method === 'eth_blockNumber') result = opts.block ?? '0x'+(128450170).toString(16);
    else if (body.method === 'eth_call') {
      const data: string = body.params[0].data;
      assert.equal(body.params[0].to.toLowerCase(), POOL.poolManager.toLowerCase());
      assert.ok(data.startsWith(EXTSLOAD), data);
      const slot = '0x' + data.slice(EXTSLOAD.length);
      if (slot === cfg.stateSlot) result = opts.slot0 ?? (cfg.unitIsToken0 ? pack(SQRT, 23971) : pack(SQRT_INV, -23972));
      else if (slot === liquiditySlot(cfg)) result = opts.liq ?? word(17851181514n);
      else throw new Error('unexpected slot ' + slot);
    } else throw new Error('unexpected ' + body.method);
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result });
  };
  return { fetch: fn, calls };
}

const env = (over: Record<string, unknown> = {}) => baseEnv({ CACHE: memKV(() => FIXED_NOW_MS), ...over });
const get = (e: unknown, deps: unknown, exec = fakeExec()) => handleFetch(new Request(SITE + '/api/v4/pool'), e as any, exec as any, deps as any);

test('GET /api/v4/pool with NO V4_* vars reads the current mUSDG/tIP16P pool (stable = currency0): price 10.990000', async () => {
  const f = chainFetch();
  const res = await get(env(), testDeps({ fetch: f.fetch }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const b = await res.json() as any;
  assert.deepEqual(b, {
    mode: 'REAL', chainId: 46630,
    poolManager: POOL.poolManager, poolId: POOL.poolId,
    token0: { address: MUSDG, symbol: 'mUSDG', decimals: 6 },
    token1: { address: UNIT, symbol: 'tIP16P', decimals: 6 },
    stableSymbol: 'mUSDG', unitSymbol: 'tIP16P', roles: { unit: 'token1', stable: 'token0' },
    fee: 3000, tickSpacing: 60, hooks: null,
    tick: -23972, sqrtPriceX96: '23899055485173685887908959771', priceMusdcPerUnit: '10.990000', priceStablePerUnit: '10.990000', liquidity: '17851181514',
    tickLower: -28080, tickUpper: -19860, inRange: true, blockNumber: 128_450_170,
    updatedAt: new Date(FIXED_NOW_MS).toISOString(),
    note: 'Secondary reference venue for a test token pair. Not a hook and not the sealed-bid market.',
    explorer: {
      poolManager: 'https://explorer.testnet.chain.robinhood.com/address/' + POOL.poolManager,
      token0: 'https://explorer.testnet.chain.robinhood.com/address/' + POOL.token0.address,
      token1: 'https://explorer.testnet.chain.robinhood.com/address/' + POOL.token1.address,
    },
  });
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((c) => c.url === RPC + '/'));
  assert.deepEqual(f.calls.map((c) => c.method).sort(), ['eth_blockNumber', 'eth_call', 'eth_call']);
});

test('ROBINHOOD_RPC var overrides the default URL; a non-https value falls back to the default', async () => {
  const f = chainFetch();
  await get(env({ ROBINHOOD_RPC: 'https://rpc.example.test/x' }), testDeps({ fetch: f.fetch }));
  assert.ok(f.calls.every((c) => c.url === 'https://rpc.example.test/x'));
  const g = chainFetch();
  await get(env({ ROBINHOOD_RPC: 'http://insecure.test' }), testDeps({ fetch: g.fetch }));
  assert.ok(g.calls.every((c) => c.url === RPC + '/'));
});

test('REAL with a negative tick below the range and zero liquidity: inRange false, liquidity "0"', async () => {
  const f = chainFetch({ slot0: pack(1n << 96n, -60), liq: word(0n) });
  const b = await (await get(env(), testDeps({ fetch: f.fetch }))).json() as any;
  assert.deepEqual([b.mode, b.tick, b.priceMusdcPerUnit, b.liquidity, b.inRange], ['REAL', -60, '1.000000', '0', false]);
});

test('an uninitialized pool (sqrtPriceX96 0) is DEGRADED, not a fake 0 price', async () => {
  const f = chainFetch({ slot0: word(0n) });
  const b = await (await get(env(), testDeps({ fetch: f.fetch }))).json() as any;
  assert.equal(b.mode, 'DEGRADED');
  assert.deepEqual(b.error, { code: 'POOL_NOT_INITIALIZED' });
});

for (const fail of ['http', 'throw', 'rpcerror', 'garbage'] as const) {
  test('RPC failure (' + fail + ') -> HTTP 200 DEGRADED with a static error code and no upstream text anywhere', async () => {
    const kv = memKV(() => FIXED_NOW_MS);
    const f = chainFetch({ fail });
    const res = await get(env({ CACHE: kv }), testDeps({ fetch: f.fetch }));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!/SECRET|ECONN|exploded|upstream/i.test(text), text);
    const b = JSON.parse(text);
    assert.equal(b.mode, 'DEGRADED');
    assert.match(b.error.code, /^RPC_(UNAVAILABLE|BAD_RESPONSE)$/);
    assert.deepEqual(Object.keys(b.error), ['code']);
    assert.equal(b.poolManager, POOL.poolManager);
    assert.equal(b.tick, null);
    assert.equal(b.priceMusdcPerUnit, null);
    assert.equal(b.inRange, null);
    assert.equal(kv.puts.length, 0, 'a degraded body is never cached');
  });
}

test('RPC timeout: the fetch gets an 8 s abort signal', async () => {
  let signal: AbortSignal | undefined;
  const fetchFn = async (_i: unknown, init?: RequestInit): Promise<Response> => {
    signal = init?.signal ?? undefined;
    throw new DOMException('timed out', 'TimeoutError');
  };
  const b = await (await get(env(), testDeps({ fetch: fetchFn }))).json() as any;
  assert.equal(b.mode, 'DEGRADED');
  assert.ok(signal instanceof AbortSignal);
});

const KEY = 'v4pool:v2:' + POOL.poolId;
test('cache: a REAL body is stored in KV v4pool:v2:<poolId> (ttl 60) and served for 30 s without touching the RPC', async () => {
  let now = FIXED_NOW_MS;
  const kv = memKV(() => now);
  const f = chainFetch();
  const first = await (await get(env({ CACHE: kv }), testDeps({ fetch: f.fetch, nowMs: () => now }))).json() as any;
  assert.deepEqual(kv.puts, [{ key: KEY, ttl: 60 }]);
  assert.equal(JSON.parse(kv.store.get(KEY)!.value).fetchedAtMs, FIXED_NOW_MS);
  assert.equal(f.calls.length, 3);
  now += 29_000;
  const second = await (await get(env({ CACHE: kv }), testDeps({ fetch: f.fetch, nowMs: () => now }))).json() as any;
  assert.equal(f.calls.length, 3, 'cache hit: no new RPC calls');
  assert.deepEqual(second, first);
  now += 2_000; // 31 s old: stale, refetch
  const g = chainFetch({ slot0: pack(SQRT, 24000), liq: word(5n) });
  const third = await (await get(env({ CACHE: kv }), testDeps({ fetch: g.fetch, nowMs: () => now }))).json() as any;
  assert.equal(g.calls.length, 3);
  assert.equal(third.tick, 24000);
  assert.equal(third.updatedAt, new Date(now).toISOString());
});

test('cache: a corrupt or failing KV never breaks the route', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  await kv.put(KEY, '{not json', { expirationTtl: 60 });
  const f = chainFetch();
  const ok = await (await get(env({ CACHE: kv }), testDeps({ fetch: f.fetch }))).json() as any;
  assert.equal(ok.mode, 'REAL');
  const broken = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } };
  const ok2 = await (await get(env({ CACHE: broken }), testDeps({ fetch: chainFetch().fetch }))).json() as any;
  assert.equal(ok2.mode, 'REAL');
});

test('rate limit: RL_READ keyed on the route and the IP; when exceeded the route answers 429 before any RPC', async () => {
  const rl = limiter(1);
  const f = chainFetch();
  const mk = () => new Request(SITE + '/api/v4/pool', { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  const e = env({ RL_READ: rl });
  const r1 = await handleFetch(mk(), e as any, fakeExec() as any, testDeps({ fetch: f.fetch }) as any);
  assert.equal(r1.status, 200);
  const r2 = await handleFetch(mk(), e as any, fakeExec() as any, testDeps({ fetch: f.fetch }) as any);
  assert.equal(r2.status, 429);
  assert.equal(((await r2.json()) as any).error.code, 'RATE_LIMITED');
  assert.deepEqual(rl.keys, ['GET /api/v4/pool:ip:203.0.113.7', 'GET /api/v4/pool:ip:203.0.113.7']);
  assert.equal(f.calls.length, 3);
});

test('POST /api/v4/pool is 405 (read-only route)', async () => {
  const res = await handleFetch(new Request(SITE + '/api/v4/pool', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), env() as any, fakeExec() as any, testDeps() as any);
  assert.equal(res.status, 405);
});

// configurable pool (re-pool for a new stable token)
const UNIT = '0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A';
// Same throwaway addresses as packages/contracts/test/RePoolV4.t.sol: one on each side of tIP16P.
const STABLE_LOW = '0x000000000000000000000000000000005714B1E0';
const STABLE_HIGH = '0xffffffffffffffffffffffffffffffffa8eb4e1f';
// Pool id printed by the RePoolV4 fork test for (STABLE_LOW, tIP16P, 3000, 60, 0x0).
const ID_LOW = '0x0e69d437ec89a93ff125c189a121fe0f70b90583c12ac8ad1b2c08e08102febb';
const SQRT_INV = 23899055485173685887908959771n; // floor(sqrt(100 * 2^192 / 1099)): unit is currency1
const viemPoolId = (t0: string, t1: string) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [t0 as `0x${string}`, t1 as `0x${string}`, 3000, 60, '0x0000000000000000000000000000000000000000'],
));
const varsLow = { V4_POOL_ID: ID_LOW, V4_TOKEN0: STABLE_LOW, V4_TOKEN1: UNIT, V4_TICK_LOWER: '-28080', V4_TICK_UPPER: '-19860', V4_TOKEN1_SYMBOL: 'mUSDG' };
const varsHigh = { V4_POOL_ID: viemPoolId(UNIT, STABLE_HIGH), V4_TOKEN0: UNIT, V4_TOKEN1: STABLE_HIGH, V4_TICK_LOWER: '19860', V4_TICK_UPPER: '28080', V4_TOKEN1_SYMBOL: 'mUSDG' };

test('local keccak256 matches viem on empty, short, rate-boundary and multi-block inputs', () => {
  for (const len of [0, 1, 31, 32, 64, 135, 136, 137, 160, 272, 300]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
    assert.equal(bytesToHex(keccakLocal(bytes)), keccak256(toHex(bytes)), 'len ' + len);
  }
  assert.equal(bytesToHex(keccakLocal(new Uint8Array(0))), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});

test('poolIdFor / stateSlotFor reproduce the deployed pool id and slot, and the RePoolV4 fork-test pool id', () => {
  assert.equal(poolIdFor(DEFAULT_POOL.token0.address, DEFAULT_POOL.token1.address), DEFAULT_POOL.poolId);
  assert.equal(stateSlotFor(DEFAULT_POOL.poolId), DEFAULT_POOL.stateSlot);
  assert.equal(poolIdFor(STABLE_LOW, UNIT), ID_LOW);
  assert.equal(poolIdFor(UNIT, STABLE_HIGH), viemPoolId(UNIT, STABLE_HIGH));
});

test('priceStablePerUnit: exact vectors for both orderings (always stable per unit)', () => {
  const low = resolvePoolConfig(varsLow).config; // stable = currency0, unit = currency1
  const high = resolvePoolConfig(varsHigh).config; // unit = currency0
  assert.equal(low.unitIsToken0, false);
  assert.equal(high.unitIsToken0, true);
  // unit = currency0: sqrtP^2 / 2^192
  assert.equal(priceStablePerUnit(SQRT, high), '10.990000');
  assert.equal(priceStablePerUnit(SQRT_INV, DEFAULT_POOL), '10.990000'); // the default pool: stable = currency0
  assert.equal(priceStablePerUnit(1n << 96n, high), '1.000000');
  assert.equal(priceStablePerUnit(2n << 96n, high), '4.000000');
  // unit = currency1: 2^192 / sqrtP^2
  assert.equal(priceStablePerUnit(SQRT_INV, low), '10.990000');
  assert.equal(priceStablePerUnit(1n << 96n, low), '1.000000');
  assert.equal(priceStablePerUnit(2n << 96n, low), '0.250000');
  assert.equal(priceStablePerUnit(SQRT_INV / 2n, low), '43.960000');
  // decimals are honoured (an 18-decimal stable at 10.99 per 6-decimal unit), both orderings
  const s18 = (c: V4PoolConfig): V4PoolConfig => c.unitIsToken0 ? { ...c, token1: { ...c.token1, decimals: 18 } } : { ...c, token0: { ...c.token0, decimals: 18 } };
  assert.equal(priceStablePerUnit(262650619782058807908119467889743196n, s18(high)), '10.990000');
  assert.equal(priceStablePerUnit(23899055485173685887908n, s18(low)), '10.990000');
  assert.throws(() => priceStablePerUnit(0n, low), /bad sqrtPriceX96/);
});

test('resolvePoolConfig: no vars -> defaults; full valid vars -> that pool with roles by address', () => {
  assert.deepEqual(resolvePoolConfig({}), { config: DEFAULT_POOL, source: 'default' });
  assert.deepEqual(resolvePoolConfig(undefined), { config: DEFAULT_POOL, source: 'default' });
  assert.equal(resolvePoolConfig({ V4_POOL_ID: '', V4_TOKEN1_SYMBOL: 'mUSDG' }).source, 'default');
  const { config: c, source } = resolvePoolConfig(varsLow);
  assert.equal(source, 'vars');
  assert.deepEqual(c, {
    chainId: 46630, poolManager: POOL.poolManager, poolId: ID_LOW,
    stateSlot: keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [ID_LOW, 6n])),
    token0: { address: STABLE_LOW, symbol: 'mUSDG', decimals: 6 },
    token1: { address: UNIT, symbol: 'tIP16P', decimals: 6 },
    unitIsToken0: false, fee: 3000, tickSpacing: 60, tickLower: -28080, tickUpper: -19860,
  });
  assert.equal(isTickInRange(-23972, c), true);
  assert.equal(isTickInRange(23971, c), false);
  const h = resolvePoolConfig(varsHigh).config;
  assert.deepEqual([h.token0.symbol, h.token1.symbol, h.token1.address, h.unitIsToken0], ['tIP16P', 'mUSDG', STABLE_HIGH, true]);
  // ticks may be JSON numbers in wrangler.jsonc
  assert.deepEqual(resolvePoolConfig({ ...varsLow, V4_TICK_LOWER: -28080, V4_TICK_UPPER: -19860 }).config, c);
  // the symbol var is optional: a missing or unsafe symbol reads STABLE
  assert.equal(resolvePoolConfig({ ...varsHigh, V4_TOKEN1_SYMBOL: undefined }).config.token1.symbol, 'STABLE');
  assert.equal(resolvePoolConfig({ ...varsHigh, V4_TOKEN1_SYMBOL: '<b>x</b>' }).config.token1.symbol, 'STABLE');
});

test('resolvePoolConfig: any bad or partial var falls back to the defaults as a whole', () => {
  const bad: Record<string, unknown>[] = [
    { ...varsLow, V4_POOL_ID: ID_LOW.slice(0, 65) },
    { ...varsLow, V4_POOL_ID: '0x' + 'z'.repeat(64) },
    { ...varsLow, V4_POOL_ID: DEFAULT_POOL.poolId }, // id is not the hash of this key
    { ...varsLow, V4_TOKEN0: STABLE_LOW.slice(0, 41) },
    { ...varsLow, V4_TOKEN0: UNIT, V4_TOKEN1: STABLE_LOW }, // not sorted
    { ...varsLow, V4_TOKEN1: '0x000000000000000000000000000000005714B1E1' }, // neither side is the unit token
    { ...varsLow, V4_TICK_LOWER: '-28080.5' },
    { ...varsLow, V4_TICK_LOWER: '1e3' },
    { ...varsLow, V4_TICK_LOWER: '-28081' }, // not a multiple of 60
    { ...varsLow, V4_TICK_UPPER: '900000' }, // beyond MAX_TICK
    { ...varsLow, V4_TICK_LOWER: '-19860', V4_TICK_UPPER: '-28080' }, // lower >= upper
    { ...varsLow, V4_TICK_UPPER: undefined }, // partial
    { V4_POOL_ID: ID_LOW },
    { ...varsLow, V4_TOKEN0: 42 },
  ];
  for (const v of bad) assert.deepEqual(resolvePoolConfig(v), { config: DEFAULT_POOL, source: 'default (invalid vars)' }, JSON.stringify(v));
});

test('GET /api/v4/pool with V4_* vars (stable = currency0): reads the new slots, reports stable per unit and the roles', async () => {
  const cfg = resolvePoolConfig(varsLow).config;
  const kv = memKV(() => FIXED_NOW_MS);
  const f = chainFetch({ cfg, slot0: pack(SQRT_INV, -23972), liq: word(17851181514n) });
  const b = await (await get(env({ CACHE: kv, ...varsLow }), testDeps({ fetch: f.fetch }))).json() as any;
  assert.equal(b.mode, 'REAL');
  assert.equal(b.poolId, ID_LOW);
  assert.deepEqual(b.token0, { address: STABLE_LOW, symbol: 'mUSDG', decimals: 6 });
  assert.deepEqual(b.token1, { address: UNIT, symbol: 'tIP16P', decimals: 6 });
  assert.deepEqual([b.stableSymbol, b.unitSymbol, b.roles], ['mUSDG', 'tIP16P', { unit: 'token1', stable: 'token0' }]);
  assert.deepEqual([b.tick, b.priceStablePerUnit, b.priceMusdcPerUnit, b.inRange, b.tickLower, b.tickUpper], [-23972, '10.990000', '10.990000', true, -28080, -19860]);
  assert.equal(b.explorer.token0, 'https://explorer.testnet.chain.robinhood.com/address/' + STABLE_LOW);
  assert.deepEqual(kv.puts, [{ key: 'v4pool:v2:' + ID_LOW, ttl: 60 }]);
  // a cached body of the default pool is never served for the re-pointed pool
  const g = chainFetch();
  await get(env({ CACHE: kv }), testDeps({ fetch: g.fetch }));
  assert.equal(g.calls.length, 3, 'default pool: own cache key, fresh read');
});

test('GET /api/v4/pool with V4_* vars (unit = currency0) and with invalid vars (defaults, no var echoed)', async () => {
  const cfg = resolvePoolConfig(varsHigh).config;
  const f = chainFetch({ cfg });
  const b = await (await get(env(varsHigh), testDeps({ fetch: f.fetch }))).json() as any;
  assert.deepEqual([b.mode, b.stableSymbol, b.roles.stable, b.priceStablePerUnit, b.token1.address], ['REAL', 'mUSDG', 'token1', '10.990000', STABLE_HIGH]);
  const g = chainFetch();
  const res = await get(env({ ...varsHigh, V4_TICK_LOWER: 'nope' }), testDeps({ fetch: g.fetch }));
  const text = await res.text();
  assert.doesNotMatch(text, /nope|ffffffffa8eb4e1f/i);
  const d = JSON.parse(text);
  assert.deepEqual([d.mode, d.poolId, d.stableSymbol], ['REAL', DEFAULT_POOL.poolId, 'mUSDG']);
});

// the live mUSDG / tIP16P pool (stable = currency0)
const POOL_ID_MUSDG = '0xafede3281589f6c8d26792dc3bd81603bb9ccc5ea77ce2dd97f70dbcaf5d5a54';
const varsMusdg = { V4_POOL_ID: POOL_ID_MUSDG, V4_TOKEN0: MUSDG, V4_TOKEN1: UNIT, V4_TICK_LOWER: '-28080', V4_TICK_UPPER: '-19860', V4_TOKEN1_SYMBOL: 'mUSDG' };

test('live mUSDG pool vars: the id is keccak(mUSDG, tIP16P, 3000, 60, 0x0), the slot is derived, price is 10.990000 stable per unit', async () => {
  assert.equal(poolIdFor(MUSDG, UNIT), POOL_ID_MUSDG);
  assert.equal(viemPoolId(MUSDG, UNIT), POOL_ID_MUSDG);
  const cfg = resolvePoolConfig(varsMusdg);
  assert.equal(cfg.source, 'vars');
  assert.equal(cfg.config.unitIsToken0, false);
  assert.equal(cfg.config.stateSlot, '0x2c06a2b62b70da3a4d7551113aa826f03a01355f7b8d671389058485389cce75');
  assert.equal(priceStablePerUnit(23899055485173685887908959771n, cfg.config), '10.990000');
  const f = chainFetch({ cfg: cfg.config, slot0: pack(23899055485173685887908959771n, -23972), liq: word(17851181514n) });
  const b = await (await get(env(varsMusdg), testDeps({ fetch: f.fetch }))).json() as any;
  assert.deepEqual(
    [b.mode, b.poolId, b.stableSymbol, b.unitSymbol, b.roles, b.tick, b.priceStablePerUnit, b.priceMusdcPerUnit, b.liquidity, b.inRange, b.tickLower, b.tickUpper],
    ['REAL', POOL_ID_MUSDG, 'mUSDG', 'tIP16P', { unit: 'token1', stable: 'token0' }, -23972, '10.990000', '10.990000', '17851181514', true, -28080, -19860],
  );
});

test('apps/web/wrangler.jsonc V4_* vars equal workerVars of the committed deployment file', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
  const wr = read('../../wrangler.jsonc').vars as Record<string, string>;
  const dep = read('../../../../packages/contracts/deployments/v4-pool-mUSDG-46630.json').workerVars as Record<string, string>;
  for (const k of Object.keys(dep)) assert.equal(wr[k], dep[k], k);
  assert.deepEqual(Object.keys(dep).sort(), ['V4_POOL_ID', 'V4_TICK_LOWER', 'V4_TICK_UPPER', 'V4_TOKEN0', 'V4_TOKEN1', 'V4_TOKEN1_SYMBOL']);
  assert.equal(resolvePoolConfig(wr).source, 'vars');
});

test('DEFAULT_POOL equals the pool the wrangler.jsonc V4_* vars resolve to (removing the vars changes nothing)', async () => {
  const { readFileSync } = await import('node:fs');
  const wr = JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')).vars as Record<string, string>;
  assert.deepEqual(resolvePoolConfig(wr).config, DEFAULT_POOL);
  assert.deepEqual(resolvePoolConfig(undefined).config, DEFAULT_POOL);
  assert.deepEqual([DEFAULT_POOL.token0.symbol, DEFAULT_POOL.token0.address, DEFAULT_POOL.unitIsToken0], ['mUSDG', MUSDG, false]);
});
