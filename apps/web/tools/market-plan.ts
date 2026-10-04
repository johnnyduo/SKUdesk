// Pure keeper planning: which catalog markets the keeper quotes in one epoch, the order sizes per bot role, and how much book cash a
// buyer bot can spend in one supervisor batch. No I/O, no viem, so test/market/keeper-plan.test.ts can pin it; tools/market-common.ts
// (fairCents, plansFor, activeMarkets), tools/keeper.ts and tools/market-setup.ts use it. Never changes what was already traded on-chain.
import { LOTS, type Lot } from '../src/lib/catalog.ts';

/** fairCents: x_k = FAIR_DECAY * x_(k-1) + u * FAIR_STEP with u in [-1, 1], fair = reference * (1 + x), so |x| < FAIR_STEP / (1 - FAIR_DECAY). */
export const FAIR_DECAY = 0.97;
export const FAIR_STEP = 0.004;
/** plansFor: the highest bid any buyer bot places, relative to the fair value (takers and noise traders bid up to +1.5 %). */
export const MAX_BUY_PREMIUM = 0.015;
/** The highest price a buyer bot can ever bid, relative to the reference price. */
export const BUY_PRICE_MAX = (1 + FAIR_STEP / (1 - FAIR_DECAY)) * (1 + MAX_BUY_PREMIUM);
/** The commit bond in cents (BlindBook bond 2,000,000 base units = 2 tokens); a noise bot that does not reveal forfeits it. */
export const BOND_CENTS = 200;

export type Role = 'maker' | 'taker' | 'noise';
/** keeper bot index -> role: 0/3 patient makers, 1/4 aggressive takers, 2/5 noise traders (bots 0-2 buy, 3-5 sell). */
export const ROLE_OF_BOT: readonly Role[] = ['maker', 'taker', 'noise', 'maker', 'taker', 'noise'];
/** Units per order [lo, hi] for one bot on one market. */
export const unitsRange = (lot: Lot, bot: number): readonly [number, number] => LOTS[lot][ROLE_OF_BOT[bot]];

/**
 * `count` distinct pool entries per epoch in a plain round robin that advances `count` places per epoch, so every listed market is quoted
 * at least once every ceil(pool.length / count) epochs (18 markets, 1 per epoch: every 18 epochs, 13.5 minutes at 45 s epochs). No market is privileged:
 * with one market per epoch (the default, because of the bots' gas) a fixed hero would starve all others.
 */
export function rotation(epoch: number, count: number, pool: readonly number[]): number[] {
  if (!pool.length || !(count >= 1) || !Number.isFinite(epoch)) return [];
  const n = pool.length, k = Math.min(Math.floor(count), n), out: number[] = [];
  for (let j = 0; j < k; j++) out.push(pool[(((Math.floor(epoch) * k + j) % n) + n) % n]);
  return out;
}

/**
 * The markets quoted in `epoch` when the keeper acts only in every `every`th epoch (--every): none in an idle epoch, otherwise the
 * rotation advanced once per ACTED epoch. Rotating on the raw epoch number would alias with `every` and starve half the pool.
 * `pinned` (--pin, catalog indices): the pinned markets that are in the pool are quoted in EVERY acted epoch and the other `count - pins`
 * slots rotate over the rest of the pool (so --markets 1 --pin X is X only; more pins than --markets quotes all pins and nothing rotates).
 */
export function quotedMarkets(epoch: number, every: number, count: number, pool: readonly number[], pinned: readonly number[] = []): number[] {
  const n = Number.isFinite(every) && every >= 1 ? Math.floor(every) : 1;
  if (epoch % n !== 0) return [];
  const acted = Math.floor(epoch / n);
  const pins = [...new Set(pinned)].filter((i) => pool.includes(i));
  if (!pins.length) return rotation(acted, count, pool);
  if (!Number.isFinite(epoch) || !(count >= 1)) return [];
  return [...pins, ...rotation(acted, Math.floor(count) - pins.length, pool.filter((i) => !pins.includes(i)))];
}

/** The longest wait, in acted epochs, between two quotes of one NON-pinned market under `quotedMarkets` (Infinity when no slot rotates). */
export function maxGap(poolSize: number, count: number, pinnedCount = 0): number {
  const rest = poolSize - pinnedCount, slots = Math.floor(count) - pinnedCount;
  if (poolSize < 1 || !(count >= 1) || rest < 1) return rest < 1 && poolSize >= 1 && count >= 1 ? 1 : Infinity;
  return slots < 1 ? Infinity : Math.ceil(rest / Math.min(slots, rest));
}

/** Splits the repeatable / comma-separated `--pin` values out of an argv list: `--pin A --pin B,C` -> [A, B, C]. */
export function parsePins(argv: readonly string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => { if (a === '--pin' && i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.push(...argv[i + 1].split(',').map((x) => x.trim()).filter(Boolean)); });
  return out;
}

