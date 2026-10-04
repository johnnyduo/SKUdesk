// Shared plumbing for the market tools (setup and keeper): config, clients, bot wallets, deterministic fair value and strategies.
import { createPublicClient, createWalletClient, http, defineChain, keccak256, toHex, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import path from 'node:path';
import { FAIR_DECAY, FAIR_STEP, parsePins, quotedMarkets, resolvePins, unitsRange } from './market-plan.ts';
import type { Lot } from '../src/lib/catalog.ts';

export const arg = (k: string, d?: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
export const CHAIN_ID = Number(arg('chain', process.env.CHAIN_ID ?? '46630'));
export const RPC = arg('rpc', process.env.ROBINHOOD_RPC)!;
export const chain = defineChain({ id: CHAIN_ID, name: 'robinize-' + CHAIN_ID, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 20_000 }) });
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
export const book = readJson(`../../packages/contracts/deployments/blindbook-${CHAIN_ID}.json`) as { book: Hex; token: Hex; deployBlock: number; t0: number; epochLen: number; commitEnd: number; revealEnd: number; bond: number };
export const BOOK = getAddress(book.book); export const TOKEN = getAddress(book.token);
/** The schedule in deployments/*.json comes from forge's pre-broadcast SIMULATION, so t0 can be several seconds off the real deploy block.
 *  Always read the schedule from the contract itself. */
export async function loadSchedule() {
  const abi = [{ type: 'function', name: 't0', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'epochLen', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'commitEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'revealEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'bond', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const;
  const [t0, epochLen, commitEnd, revealEnd, bond] = await Promise.all((['t0', 'epochLen', 'commitEnd', 'revealEnd', 'bond'] as const).map((fn) => pub.readContract({ address: BOOK, abi, functionName: fn }))) as bigint[];
  book.t0 = Number(t0); book.epochLen = Number(epochLen); book.commitEnd = Number(commitEnd); book.revealEnd = Number(revealEnd); book.bond = Number(bond);
}
export type Market = { id: string; symbol: string; name: string; referenceCents: number; lot: Lot; tick: number; marketId: Hex };
export const CATALOG = (readJson('src/data/catalog.json').markets as any[]).map((m) => ({ ...m, marketId: keccak256(toHex(m.id)) })) as Market[];
export const wallet = (key: Hex) => { const account = privateKeyToAccount(key); return { account, client: createWalletClient({ account, chain, transport: http(RPC, { timeout: 20_000 }) }) }; };
export const ownerKey = () => { const k = process.env.DEPLOYER_PRIVATE_KEY as Hex; if (!k) throw new Error('DEPLOYER_PRIVATE_KEY missing'); return k; };
export const botKeys = (): Hex[] => { const v = process.env.BOT_PRIVATE_KEYS; if (!v) throw new Error('BOT_PRIVATE_KEYS missing (run market-setup.ts --generate first)'); return v.split(',').map((s) => s.trim() as Hex); };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now() / 1000;
export const usd = (cents: number | bigint) => '$' + (Number(cents) / 100).toFixed(2);

// deterministic fair value: the recorded reference price plus a mean-reverting random walk seeded by (market, epoch).
// Anyone can recompute it; it is a simulation input, NOT a market feed, and the UI says so.
const h01 = (s: string) => Number(BigInt(keccak256(toHex(s))) % 2_000_001n) / 1_000_000 - 1; // uniform in [-1, 1]
export function fairCents(m: Market, epoch: number): number {
  let x = 0; const start = Math.max(0, epoch - 400); // bounded history keeps it cheap and still smooth
  for (let k = start; k <= epoch; k++) x = x * FAIR_DECAY + h01(`${m.id}:${k}`) * FAIR_STEP;
  return Math.max(1, Math.round(m.referenceCents * (1 + x)));
}

// bot strategies. All randomness is derived from (epoch, bot, market), so a run is reproducible.
export type Plan = { bot: number; marketIdx: number; side: 0 | 1; price: number; units: number };
const rnd = (seed: string) => Number(BigInt(keccak256(toHex(seed))) % 1_000_001n) / 1_000_000; // [0,1]
/** bots 0-2 buy, bots 3-5 sell. 0/3: patient makers (inside the spread), 1/4: aggressive takers (cross it), 2/5: noise traders. */
export function plansFor(m: Market, mIdx: number, epoch: number): Plan[] {
  const fair = fairCents(m, epoch); const out: Plan[] = [];
  const px = (bot: number, mult: number) => Math.max(m.tick, Math.round((fair * mult) / m.tick) * m.tick);
  const r = (bot: number, tag: string) => rnd(`${epoch}:${bot}:${m.id}:${tag}`);
  // order sizes come from the market's lot (src/lib/catalog.ts LOTS): devices trade 1-3 units, cheap items the original 3-24
  const units = (bot: number) => { const [lo, hi] = unitsRange(m.lot, bot); return lo + Math.floor(r(bot, 'u') * (hi - lo + 1)); };
  out.push({ bot: 0, marketIdx: mIdx, side: 0, price: px(0, 1 - (0.002 + r(0, 'p') * 0.004)), units: units(0) });
  out.push({ bot: 3, marketIdx: mIdx, side: 1, price: px(3, 1 + (0.002 + r(3, 'p') * 0.004)), units: units(3) });
  out.push({ bot: 1, marketIdx: mIdx, side: 0, price: px(1, 1 + (0.003 + r(1, 'p') * 0.012)), units: units(1) });
  out.push({ bot: 4, marketIdx: mIdx, side: 1, price: px(4, 1 - (0.003 + r(4, 'p') * 0.012)), units: units(4) });
  if (r(2, 'on') < 0.75) out.push({ bot: 2, marketIdx: mIdx, side: 0, price: px(2, 1 + (r(2, 'p') - 0.5) * 0.03), units: units(2) });
  if (r(5, 'on') < 0.75) out.push({ bot: 5, marketIdx: mIdx, side: 1, price: px(5, 1 + (r(5, 'p') - 0.5) * 0.03), units: units(5) });
  return out;
}
/** `count` markets per epoch in a round robin over `pool` (default: every catalog market; the keeper passes the LISTED ones), so every
 *  market trades at least every ceil(pool / count) acted epochs while the transactions per epoch stay bounded (market-plan.ts).
 *  `every` is the keeper's --every: the rotation advances once per acted epoch, so no market starves.
 *  `pinned` (catalog indices from --pin) are quoted in every acted epoch; the other slots rotate over the rest of the pool. */
export function activeMarkets(epoch: number, count: number, pool: readonly number[] = CATALOG.map((_, i) => i), every = 1, pinned: readonly number[] = []): number[] {
  return quotedMarkets(epoch, every, count, pool, pinned);
}
/** The `--pin SYMBOL` option (repeatable or comma list) resolved against the catalog. An unknown symbol is a clear error BEFORE anything is sent. */
export function pinsFromArgs(pool?: readonly number[]): { pinned: number[]; unlisted: string[] } {
  try { return resolvePins(parsePins(process.argv), CATALOG, pool); } catch (e: any) { console.error('ERROR:', e.message); process.exit(1); }
}
