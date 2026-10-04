// Market data store for the trading terminal. History comes from (newest that fits, see chooseBase) the Worker snapshot, the IndexedDB cache,
// or the history baked into the build (cold fallback); the rest, or everything, from the BlindBook contract's events read newest-first;
// then it polls the chain for new blocks. All event logic lives in
// market-core.ts (shared with the Worker), so every path folds the same events the same way. No React in this file.
//
// Rules this file keeps (each one is pinned by test/market/market-store.test.ts):
//   - A snapshot/cache base is used only if its schedule equals the on-chain schedule; it is hydrated ONCE into a fresh ledger and the
//     ledger is then fed only events above the base cursor. The gap (cursor, head] is ALWAYS read from the chain before `ready`.
//   - head, schedule, snapshot fetch and cache read start together; the base decision waits a bounded time (never on a hung IndexedDB).
//   - `ready` is the loader's readyFor rule (never from a stale or partial last price); older history keeps loading behind it.
//   - Failed ranges are retried with backoff here (the loader has none); a failed run never becomes an unhandled rejection. Once anything is
//     loaded, a failed range of OLD history only sets `historyError` (the page is not told the data is bad); `error` means nothing loaded or the RPC is down.
//   - Every poll re-reads the newest TRAIL_BLOCKS blocks again (see TRAIL_BLOCKS), and the cache is written TRAIL_BLOCKS behind the applied tip.
//   - The cache is written best-effort, off the hot path, never awaited before ready.
//   - The baked build-time history (cfg.snapshot / cfg.loadSnapshot) is validated like the other bases (market-baked.ts) and competes in
//     chooseBase; a failed load, another chain/book or a malformed file simply means no baked base.
//   - A getLogs range the node refuses as too large (its 10,000-log cap) is split in halves down to one block, never retried as is.
//     (These last two are pinned by test/market/market-baked.test.ts.)
import { createPublicClient, http, defineChain, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { BOOK_ABI } from './book-abi.ts';
import { clearBook, type BookOrder } from './book.ts';
import { MARKET_TOPICS, applyEvents, clearPoints, decodeLogs, fillRows, liveBooks, newLedger, stampTimes, summarize, traderOrder, bookKey, type ClearPoint, type CoreBook, type FillRow, type Ledger, type MarketEvent, type RawLog, type Schedule } from './market-core.ts';
import { hydrate, hotFrom, type MarketSnapshot } from './market-snap.ts';
import { createBackfill, isLimitError, planRanges, readyFor, splitOnLimit, type Backfill, type LoadProgress, type Range } from './market-loader.ts';
import { bakedSnapshot, type HistorySnapshot } from './market-baked.ts';
import { readCache, writeFitted, createCacheGate, CACHE_WRITE_EVERY_MS, type KV } from './market-cache.ts';
import { SNAPSHOT_TIMEOUT_MS, SNAPSHOT_URL, chooseBase, fetchSnapshot, type Base, type DataSource } from './market-source.ts';

export type { ClearPoint, FillRow, Schedule } from './market-core.ts';
export type { DataSource } from './market-source.ts';
export type { HistorySnapshot } from './market-baked.ts';
export type CatalogMarket = { id: string; symbol: string; name: string; category: string; subtitle: string; referenceCents: number; priceBasis: string; lot: string; tick: number; accent: string; source: string };
export type MarketConfig = {
  chain: { id: number; name: string; rpc: string; explorer: string }; book: Hex; deployBlock: number; catalog: CatalogMarket[];
  pollMs?: number; logChunk?: number;
  /** Same-origin snapshot endpoint; null skips it (static hosting). Default /api/market/snapshot. */
  snapshotUrl?: string | null;
  /** Persistent cache; omitted means no cache. */
  kv?: KV;
  fetch?: typeof fetch;
  /** Waits (ms) between attempts of one RPC request; the first attempt is the first entry. Default RETRY_WAITS_MS. */
  retryWaitsMs?: number[];
  /** Test seam: replaces market-snap's hydrate (to prove a base that fails to hydrate is skipped). */
  hydrateSnapshot?: (ledger: Ledger, snap: MarketSnapshot) => void;
  /** Build-time baked event history (tools/market-snapshot.ts): the cold fallback base, see market-baked.ts. */
  snapshot?: HistorySnapshot;
  /** Same as `snapshot`, fetched on demand (a dynamic import), so the 2 MB of baked history is not part of the page's main script. A rejection means: no baked base. */
  loadSnapshot?: () => Promise<HistorySnapshot>;
};
export type OrderRow = { index: number; trader: string; hash: string; side?: 0 | 1; price?: number; units?: number; filled?: number };
export type EpochBook = { marketId: string; epoch: number; orders: OrderRow[]; cleared?: ClearPoint };
export type MarketInfo = CatalogMarket & { marketId: Hex; last: number; lastEpoch: number; change: number; prices: number[] };
export type Phase = 'commit' | 'reveal' | 'clear';
export type MarketState = {
  ready: boolean; error?: string; schedule?: Schedule; markets: MarketInfo[];
  clears: Record<string, ClearPoint[]>; fills: FillRow[]; live: Record<string, EpochBook>; lastBlock: number; lastBlockTime: number; sampledAt: number; updatedAt: number;
  /** where the history came from, and whether every block back to the deployment is folded in */
  source: DataSource; historyComplete: boolean;
  /** Diagnostics only (the UI does not render it): why the OLDER history could not be loaded yet, while the page itself works. */
  historyError?: string;
  /**
   * Last block covered by the stored history copy (server snapshot, IndexedDB cache or the baked build-time history) that this load started from;
   * history up to there comes from it, newer blocks are read from the RPC. Undefined when the chain was the only source (source 'rpc').
   */
  snapshotHead?: number;
  /**
   * Every trader wallet seen so far (lowercase), ordered by the (block, logIndex) of its earliest KNOWN order (market-core traderOrder): gives each
   * wallet a stable label. The order is a pure function of the loaded events, so it does not depend on arrival order, but a wallet whose older orders
   * are not loaded yet sits where its earliest loaded order puts it: while older history is still backfilling (source 'rpc', historyComplete false)
   * the list can reorder. Once historyComplete is true it only grows at the end. Snapshot, cache and baked bases are complete, so they never reorder.
   */
  traders: string[];
};

/**
 * Blocks per getLogs request. main's old store used 50,000 (with splitting on the node's 10,000-log refusal); this store keeps 5,000 on purpose:
 * the backfill is newest-first and `ready` waits for the newest chunk, so a small first request paints the last prices sooner; a refused
 * 50,000-block request costs a wasted round trip before its halves are fetched; and the poll and the cache-freshness rule (one request behind)
 * use the same size. Splitting (splitOnLimit) still guards any chunk that turns out too dense. tools/market-snapshot.ts also uses 5,000.
 */
export const LOG_CHUNK = 5000;
export const BACKFILL_CONCURRENCY = 3;
export { CACHE_WRITE_EVERY_MS };
/** Attempts of one RPC request: immediately, then after 400 ms, 1.2 s and 3 s. */
export const RETRY_WAITS_MS = [0, 400, 1200, 3000];
/** How long, from the start, the base decision waits for the snapshot fetch (its full timeout) and the cache read (bounded by readCache itself) before it goes to the chain without them. */
export const BASE_WAIT_MS = SNAPSHOT_TIMEOUT_MS + 500;
/**
 * The baked history is a dynamic import of about 2 MB. When nothing else usable is in after BASE_WAIT_MS, the base decision waits for it up to
 * this long from the start: without it the chain is read from the deployment (dozens of requests), which takes longer than this.
 */
export const BAKED_WAIT_MS = 8000;
/**
 * Blocks re-read behind the applied tip on every poll. Why: the head comes from one RPC answer but eth_getLogs may be served by a node a few
 * blocks behind (load-balanced public RPC) that silently clamps toBlock to its own tip; trusting `toBlock` would leave those blocks unread
 * forever. A poll therefore starts at (cursor - TRAIL_BLOCKS), never at or below the hydrated base cursor or the deployment block; the merge is
 * idempotent, so duplicates are harmless. For the same reason the cache is written with its cursor TRAIL_BLOCKS behind the applied tip (events
 * above it are taken back out of the written copy), so the next visit re-reads them.
 */
export const TRAIL_BLOCKS = 256;
// Sizing: the chain makes roughly 6.6 blocks per second, so 256 blocks are about 39 s: the getLogs node may lag by a few seconds and a poll
// comes every 2 s, so the window outlasts any realistic lag by a wide margin. The window is merged into the poll's single range (a range
// is [cursor - TRAIL_BLOCKS, head]), so the request count does not change, only the payload (about 40 s of events, a few KB). The same
// number is how far behind the applied tip the cache is written, i.e. what the next visit re-reads in one extra request.
/** After the first trustworthy paint, folded chunks refresh the derived views at most this often (the final chunk always does). */
export const DERIVE_EVERY_MS = 250;
const RETRY_RUN_BASE_MS = 1000, RETRY_RUN_MAX_MS = 30_000;

/** Pure clock maths from the on-chain schedule and a wall-clock reading (seconds). */
export function clockAt(s: Schedule, nowSec: number) {
  const epoch = Math.floor((nowSec - s.t0) / s.epochLen); const off = nowSec - (s.t0 + epoch * s.epochLen);
  const phase: Phase = off < s.commitEnd ? 'commit' : off < s.revealEnd ? 'reveal' : 'clear';
  const [from, to] = phase === 'commit' ? [0, s.commitEnd] : phase === 'reveal' ? [s.commitEnd, s.revealEnd] : [s.revealEnd, s.epochLen];
  return { epoch, phase, offset: off, secondsLeft: to - off, phaseProgress: (off - from) / (to - from), epochProgress: off / s.epochLen };
}

const toEpochBook = (b: CoreBook, cleared: ClearPoint | undefined): EpochBook => ({ marketId: b.market, epoch: b.epoch, orders: b.orders.map((o) => ({ ...o })), cleared });
const errText = (e: any) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 160);
const sameSchedule = (a: Schedule, b: Schedule) => a.t0 === b.t0 && a.epochLen === b.epochLen && a.commitEnd === b.commitEnd && a.revealEnd === b.revealEnd && a.bond === b.bond;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Runs `fn` when the browser is idle (or on the next timer without requestIdleCallback); returns the canceller. */
function whenIdle(fn: () => void): () => void {
  const g = globalThis as any;
  if (typeof g.requestIdleCallback === 'function') { const id = g.requestIdleCallback(fn, { timeout: 4000 }); return () => g.cancelIdleCallback?.(id); }
  const id = setTimeout(fn, 0); return () => clearTimeout(id);
}