/**
 * Resolves `--pin` symbols (case-insensitive) to catalog indices, duplicates dropped. An unknown symbol throws before anything is sent;
 * a catalog market that is not in `pool` (not listed on the book yet) is returned in `unlisted` (the caller warns and ignores it).
 */
export function resolvePins(requested: readonly string[], catalog: readonly { symbol: string }[], pool?: readonly number[]): { pinned: number[]; unlisted: string[] } {
  const pinned: number[] = [], unknown: string[] = [];
  for (const r of requested) {
    const i = catalog.findIndex((m) => m.symbol.toLowerCase() === r.toLowerCase());
    if (i < 0) unknown.push(r); else if (!pinned.includes(i)) pinned.push(i);
  }
  if (unknown.length) throw new Error(`unknown --pin symbol ${unknown.join(', ')} (catalog symbols: ${catalog.map((m) => m.symbol).join(', ')})`);
  return { pinned, unlisted: pool ? pinned.filter((i) => !pool.includes(i)).map((i) => catalog[i].symbol) : [] };
}

/** How often ONE market is quoted in `epochs` acted epochs with `perEpoch` markets per epoch over `poolSize` markets, `pinnedCount` of them pinned. */
export function quotesOf(epochs: number, perEpoch: number, poolSize: number, pinnedCount = 0, isPinned = false): number {
  const k = Math.floor(perEpoch);
  if (pinnedCount <= 0) return Math.ceil((epochs * Math.min(k, poolSize)) / poolSize);
  if (isPinned) return epochs;
  const rest = poolSize - pinnedCount, slots = Math.min(k - pinnedCount, rest);
  return rest < 1 || slots < 1 ? 0 : Math.ceil((epochs * slots) / rest);
}

/**
 * The most book cash (cents) any ONE buyer bot can spend in `epochs` epochs with `perEpoch` markets quoted per epoch, if every one of its
 * orders filled completely at its own bid: each market is quoted at most ceil(epochs * k / n) times (a pinned market, --pin, in every epoch and the rest over the remaining slots); per quote the bot bids at most its
 * lot's largest order at BUY_PRICE_MAX times the reference; every order also risks its bond.
 */
export function worstBuyerSpendCents(markets: readonly { referenceCents: number; lot: Lot }[], epochs: number, perEpoch: number, pinned: readonly number[] = []): number {
  const n = markets.length; if (!n || epochs <= 0 || perEpoch < 1) return 0;
  const pins = [...new Set(pinned)].filter((i) => i >= 0 && i < n);
  let worst = 0;
  for (const bot of [0, 1, 2]) {
    let s = 0;
    markets.forEach((m, i) => { s += quotesOf(epochs, perEpoch, n, pins.length, pins.includes(i)) * (unitsRange(m.lot, bot)[1] * Math.ceil(m.referenceCents * BUY_PRICE_MAX) + BOND_CENTS); });
    worst = Math.max(worst, s);
  }
  return worst;
}

/** Book cash target per bot, in whole tokens: the worst case plus 25 %, rounded up to 10,000, never below the original 50,000. */
export function cashTargetTokens(markets: readonly { referenceCents: number; lot: Lot }[], epochs: number, perEpoch: number, pinned: readonly number[] = []): number {
  const tokens = (worstBuyerSpendCents(markets, epochs, perEpoch, pinned) * 1.25) / 100;
  return Math.max(50_000, Math.ceil(tokens / 10_000) * 10_000);
}

/** Inventory units a seller bot is topped up to, per market: 50 batches of its largest sale, never below the lot's floor (the bulk floor is the original target). */
export const SELLER_UNITS_FLOOR: Record<Lot, number> = { bulk: 20_000, unit: 1_000 };
export function sellerUnitsTarget(lot: Lot, epochs: number, perEpoch: number, poolSize: number, pinnedCount = 0, isPinned = false): number {
  if (!(epochs > 0) || !(perEpoch >= 1) || poolSize < 1) return SELLER_UNITS_FLOOR[lot];
  const quotes = quotesOf(epochs, perEpoch, poolSize, pinnedCount, isPinned);
  const largest = Math.max(...[3, 4, 5].map((bot) => unitsRange(lot, bot)[1]));
  return Math.max(SELLER_UNITS_FLOOR[lot], quotes * largest * 50);
}

/** The catalog markets whose `listed` flag on the book is false, in catalog order (what tools/market-setup.ts lists). */
export function marketsToList<T>(catalog: readonly T[], listed: readonly boolean[]): T[] {
  if (catalog.length !== listed.length) throw new Error('marketsToList needs one listed flag per market');
  return catalog.filter((_, i) => !listed[i]);
}
