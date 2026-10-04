// Uniswap v4 reference pool (unit token tIP16P against a stable test token) on Robinhood Chain Testnet (46630):
// one config object, pure BigInt decoders. Default facts come from packages/contracts/deployments/v4-pool-mUSDG-46630.json.
// The pool can be re-pointed (after a re-pool, see docs/v4-pool.md "Re-pool for a new stable token") with
// non-secret wrangler vars V4_POOL_ID, V4_TOKEN0, V4_TOKEN1, V4_TICK_LOWER, V4_TICK_UPPER and optional
// V4_TOKEN1_SYMBOL (the symbol of the STABLE token, whichever currency it is). Bad or partial vars fall back to the
// defaults as a whole. No floats anywhere: prices are decimal strings, always "stable per unit".
import { bytesToHex, hexToBytes, keccak256 } from './keccak.ts';

export const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';

export type V4Token = { address: string; symbol: string; decimals: number };
export type V4PoolConfig = {
  chainId: number;
  poolManager: string;
  poolId: string;
  // keccak256(abi.encode(poolId, uint256(6))): base of Pool.State in PoolManager._pools (slot0 at +0, liquidity at +3).
  stateSlot: string;
  token0: V4Token;
  token1: V4Token;
  unitIsToken0: boolean; // which currency is the unit token; the other one is the stable token
  fee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
};
export type V4PoolVars = {
  V4_POOL_ID?: unknown; V4_TOKEN0?: unknown; V4_TOKEN1?: unknown;
  V4_TICK_LOWER?: unknown; V4_TICK_UPPER?: unknown; V4_TOKEN1_SYMBOL?: unknown;
};

// The unit token stays tIP16P across re-pools; only the stable side changes.
export const UNIT_TOKEN: V4Token = { address: '0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A', symbol: 'tIP16P', decimals: 6 };
const STABLE_DECIMALS = 6;
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const FEE = 3000;
const TICK_SPACING = 60;
const MAX_TICK = 887272;

// Current pool: mUSDG (stable, currency0) / tIP16P (unit, currency1). The retired mUSDC pool is only reachable by vars.
export const DEFAULT_POOL: V4PoolConfig = Object.freeze({
  chainId: 46630,
  poolManager: POOL_MANAGER,
  poolId: '0xafede3281589f6c8d26792dc3bd81603bb9ccc5ea77ce2dd97f70dbcaf5d5a54',
  stateSlot: '0x2c06a2b62b70da3a4d7551113aa826f03a01355f7b8d671389058485389cce75',
  token0: Object.freeze({ address: '0x0B71c1B397A9d33198e0A6a5701E12011AC84D95', symbol: 'mUSDG', decimals: STABLE_DECIMALS }),
  token1: Object.freeze({ ...UNIT_TOKEN }),
  unitIsToken0: false,
  fee: FEE,
  tickSpacing: TICK_SPACING,
  tickLower: -28080,
  tickUpper: -19860,
}) as V4PoolConfig;
// Back-compat name for the default pool.
export const POOL = DEFAULT_POOL;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const INT = /^-?(0|[1-9][0-9]{0,6})$/;
const SYMBOL = /^[A-Za-z0-9._-]{1,16}$/;
const word = (n: bigint): string => n.toString(16).padStart(64, '0');

/** keccak256(abi.encode(poolId, uint256(6))) */
export function stateSlotFor(poolId: string): string {
  return bytesToHex(keccak256(hexToBytes('0x' + poolId.slice(2).toLowerCase() + word(6n))));
}

/** keccak256(abi.encode(PoolKey(currency0, currency1, 3000, 60, address(0)))) */
export function poolIdFor(token0: string, token1: string): string {
  return bytesToHex(keccak256(hexToBytes('0x' + word(BigInt(token0)) + word(BigInt(token1)) + word(BigInt(FEE)) + word(BigInt(TICK_SPACING)) + word(0n))));
}

