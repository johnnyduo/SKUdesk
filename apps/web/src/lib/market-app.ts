// Binds the market store to this app (config from the deployment JSON) and exposes React hooks. One store per page, shared by all islands.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Hex } from 'viem';
import { createMarketStore, clockAt, type MarketConfig, type MarketState, type Schedule } from './market.ts';
import blindbook from '../data/blindbook.json';
import catalog from '../data/catalog.json';
import { CHAIN } from './run';
import keeperBots from '../data/keeper-bots.json';
import type { AgentRegistry } from './agents.ts';
import { walletLabel, pickDefaultMarket, settleSelection, isSettled, type WalletLabel, type Selection } from './market-view.ts';
import { indexedDbKV } from './market-cache';
import { symbolFromHash } from './asset-switcher.ts';
import { SNAPSHOT_URL } from './market-source.ts';

export const BOOK_ADDRESS = blindbook.book as Hex;
// Reading `indexedDB` can itself throw (SecurityError in a sandboxed iframe or a profile with storage blocked): the page then runs without the cache.
function browserKV(): MarketConfig['kv'] { try { return typeof indexedDB === 'undefined' ? undefined : indexedDbKV(); } catch { return undefined; } }
/**
 * Where the history comes from (market.ts chooseBase): the Worker snapshot (same origin) -> the IndexedDB cache -> the history baked
 * into the build -> the chain. The cache entry carries schema + snapshot version + chain + book + deploy block (market-cache.ts cacheId),
 * so a redeployed book never reads an old entry. `kv` is undefined where IndexedDB does not exist (the Astro build, Node); the store
 * uses the global fetch when `fetch` is not given.
 */
export const MARKET_CONFIG: MarketConfig = {
  chain: { id: CHAIN.id, name: CHAIN.name, rpc: CHAIN.rpc, explorer: CHAIN.explorer }, book: BOOK_ADDRESS, deployBlock: blindbook.deployBlock, catalog: catalog.markets as any,
  snapshotUrl: SNAPSHOT_URL,
  kv: browserKV(),
  loadSnapshot: () => import('../data/blindbook-history.json').then((m) => (m.default ?? m) as any),
};
export const marketStore = createMarketStore(MARKET_CONFIG);
/** The public keeper-bot registry (src/data/keeper-bots.json). It names wallets; it does not prove who controls them. */
export const KEEPER_BOTS = keeperBots as AgentRegistry;
/** The one display name for a trader wallet on /market: "Bot 1".."Bot 6" (with role) for registry bots, "Agent C" for any other wallet. */
export const labelWallet = (trader: string, traders: string[]): WalletLabel => walletLabel(trader, traders, KEEPER_BOTS);
let started = false;
/** The market bots trade only while someone is looking (they cost testnet ETH): tell the site this page is open. Best effort; a failure changes nothing. */
const ping = () => { try { if (document.visibilityState === 'hidden') return; if (!navigator.sendBeacon?.('/api/market/ping')) void fetch('/api/market/ping', { method: 'POST', keepalive: true }).then((r) => r.text()).catch(() => undefined); } catch { /* no network: nothing to do */ } };
const startOnce = () => { if (started || typeof window === 'undefined') return; started = true; marketStore.subscribe(settle); void marketStore.start(); ping(); setInterval(ping, 120_000); };

/** The whole market state: catalog, per-market history, fills, live books. Updates as new blocks arrive. */
export function useMarket(): MarketState {
  const s = useSyncExternalStore(marketStore.subscribe, marketStore.getState, marketStore.getState);
  useEffect(startOnce, []); return s;
}

// browser clock vs chain clock: the largest (block time - now) over recent samples is the best estimate (a block can only be older than now)
const samples: number[] = []; let lastSampledBlock = -1;
// one sample per NEW block (this runs on every render, several times a second; repeating one sample would flatten the window to the latest value)
function skewFrom(s: MarketState) { if (s.lastBlockTime && s.sampledAt && s.lastBlock !== lastSampledBlock) { lastSampledBlock = s.lastBlock; samples.push(s.lastBlockTime - s.sampledAt / 1000); if (samples.length > 20) samples.shift(); } return samples.length ? Math.max(-30, Math.min(30, Math.max(...samples))) : 0; }
/** Ticks 4x a second: current epoch, phase, seconds left and progress, aligned to the chain clock. null until the schedule is known. */
export function useClock(): (ReturnType<typeof clockAt> & { schedule: Schedule }) | null {
  const s = useMarket(); const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 250); return () => clearInterval(id); }, []);
  if (!s.schedule) return null; return { ...clockAt(s.schedule, Date.now() / 1000 + skewFrom(s)), schedule: s.schedule };
}

// Selected market, kept in the URL hash so a link opens the same market. Which one opens first (pickDefaultMarket): the #hash symbol,
// else the first market that has a clearing price (so the page never opens empty while other markets have data), else the first.
// The pick is decided once; `locked` stops any later state from moving the selection (a valid hash, a user choice, a decided pick).
const listeners = new Set<() => void>(); const catalogMarkets = catalog.markets as { symbol: string }[];
// a malformed percent-escape in the hash (#%E0%A4%A) used to throw here at module load and in the hashchange listener: now it names no market
const hashSymbol = () => (typeof window === 'undefined' ? '' : symbolFromHash(window.location.hash));
const withLast = (last: (symbol: string) => number) => catalogMarkets.map((m) => ({ symbol: m.symbol, last: last(m.symbol) }));
const explicitHash = () => catalogMarkets.some((m) => m.symbol === hashSymbol());
let sel: Selection = { index: 0, locked: false };
const notify = () => listeners.forEach((f) => f());
function settle() {   // store listener (see startOnce)
  const s = marketStore.getState(); const next = settleSelection(sel, s.markets, s.ready);
  if (next.index !== sel.index || next.locked !== sel.locked) { sel = next; notify(); }
}
if (typeof window !== 'undefined') {
  if (explicitHash()) sel = { index: pickDefaultMarket(withLast(() => 0), hashSymbol()), locked: true };
  window.addEventListener('hashchange', () => { sel = { index: pickDefaultMarket(marketStore.getState().markets, hashSymbol()), locked: true }; notify(); });
}
export function selectMarket(i: number) { sel = { index: i, locked: true }; if (typeof window !== 'undefined') history.replaceState(null, '', '#' + catalogMarkets[i].symbol); notify(); }
/** The selected catalog index right now (outside React: event listeners read it after market-app's own hashchange listener has run). */
export const selectedIndex = () => sel.index;
/** False until the default selection has settled (see isSettled): the panels show a neutral skeleton, no market identity. Always false on the server. */
export function useSelectionSettled(): boolean {
  const s = useMarket(); const locked = useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => sel.locked, () => false);
  const serverOrHydrating = useSyncExternalStore(() => () => undefined, () => false, () => true);   // the server render and the hydration pass see the skeleton, so markup matches
  return !serverOrHydrating && isSettled(settleSelection({ index: sel.index, locked }, s.markets, s.ready), s.ready, explicitHash());
}
export function useSelectedMarket(): { index: number; marketId: Hex; info: MarketState['markets'][number]; select: (i: number) => void } {
  const s = useMarket(); const i = useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => sel.index, () => 0);
  return { index: i, marketId: s.markets[i].marketId, info: s.markets[i], select: selectMarket };
}
