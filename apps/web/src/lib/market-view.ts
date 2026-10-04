// Pure helpers for the /market page's honesty labels and the "Agents in this round" cards (no React, no chain access).
import type { Provenance } from './provenance.ts';
import { botFor, type AgentRegistry } from './agents.ts';
import { fmtUsdCents } from './market-fmt.ts';
import { ACCESSORY_PRICE_BASIS } from './catalog.ts';

/** The one line printed next to the chart title. Keep it in one place: the page and the tests quote it. */
export const PRICE_SCOPE = 'Clearing price of test units on BlindBook (testnet). Not a retail price, not the Uniswap v4 pool price.';

export type SourceInput = { ready: boolean; error?: string; snapshotHead?: number };
export type DataSource = { kind: Extract<Provenance, 'onchain' | 'snapshot'>; note?: string; history?: string };

/**
 * Where the numbers on screen come from right now.
 * - connected: they were read from the contract's events (a stored copy covers older blocks, the RPC the rest) -> onchain
 * - the RPC reported an error: nothing new can arrive, what is shown is frozen at the last read -> snapshot
 * - still loading: null (no chip yet)
 */
export function dataSource(s: SourceInput): DataSource | null {
  if (!s.ready) return null;
  const history = s.snapshotHead ? `History up to block ${s.snapshotHead.toLocaleString('en-US')} is a stored copy of chain events. Newer blocks are read live.` : undefined;
  if (s.error) return { kind: 'snapshot', note: 'RPC lost', history };
  return { kind: 'onchain', note: s.snapshotHead ? 'stored + live' : undefined, history };
}

/** The store gave up with nothing loaded (it forces ready so the page can say so). Panels then keep their skeletons under the error
 *  banner and never claim "no trade yet" or "no fills": nothing is known about the market. */
export function loadFailed(s: { error?: string; markets: { last: number }[]; clears: Record<string, unknown> }): boolean {
  return !!s.error && s.markets.every((m) => !m.last) && Object.keys(s.clears).length === 0;
}

/** The error to show where the epoch history should be: the store's `error` is also set by two failed live polls, which says nothing about the
 *  history. It counts only when the history itself could not be read: nothing loaded (loadFailed) AND the history never completed. A fully
 *  loaded market that has no clear yet, with failed polls, is just empty. */
export function historyReadError(s: { error?: string; historyComplete: boolean; markets: { last: number }[]; clears: Record<string, unknown> }): string | undefined {
  return loadFailed(s) && !s.historyComplete ? s.error : undefined;
}

/** The market the page opens on: (1) the #hash symbol when it names a catalog market (an explicit link is never overridden),
 *  (2) else the first market in catalog order with a last cleared price, (3) else index 0. */
export function pickDefaultMarket(markets: { symbol: string; last: number }[], hash: string): number {
  const h = markets.findIndex((m) => m.symbol === hash); if (h >= 0) return h;
  const t = markets.findIndex((m) => m.last > 0); return t >= 0 ? t : 0;
}
export type Selection = { index: number; locked: boolean };
/** Applied to every store state until `locked` (a valid #hash, a user choice, or the first pick that found a traded market): decides
 *  once, on the first ready state in which some market has cleared; while nothing has traded it stays on index 0 and looks again. */
export function settleSelection(cur: Selection, markets: { symbol: string; last: number }[], ready: boolean): Selection {
  if (cur.locked || !ready || !markets.some((m) => m.last > 0)) return cur;
  return { index: pickDefaultMarket(markets, ''), locked: true };
}
/** True once the page may show a market's identity: an explicit valid #hash (settled at once), a locked selection (a choice or a decided
 *  pick), or a ready store (nothing has traded anywhere, so index 0 is the honest answer). Before that the terminal shows a neutral
 *  skeleton instead of a guessed market that would swap a moment later. `cur` is the selection AFTER settleSelection for this state. */
export const isSettled = (cur: Selection, ready: boolean, explicitHash: boolean): boolean => explicitHash || cur.locked || ready;

/** The caption under the hero price: who sets the price, around which reference, and that the token is a test token. The accessory basis
 *  already carries a bracket, so it is rephrased instead of nested; a dated list price reads as "(US list price, as of Oct 2026)". */
export function priceSourceLine(m: { referenceCents: number; priceBasis: string }): string {
  const ref = fmtUsdCents(m.referenceCents);
  const what = m.priceBasis === ACCESSORY_PRICE_BASIS ? `${ref} catalog reference price (fixed snapshot, not a live feed)` : `${ref} reference (${m.priceBasis})`;
  return `Price set by scripted bots around a ${what}. Test token (mUSDG), not a live market price.`;
}