// wrangler vars may be strings or JSON numbers (ticks)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : '');
const parseTick = (v: string): number | null => {
  if (!INT.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && Math.abs(n) <= MAX_TICK && n % TICK_SPACING === 0 ? n : null;
};

export type ResolvedPool = { config: V4PoolConfig; source: 'default' | 'vars' | 'default (invalid vars)' };

function build(vars: V4PoolVars): V4PoolConfig | null {
  const poolId = str(vars.V4_POOL_ID); const t0 = str(vars.V4_TOKEN0); const t1 = str(vars.V4_TOKEN1);
  const lo = parseTick(str(vars.V4_TICK_LOWER)); const hi = parseTick(str(vars.V4_TICK_UPPER));
  if (!BYTES32.test(poolId) || !ADDRESS.test(t0) || !ADDRESS.test(t1) || lo === null || hi === null || lo >= hi) return null;
  if (BigInt(t0) >= BigInt(t1)) return null; // v4 sorts currencies: currency0 < currency1
  const unit = BigInt(UNIT_TOKEN.address);
  const unitIsToken0 = BigInt(t0) === unit;
  if (!unitIsToken0 && BigInt(t1) !== unit) return null; // one side must be the unit token
  if (poolIdFor(t0, t1) !== poolId.toLowerCase()) return null; // the id must be the hash of this key
  const sym = str(vars.V4_TOKEN1_SYMBOL);
  const stable: V4Token = { address: unitIsToken0 ? t1 : t0, symbol: SYMBOL.test(sym) ? sym : 'STABLE', decimals: STABLE_DECIMALS };
  const unitTok: V4Token = { ...UNIT_TOKEN, address: unitIsToken0 ? t0 : t1 };
  return {
    chainId: DEFAULT_POOL.chainId, poolManager: POOL_MANAGER, poolId, stateSlot: stateSlotFor(poolId),
    token0: unitIsToken0 ? unitTok : stable, token1: unitIsToken0 ? stable : unitTok, unitIsToken0,
    fee: FEE, tickSpacing: TICK_SPACING, tickLower: lo, tickUpper: hi,
  };
}

let memo: { key: string; value: ResolvedPool } | null = null;

/** Pool config from the vars, or the defaults when none of the pool vars is set or any of them is invalid. */
export function resolvePoolConfig(vars: V4PoolVars | null | undefined): ResolvedPool {
  const v = vars ?? {};
  const fields = [v.V4_POOL_ID, v.V4_TOKEN0, v.V4_TOKEN1, v.V4_TICK_LOWER, v.V4_TICK_UPPER].map(str);
  if (fields.every((f) => f === '')) return { config: DEFAULT_POOL, source: 'default' };
  const key = [...fields, str(v.V4_TOKEN1_SYMBOL)].join('|');
  if (memo?.key === key) return memo.value;
  const built = build(v);
  const value: ResolvedPool = built ? { config: built, source: 'vars' } : { config: DEFAULT_POOL, source: 'default (invalid vars)' };
  memo = { key, value };
  return value;
}

export const unitToken = (cfg: V4PoolConfig = POOL): V4Token => (cfg.unitIsToken0 ? cfg.token0 : cfg.token1);
export const stableToken = (cfg: V4PoolConfig = POOL): V4Token => (cfg.unitIsToken0 ? cfg.token1 : cfg.token0);

export const EXTSLOAD_SELECTOR = '0x1e2eaeaf'; // extsload(bytes32)
const MASK_160 = (1n << 160n) - 1n;
const MASK_128 = (1n << 128n) - 1n;
const MASK_24 = (1n << 24n) - 1n;

function wordToBigInt(w: string): bigint {
  if (typeof w !== 'string' || !BYTES32.test(w)) throw new Error('bad word');
  return BigInt(w);
}

export type Slot0 = { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number };

// slot0 layout (low to high): sqrtPriceX96 160 bits | tick int24 | protocolFee uint24 | lpFee uint24.
export function decodeSlot0(w: string): Slot0 {
  const n = wordToBigInt(w);
  const sqrtPriceX96 = n & MASK_160;
  const tick = Number(BigInt.asIntN(24, (n >> 160n) & MASK_24));
  const protocolFee = Number((n >> 184n) & MASK_24);
  const lpFee = Number((n >> 208n) & MASK_24);
  return { sqrtPriceX96, tick, protocolFee, lpFee };
}

// Active liquidity is a uint128 stored in the low bits of the word at stateSlot + 3.
export function decodeLiquidity(w: string): bigint {
  return wordToBigInt(w) & MASK_128;
}

export function liquiditySlot(cfg: V4PoolConfig = POOL): string {
  return '0x' + (BigInt(cfg.stateSlot) + 3n).toString(16).padStart(64, '0');
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const fmt6 = (scaled: bigint): string => (scaled / 1_000_000n).toString() + '.' + (scaled % 1_000_000n).toString().padStart(6, '0');

// Price of currency0 in currency1 = (sqrtPriceX96 / 2^96)^2, rounded half up at 6 places (raw units).
export function priceToken1PerToken0(sqrtPriceX96: bigint): string {
  if (sqrtPriceX96 < 0n) throw new Error('bad sqrtPriceX96');
  return fmt6((sqrtPriceX96 * sqrtPriceX96 * 1_000_000n + (1n << 191n)) >> 192n);
}

// Stable per unit in human units, rounded half up at 6 places, for either currency order:
//   unit = currency0: (sqrtP^2 / 2^192) * 10^(decUnit - decStable)
//   unit = currency1: (2^192 / sqrtP^2) * 10^(decUnit - decStable)
export function priceStablePerUnit(sqrtPriceX96: bigint, cfg: V4PoolConfig = POOL): string {
  if (sqrtPriceX96 <= 0n) throw new Error('bad sqrtPriceX96');
  const d = unitToken(cfg).decimals - stableToken(cfg).decimals;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  let num = cfg.unitIsToken0 ? sq * 1_000_000n : (1n << 192n) * 1_000_000n;
  let den = cfg.unitIsToken0 ? 1n << 192n : sq;
  if (d >= 0) num *= pow10(d); else den *= pow10(-d);
  return fmt6((num + den / 2n) / den);
}

// Lower bound inclusive, upper bound exclusive (a tick at tickUpper has no active liquidity).
export function isTickInRange(tick: number, cfg: V4PoolConfig = POOL): boolean {
  return tick >= cfg.tickLower && tick < cfg.tickUpper;
}

export function explorerAddress(address: string): string {
  return EXPLORER + '/address/' + address;
}