export function createMarketStore(cfg: MarketConfig) {
  const chain = defineChain({ id: cfg.chain.id, name: cfg.chain.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.chain.rpc] } } });
  const client = createPublicClient({ chain, transport: http(cfg.chain.rpc, { timeout: 15_000, retryCount: 0 }) }) as PublicClient;
  const marketIdOf = (m: CatalogMarket) => keccak256(toHex(m.id));
  const idToCat = new Map(cfg.catalog.map((m) => [marketIdOf(m).toLowerCase(), m]));
  const marketIds = cfg.catalog.map((m) => marketIdOf(m).toLowerCase());
  const identity = { chainId: cfg.chain.id, book: cfg.book.toLowerCase(), deployBlock: cfg.deployBlock };
  const chunk = cfg.logChunk && cfg.logChunk >= 1 ? Math.floor(cfg.logChunk) : LOG_CHUNK;
  const hydrateFn = cfg.hydrateSnapshot ?? hydrate;
  const retryWaits = cfg.retryWaitsMs && cfg.retryWaitsMs.length ? cfg.retryWaitsMs : RETRY_WAITS_MS;
  let ledger = newLedger(); // replaced by a fresh one at (re)initialisation; a snapshot is hydrated into that fresh ledger exactly once
  let state: MarketState = { ready: false, markets: cfg.catalog.map((m) => ({ ...m, marketId: marketIdOf(m), last: 0, lastEpoch: -1, change: 0, prices: [] })), clears: {}, fills: [], live: {}, traders: [], lastBlock: 0, lastBlockTime: 0, sampledAt: 0, updatedAt: 0, source: 'rpc', historyComplete: false };
  const subs = new Set<() => void>(); const emit = (patch: Partial<MarketState>) => { state = { ...state, ...patch, updatedAt: Date.now() }; subs.forEach((f) => f()); };
  let timer: any; let cursor = cfg.deployBlock; let schedule: Schedule | undefined; let stopped = false; let started = false; let backfill: Backfill | null = null;
  let initDone = false, initializing = false;
  let trusted = false;                 // readyFor said yes at least once: from then on the derived views may be refreshed at a throttled rate
  let lastDerive = 0, derivePending = false;
  let nothingError: string | undefined; // error shown because NOTHING could be loaded; cleared by the first chunk that arrives
  let historyError: string | undefined; // why the older history is incomplete (diagnostics)
  let floor = cfg.deployBlock;          // first block this store may ever request: the hydrated base cursor + 1, else the deployment block
  const tail = new Map<string, MarketEvent>(); // every applied event above (cursor - 1 - TRAIL_BLOCKS), by tx:logIndex: dedupes the trailing re-read and lets the cache copy leave them out
  let running = false, failStreak = 0, retryAt = 0; let pollFails = 0; // consecutive failed polls
  const cacheGate = createCacheGate(); let dirtySinceWrite = false, cacheQueued = false, cacheWriting = false; let cancelCache: (() => void) | undefined;

  async function loadSchedule(): Promise<Schedule> {
    const read = (fn: string) => client.readContract({ address: cfg.book, abi: BOOK_ABI, functionName: fn as any } as any) as Promise<bigint>;
    const [t0, epochLen, commitEnd, revealEnd, bond] = await Promise.all(['t0', 'epochLen', 'commitEnd', 'revealEnd', 'bond'].map(read));
    return { t0: Number(t0), epochLen: Number(epochLen), commitEnd: Number(commitEnd), revealEnd: Number(revealEnd), bond: Number(bond) };
  }

  /** Recomputes every derived view from the ledger. */
  function derive(): Partial<MarketState> {
    const clears = clearPoints(ledger);
    const markets = state.markets.map((m) => ({ ...m, ...summarize(clears[m.marketId.toLowerCase()] ?? []) }));
    // expose only the newest epoch per market as "live" (older ones live in `clears`)
    const live: Record<string, EpochBook> = {};
    for (const [id, b] of Object.entries(liveBooks(ledger))) live[id] = toEpochBook(b, ledger.clears.get(id)?.get(b.epoch));
    return { clears, markets, fills: fillRows(ledger, schedule), live, traders: traderOrder(ledger) };
  }
  const keepFrom = () => cursor - 1 - TRAIL_BLOCKS;
  function pruneTail() { const k = keepFrom(); for (const [key, e] of tail) if (e.block <= k) tail.delete(key); }
  /** Applies the events not applied yet (the trailing re-read delivers most of them a second time); true when anything new went in. */
  function fold(events: MarketEvent[]) {
    const fresh: MarketEvent[] = [];
    for (const e of events) { const key = e.tx + ':' + e.logIndex; if (tail.has(key)) continue; if (e.block > keepFrom()) tail.set(key, e); fresh.push(e); }
    if (!fresh.length) return false;
    applyEvents(ledger, fresh, schedule); dirtySinceWrite = true; return true;
  }
  /**
   * The ledger as it was when the tip was `through`: books and clears touched by tail events above it are copied and those events taken back out
   * (everything else is shared, not copied). `tail` holds every applied event above (cursor - 1 - TRAIL_BLOCKS), and through >= that bound.
   */
  function ledgerAt(through: number): Ledger {
    const late = [...tail.values()].filter((e) => e.block > through);
    if (!late.length) return ledger;
    const books = new Map(ledger.books); const clears = new Map(ledger.clears); const copied = new Set<string>(); const copiedClears = new Set<string>();
    for (const e of late) {
      const k = bookKey(e.market, e.epoch); let b = books.get(k); if (!b) continue;
      if (!copied.has(k)) { b = { ...b, orders: b.orders.map((o) => ({ ...o })) }; books.set(k, b); copied.add(k); }
      if (e.kind === 'clear') {
        if (b.clear?.tx === e.tx) delete b.clear;
        if (!copiedClears.has(e.market)) { clears.set(e.market, new Map(clears.get(e.market) ?? [])); copiedClears.add(e.market); }
        const pt = clears.get(e.market)!.get(e.epoch); if (pt && pt.tx === e.tx) clears.get(e.market)!.delete(e.epoch);
        continue;
      }
      const o = b.orders.find((x) => x.index === e.index); if (!o) continue;
      if (e.kind === 'commit') o.hash = '';
      else if (e.kind === 'reveal') { delete o.side; delete o.price; delete o.units; }
      else { delete o.filled; if (o.price === undefined) delete o.side; }
    }
    for (const k of copied) {
      const b = books.get(k)!; b.orders = b.orders.filter((o) => o.hash || o.side !== undefined || o.price !== undefined || o.units !== undefined || o.filled !== undefined);
      if (b.firstBlock > through || (!b.orders.length && !b.clear)) books.delete(k); else if (b.lastBlock > through) b.lastBlock = through;
    }
    return { books, clears, foldedThrough: ledger.foldedThrough };
  }
  function flushDerived() { if (derivePending && !stopped) { derivePending = false; lastDerive = Date.now(); emit(derive()); } }

  /** The public RPC can throttle bursts: retry with backoff before giving up. Stops retrying once the store is stopped. An error for which `final` is true is thrown at once. */
  async function withRetry<T>(fn: () => Promise<T>, final?: (e: unknown) => boolean): Promise<T> {
    let last: any;
    for (const wait of retryWaits) {
      if (wait) await sleep(wait);
      if (stopped) throw new Error('stopped');
      try { return await fn(); } catch (e) { if (final?.(e)) throw e; last = e; }
    }
    throw last;
  }
  const hex = (n: number) => '0x' + n.toString(16);
  /** One getLogs request (with retries). The node's "too many logs" refusal is not retried: the same range would be refused again. */
  async function fetchOnce(r: Range): Promise<MarketEvent[]> {
    const logs = await withRetry(() => (client as any).request({ method: 'eth_getLogs', params: [{ address: cfg.book, fromBlock: hex(r.from), toBlock: hex(r.to), topics: [MARKET_TOPICS] }] }) as Promise<RawLog[]>, isLimitError);
    if (!Array.isArray(logs)) throw new Error('eth_getLogs returned no list'); // an empty range is a list; anything else must not become a silent hole
    return decodeLogs(logs).filter((e) => e.block >= r.from && e.block <= r.to);
  }
  /** Events of one block range, in chain order. A range over the node's log cap is split (splitOnLimit). Anything the node returns outside the range is dropped, so a base cursor is never crossed. */
  const fetchRange = (r: Range): Promise<MarketEvent[]> => splitOnLimit(r, fetchOnce);

  /** Cache write: best-effort, deferred to an idle moment, never awaited by anything the page waits for. */
  function queueCacheWrite(force: boolean) {
    if (!cfg.kv || stopped || cacheQueued) return;
    if (!cacheGate.allowed(force)) return;
    cacheQueued = true; cancelCache = whenIdle(() => { cacheQueued = false; cancelCache = undefined; void saveCache(force); });
  }
  async function saveCache(force: boolean): Promise<void> {
    if (!cfg.kv || stopped || !schedule || !state.historyComplete || !dirtySinceWrite || cacheWriting) return;
    if (!cacheGate.allowed(force)) return;
    // The copy is written TRAIL_BLOCKS behind the applied tip (a lagging getLogs node may have hidden blocks near it), but never behind the hydrated
    // base. ledgerAt() takes the events above `through` back out, so no datum in the entry is above its cursor and validateSnapshot accepts it.
    const through = Math.max(cursor - 1 - TRAIL_BLOCKS, floor - 1); if (through < cfg.deployBlock) return;
    cacheWriting = true; cacheGate.begin(); dirtySinceWrite = false;
    try {
      // writeFitted shrinks a snapshot over the cache cap the way the Worker does (fewer hot epochs); a failed write is not retried for CACHE_WRITE_EVERY_MS
      const ok = await writeFitted(cfg.kv, identity, ledgerAt(through), { ...identity, cursor: through, head: through, headTime: state.lastBlockTime, builtAt: Date.now(), complete: true }, schedule, Date.now());
      cacheGate.done(ok); if (!ok) dirtySinceWrite = true;
    } catch { cacheGate.done(false); dirtySinceWrite = true; } finally { cacheWriting = false; }
  }

  /** One loaded chunk. SYNCHRONOUS on purpose: the loader counts the range as done only if this returns without throwing. */
  function onChunk(events: MarketEvent[], _r: Range, p: LoadProgress) {
    fold(events);
    if (trusted && !p.complete && Date.now() - lastDerive < DERIVE_EVERY_MS) { derivePending = true; return; }
    const view = derive(); const ready = readyFor(view.clears!, marketIds, p);
    lastDerive = Date.now(); derivePending = false; if (ready) trusted = true; nothingError = undefined;
    emit({ ...view, ready, historyComplete: p.complete, error: undefined });
  }

  /** Runs (or resumes) the newest-first backfill. One run at a time; a failed range stays queued and a later tick retries it after a growing pause. */
  async function runBackfill(): Promise<void> {
    const bf = backfill;
    if (!bf || running || stopped || Date.now() < retryAt) return;
    running = true;
    try {
      const p = await bf.run(BACKFILL_CONCURRENCY);
      if (stopped) return;
      if (p.complete) {
        backfill = null; failStreak = 0; retryAt = 0; nothingError = historyError = undefined; derivePending = false;
        emit({ ...derive(), ready: true, historyComplete: true, error: undefined, historyError: undefined });
        queueCacheWrite(true);
      }
    } catch (e) {
      if (stopped) return;
      failStreak++; retryAt = Date.now() + Math.min(RETRY_RUN_MAX_MS, RETRY_RUN_BASE_MS * 2 ** (failStreak - 1));
      historyError = errText(e);
      // Only when NOTHING is loaded does the page show an error (and leave its loading state); once anything is loaded the retries stay silent.
      const nothing = bf.progress().done === 0 && ledger.books.size === 0 && ledger.clears.size === 0;
      if (nothing) nothingError = historyError;
      emit(nothing ? { error: nothingError, ready: true, historyError } : { historyError });
    } finally { running = false; flushDerived(); }
  }

  /** Reads head, schedule, snapshot, cache and baked history together, picks the base, and sets up the gap load. Throws only when nothing can be started. */
  async function init(): Promise<void> {
    const t0 = Date.now();
    const headP = withRetry(() => client.getBlockNumber()).then(Number);
    const schedP = withRetry(loadSchedule);
    const fetchFn = cfg.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
    const snapUrl = cfg.snapshotUrl === undefined ? SNAPSHOT_URL : cfg.snapshotUrl;
    const serverP: Promise<MarketSnapshot | null> = snapUrl && fetchFn ? fetchSnapshot(fetchFn, snapUrl, identity).catch(() => null) : Promise.resolve(null);
    const cacheP: Promise<MarketSnapshot | null> = cfg.kv ? readCache(cfg.kv, identity, Date.now()).catch(() => null) : Promise.resolve(null);
    // the baked build-time history downloads in parallel; a failed import means no baked base (the chain fills in)
    const hasBaked = !!cfg.snapshot || !!cfg.loadSnapshot;
    const bakedP: Promise<unknown> = cfg.snapshot ? Promise.resolve(cfg.snapshot) : cfg.loadSnapshot ? Promise.resolve().then(() => cfg.loadSnapshot!()).catch(() => null) : Promise.resolve(null);
    const [head, sched] = await Promise.all([headP, schedP]);
    if (!Number.isSafeInteger(head) || head < 0) throw new Error('bad block number from the RPC');

    // A snapshot of another schedule is discarded (never displayed); chooseBase then falls back to the next candidate or the chain.
    // The baked file is converted with the on-chain schedule (it carries none), so its schedule check always passes; it is validated in bakedSnapshot.
    let server: MarketSnapshot | null = null, cached: MarketSnapshot | null = null, baked: MarketSnapshot | null = null;
    let sDone = !snapUrl || !fetchFn, cDone = !cfg.kv, bDone = !hasBaked;
    const usable = (s: MarketSnapshot | null) => (s && sameSchedule(s.schedule, sched) ? s : null);
    const pick = () => chooseBase(head, usable(server), usable(cached), usable(baked));
    const near = (b: Base | null) => !!b && head - b.snap.cursor <= chunk;
    await new Promise<void>((resolve) => {
      let waitTimer: any; let finished = false; const finish = () => { if (finished) return; finished = true; clearTimeout(waitTimer); resolve(); };
      const check = () => {
        if (sDone && cDone && bDone) return finish();
        if (cDone) { const b = pick(); if (b && b.source === 'cache' && near(b)) return finish(); } // the cache is at most one request behind: do not wait for the server
        if (sDone && cDone && near(pick())) return finish(); // snapshot or cache at most one request behind: the baked history cannot do better
      };
      // At BASE_WAIT_MS the decision is made with what is in, except when nothing usable is in and the baked history is still loading.
      const onBaseWait = () => {
        const left = BAKED_WAIT_MS - (Date.now() - t0);
        if (!bDone && !pick() && left > 0) waitTimer = setTimeout(finish, left); else finish();
      };
      waitTimer = setTimeout(onBaseWait, Math.max(0, BASE_WAIT_MS - (Date.now() - t0)));
      serverP.then((s) => { server = s; sDone = true; check(); });
      cacheP.then((s) => { cached = s; cDone = true; check(); });
      bakedP.then((raw) => { baked = raw ? bakedSnapshot(raw, identity, sched, Date.now()) : null; bDone = true; check(); });
      check();
    });
    if (stopped) return;

    // The best usable base first; if it cannot be hydrated, the other candidate, and only then the chain. Each try uses its own fresh ledger.
    let base: Base | null = null; let next = newLedger(); let from = cfg.deployBlock;
    const left = { server: usable(server), cached: usable(cached), baked: usable(baked) };
    for (let b = chooseBase(head, left.server, left.cached, left.baked); b; b = chooseBase(head, left.server, left.cached, left.baked)) {
      const tryLedger = newLedger();
      try { hydrateFn(tryLedger, b.snap); base = b; next = tryLedger; from = b.snap.cursor + 1; break; }
      catch { if (b.source === 'snapshot') left.server = null; else if (b.source === 'cache') left.cached = null; else left.baked = null; }
    }
    stampTimes(next, sched);
    ledger = next; schedule = sched; cursor = Math.max(head + 1, from); floor = from; tail.clear();
    const ranges = planRanges(from, head, chunk); // always (base cursor, head]: complete does not mean cursor === head
    dirtySinceWrite = !!base && base.source !== 'cache';
    trusted = false; derivePending = false; failStreak = 0; retryAt = 0; nothingError = historyError = undefined;
    backfill = ranges.length ? createBackfill(ranges, fetchRange, onChunk) : null;
    emit({ schedule, source: base?.source ?? 'rpc', snapshotHead: base?.snap.cursor, lastBlock: head, ...derive(), error: undefined, historyError: undefined, ready: !ranges.length, historyComplete: !ranges.length });
    if (!ranges.length) queueCacheWrite(true);
    else void runBackfill(); // not awaited: polling for new blocks starts now, the backfill continues behind it
  }
  async function attemptInit() {
    if (initDone || initializing || stopped) return;
    initializing = true;
    try { await init(); initDone = !stopped; }
    catch (e: any) { if (!stopped) emit({ error: errText(e), ready: true }); } // nothing loaded: show the error, keep trying on every poll
    finally { initializing = false; }
  }

  async function tick() {
    if (stopped) return;
    if (!initDone) { await attemptInit(); return; }
    let changed = false;
    try {
      const blk = await withRetry(() => client.getBlock()); const head = Number(blk.number); const sampledAt = Date.now();
      if (stopped) return;
      // The chain's own clock first, and never backwards: a long catch-up below must not make the page think the chain stalled.
      if (head >= state.lastBlock) emit({ lastBlock: head, lastBlockTime: Math.max(state.lastBlockTime, Number(blk.timestamp)), sampledAt });
      if (head >= cursor) { // no new block (or a lower head, from a node that lags) means nothing to read; the cursor never goes back
        // trailing window + new blocks; chunked and oldest first, so even a long sleep of the tab never asks the node for one huge range
        const start = Math.max(cursor - TRAIL_BLOCKS, floor);
        try { for (const r of planRanges(start, head, chunk).reverse()) { const ev = await fetchRange(r); if (stopped) return; changed = fold(ev) || changed; cursor = Math.max(cursor, r.to + 1); pruneTail(); } }
        finally { if (changed && !stopped) emit(derive()); }
      }
      pollFails = 0; emit({ error: nothingError });
      if (backfill) void runBackfill(); else queueCacheWrite(false);
    } catch (e: any) { if (!stopped && ++pollFails >= 2) emit({ error: errText(e) }); } // one failed poll (all retries used up) stays silent; the next good poll resets the count
  }

  return {
    getState: () => state, subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
    marketIdOf, catalogOf: (id: string) => idToCat.get(id.toLowerCase()), client, config: cfg,
    /** The full book of ANY loaded epoch (commit hashes, reveals, fills, result): used by the sealed book and its recent results. */
    getBook: (marketId: string, epoch: number): EpochBook | undefined => {
      const b = ledger.books.get(bookKey(marketId, epoch)); return b ? toEpochBook(b, ledger.clears.get(b.market)?.get(epoch)) : undefined;
    },
    /** Every loaded book from `fromEpoch` on (the agents panel's window). Read-only view; do not mutate. */
    booksSince: (fromEpoch: number): CoreBook[] => [...ledger.books.values()].filter((b) => b.epoch >= fromEpoch),
    /** First epoch of the agents window: the newest 160 epochs that had orders. */
    windowFrom: (): number => hotFrom(ledger.books.values()),
    async start() {
      if (started) return; started = true;
      await attemptInit();
      const loop = async () => { if (stopped) return; await tick(); if (!stopped) timer = setTimeout(loop, cfg.pollMs ?? 2000); };
      if (!stopped) timer = setTimeout(loop, cfg.pollMs ?? 2000);
    },
    /** Permanent: the backfill is not resumable after this (a new store starts a new backfill). */
    stop() { stopped = true; clearTimeout(timer); backfill?.stop(); cancelCache?.(); },
    /** Indicative clearing from the orders revealed so far (TypeScript mirror of the contract). The final price is always the on-chain event. */
    indicative(marketId: string, epoch: number): { price: number; volume: number } | undefined {
      const b = ledger.books.get(bookKey(marketId, epoch)); if (!b) return undefined;
      const revealed: BookOrder[] = b.orders.filter((o) => o.price !== undefined).map((o) => ({ side: o.side!, price: o.price!, units: o.units! }));
      if (!revealed.length) return undefined; const tick = cfg.catalog.find((m) => marketIdOf(m).toLowerCase() === marketId.toLowerCase())?.tick ?? 1;
      const r = clearBook(revealed, tick); return { price: r.price, volume: r.volume };
    },
  };
}
export type MarketStore = ReturnType<typeof createMarketStore>;