/** Catalog price source -> chip kind: 'snapshot' is a recorded value, anything else ('catalog') is a placeholder entry. */
export const refSourceKind = (source: string): Extract<Provenance, 'snapshot' | 'test'> => (source === 'snapshot' ? 'snapshot' : 'test');

/** Stable letter for the n-th wallet seen on chain: A, B, ... Z, AA, AB ... */
export function walletLetter(n: number): string {
  let s = ''; let k = n;
  do { s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0);
  return s;
}
/** "Agent A" from the wallet's position in `traders` (lowercase addresses in first-seen order). Unknown wallets get "Agent ?".
 *  With `bots` (the keeper-bot registry) the letters count only the NON-registry wallets, so the first other wallet is "Agent A" however
 *  many bots came before it (bots are named "Bot N", they do not use up letters). */
export function agentLabel(trader: string, traders: string[], bots?: AgentRegistry): string {
  const a = trader.toLowerCase(); const i = traders.indexOf(a); if (i < 0) return 'Agent ?';
  const before = bots ? traders.slice(0, i).filter((t) => !botFor(t, bots)).length : i;
  return `Agent ${walletLetter(before)}`;
}

/** 0x1234…abcd (anything 12 characters or shorter is returned as is). */
export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export type WalletLabel = { address: string; name: string; short: string; bot: boolean; role?: string };
/**
 * The one display name for a trader wallet on /market (Agents in this round, sealed-book chips, the trade tape, recent results).
 * A wallet in the keeper-bot registry (src/data/keeper-bots.json) gets its registry name ("Bot 1") and scripted role; every other
 * wallet gets a letter in first-seen order among the non-registry wallets ("Agent C", agentLabel). The registry matches addresses: it names a wallet, it is not proof.
 */
export function walletLabel(trader: string, traders: string[], bots?: AgentRegistry): WalletLabel {
  const address = trader.toLowerCase(); const b = bots ? botFor(address, bots) : undefined;
  return b ? { address, name: b.name, short: shortAddr(address), bot: true, role: b.role } : { address, name: agentLabel(address, traders, bots), short: shortAddr(address), bot: false };
}

/** The bond is in 6-decimal token units: 2000000 -> "2.00". */
export const bondTokens = (base: number) => (base / 1e6).toFixed(2);

export type OrderState = 'sealed' | 'revealed' | 'filled' | 'partial' | 'unmatched' | 'forfeited';
/** committed / revealed / matched / not matched. An order that was never revealed is "not matched" (its bond is forfeited). */
export function statusWord(state: OrderState): 'committed' | 'revealed' | 'matched' | 'not matched' {
  switch (state) { case 'sealed': return 'committed'; case 'revealed': return 'revealed'; case 'filled': case 'partial': return 'matched'; default: return 'not matched'; }
}
/** What happened to this order's bond. The contract refunds it at reveal and sends it to the treasury if the order is never revealed. */
export function bondNote(state: OrderState, bond: number): string {
  const t = bond ? ` ${bondTokens(bond)} mUSDG` : '';
  if (state === 'sealed') return `bond locked${t}`;
  if (state === 'forfeited') return `bond forfeited${t}`;
  return 'bond returned at reveal';
}

export type CardChip = { index: number; trader: string; state: OrderState; side?: 0 | 1; price?: number; units?: number; filled?: number };
export type AgentOrder = { index: number; state: OrderState; word: ReturnType<typeof statusWord>; side?: 0 | 1; price?: number; units?: number; filled?: number; bond: string };
export type AgentCard = { trader: string; label: string; bot: boolean; role?: string; orders: AgentOrder[] };

/** One card per wallet that committed in this epoch (a wallet with several orders gets all of them on its card), in first-seen wallet order.
 *  With `bots`, registry keeper bots are named "Bot N" and carry their role (walletLabel). */
export function agentCards(chips: CardChip[], traders: string[], bond: number, bots?: AgentRegistry): AgentCard[] {
  const by = new Map<string, AgentCard>();
  for (const c of chips) {
    const k = c.trader.toLowerCase(); let card = by.get(k);
    if (!card) { const w = walletLabel(c.trader, traders, bots); card = { trader: c.trader, label: w.name, bot: w.bot, role: w.role, orders: [] }; by.set(k, card); }
    card.orders.push({ index: c.index, state: c.state, word: statusWord(c.state), side: c.side, price: c.price, units: c.units, filled: c.filled, bond: bondNote(c.state, bond) });
  }
  const rank = (t: string) => { const i = traders.indexOf(t.toLowerCase()); return i < 0 ? Infinity : i; };
  return [...by.values()].sort((a, b) => rank(a.trader) - rank(b.trader) || a.orders[0].index - b.orders[0].index);
}
