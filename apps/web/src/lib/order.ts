// Sealed-order helpers for the browser: build the commit hash exactly as BlindBook does, keep the secret salt locally until the reveal,
// validate before anything is sent, and read the order index back from the commit receipt. No React, no config: unit tested.
import { encodeAbiParameters, keccak256, parseEventLogs, type Hex } from 'viem';
import { BOOK_ABI } from './book-abi.ts';

export type SealedOrder = { market: Hex; epoch: number; trader: Hex; side: 0 | 1; price: number; units: number; salt: Hex };
export type StoredOrder = SealedOrder & { index?: number; commitTx?: Hex; revealTx?: Hex; createdAt: number };

/** keccak256(abi.encode(market, epoch, trader, side, price, units, salt)): identical to the contract's commit check. */
export function commitHash(o: SealedOrder): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    [o.market, BigInt(o.epoch), o.trader, o.side, BigInt(o.price), BigInt(o.units), o.salt]));
}
/** 256 random bits. The salt is what makes a commitment hiding: with a weak salt anyone could brute-force price and size. */
export function newSalt(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): Hex {
  return ('0x' + [...rand(32)].map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

export const LIMITS = { maxPriceCents: 1_000_000, maxUnits: 1_000_000, CENT: 10_000n, bondDefault: 2_000_000n };
/** Returns a plain-language problem, or null when the order can be sent. Mirrors the contract's own checks so nothing doomed reaches the wallet. */
export function validateOrder(o: { side: 0 | 1; price: number; units: number }, ctx: { tick: number; cashBase: bigint; unitsFree: bigint; bondBase: bigint }): string | null {
  if (!Number.isInteger(o.price) || o.price <= 0) return 'Enter a price in whole cents.';
  if (o.price > LIMITS.maxPriceCents) return 'Price is above the maximum.';
  if (o.price % ctx.tick !== 0) return `Price must be a multiple of ${ctx.tick} cent${ctx.tick > 1 ? 's' : ''}.`;
  if (!Number.isInteger(o.units) || o.units <= 0) return 'Enter a whole number of units.';
  if (o.units > LIMITS.maxUnits) return 'Size is above the maximum.';
  if (ctx.cashBase < ctx.bondBase) return `You need at least ${Number(ctx.bondBase) / 1e6} test tokens in the book for the sealing bond.`;
  if (o.side === 0) { const need = BigInt(o.price) * BigInt(o.units) * LIMITS.CENT; if (ctx.cashBase < need + ctx.bondBase) return `Buying ${o.units} at ${o.price}¢ reserves $${(Number(need) / 1e6).toFixed(2)} at reveal, plus the bond; you have $${(Number(ctx.cashBase) / 1e6).toFixed(2)} in the book.`; }
  else if (ctx.unitsFree < BigInt(o.units)) return `You hold ${ctx.unitsFree} units of this product in the book, not ${o.units}.`;
  return null;
}

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const k = (book: string, trader: string) => `robinize.sealed.${book.toLowerCase()}.${trader.toLowerCase()}`;
/** Salts live only in this browser. If they are lost the order can never be revealed and the bond is forfeited: the UI says so. */
export function saveOrder(store: Store | undefined, book: string, o: StoredOrder) {
  if (!store) return; try { const all = listOrders(store, book, o.trader).filter((x) => !(x.market === o.market && x.epoch === o.epoch && x.salt === o.salt)); store.setItem(k(book, o.trader), JSON.stringify([...all, o].slice(-200))); } catch { /* private mode */ }
}
export function listOrders(store: Store | undefined, book: string, trader: string): StoredOrder[] {
  try { return store ? (JSON.parse(store.getItem(k(book, trader)) ?? '[]') as StoredOrder[]) : []; } catch { return []; }
}
/** The index the contract assigned to this commit, from the transaction receipt's Committed event. */
export function indexFromReceipt(logs: any[], trader: string): number | undefined {
  const ev = parseEventLogs({ abi: BOOK_ABI, logs, eventName: 'Committed' }).find((e: any) => String(e.args.trader).toLowerCase() === trader.toLowerCase());
  return ev ? Number((ev as any).args.index) : undefined;
}
