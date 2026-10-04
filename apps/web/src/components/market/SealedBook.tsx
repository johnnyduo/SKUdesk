// Sealed book: the signature interaction of the terminal. For one market and the CURRENT epoch it shows
//   COMMIT  hashed orders only (nothing about price, size or side is visible),
//   REVEAL  chips flip one by one, a live depth chart grows and an INDICATIVE clearing line moves,
//   CLEAR   the on-chain clearing price locks in, matched orders glow, the rest dim or turn to ash.
// Below the book, "Recent results" lists the final on-chain result of the last cleared epochs (static rows, no animation).
// Data: only the hooks of lib/market-app (useMarket, useClock) and marketStore.indicative()/getBook(). Maths: lib/book.ts.
import { useEffect, useMemo, useState } from 'react';
import { useMarket, useClock, marketStore, KEEPER_BOTS, labelWallet } from '../../lib/market-app';
import { clearBook, depth, type BookOrder } from '../../lib/book';
import type { ClearPoint, EpochBook, OrderRow } from '../../lib/market';
import { CHAIN } from '../../lib/run';
import { dataSource, type WalletLabel } from '../../lib/market-view';
import { usd } from './mk-fmt';
import AgentsRound from './AgentsRound';
import RecentEpochs from './RecentEpochs';
import './book.css';

type Stage = 'commit' | 'reveal' | 'clear';
type ChipState = 'sealed' | 'revealed' | 'filled' | 'partial' | 'unmatched' | 'forfeited';
type Chip = { index: number; trader: string; hash: string; state: ChipState; side?: 0 | 1; price?: number; units?: number; filled?: number; reason?: string };
type Result = { price: number; volume: number; buys: number; sells: number; forfeited: number; tx?: string };
type Model = {
  stage: Stage; epoch: number; chips: Chip[]; result?: Result; clearing: boolean;
  indicative?: { price: number; volume: number }; held: boolean; heldEpoch?: number;
  left: number | null; revealFrac: number | null; nextIn: number | null;
};

/* formatting */
const shortHash = (h: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : 'hash n/a');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const REVEALED_STATES: ChipState[] = ['revealed', 'filled', 'partial', 'unmatched'];

/** One order's state. `revealed` says whether its price is visible right now (known, and paced during the reveal window). */
function classify(o: OrderRow, revealed: boolean, res?: Pick<Result, 'price' | 'volume'>): { state: ChipState; reason?: string } {
  if (!res) return { state: revealed ? 'revealed' : 'sealed' };
  if (!revealed || o.price === undefined) return { state: 'forfeited' };
  const f = o.filled ?? 0; const u = o.units ?? 0;
  if (f > 0 && f >= u) return { state: 'filled' };
  if (f > 0) return { state: 'partial' };
  if (res.volume === 0) return { state: 'unmatched', reason: 'no cross, nothing traded' };
  const within = o.side === 0 ? o.price >= res.price : o.price <= res.price;
  return { state: 'unmatched', reason: within ? 'better-priced orders filled first' : 'limit not reached' };
}
const toChip = (o: OrderRow, revealed: boolean, res?: Result): Chip => {
  const k = classify(o, revealed, res);
  return { index: o.index, trader: o.trader, hash: o.hash, state: k.state, reason: k.reason, side: revealed ? o.side : undefined, price: revealed ? o.price : undefined, units: revealed ? o.units : undefined, filled: o.filled };
};
const toResult = (c?: ClearPoint): Result | undefined => (c ? { price: c.price, volume: c.volume, buys: c.buys, sells: c.sells, forfeited: c.forfeited, tx: c.tx } : undefined);

/* model builders */
function liveModel(marketId: string, clock: NonNullable<ReturnType<typeof useClock>>, shown: Set<string>, tick: number): Model & { withheld: string[] } {
  const cur = marketStore.getBook(marketId, clock.epoch);
  let book: EpochBook | undefined = cur && cur.orders.length ? cur : undefined; let held = false;
  if (!book) {
    for (let e = clock.epoch - 1; e >= Math.max(0, clock.epoch - 30); e--) { const b = marketStore.getBook(marketId, e); if (b && b.orders.length) { book = b; held = true; break; } }
  }
  const sch = clock.schedule; const stage: Stage = held ? 'clear' : clock.phase;
  const result = toResult(book?.cleared);
  // Reveals normally land together in one block. During the reveal window they are paced ~260 ms apart so each flip is visible.
  const pace = stage === 'reveal' && !result; const withheld: string[] = [];
  const chips = (book?.orders ?? []).map((o) => {
    const k = `${book!.epoch}:${o.index}`; let vis = o.price !== undefined;
    if (vis && pace && !shown.has(k)) { vis = false; withheld.push(k); }
    return toChip(o, vis, result);
  });
  let indicative = book && stage !== 'commit' ? marketStore.indicative(marketId, book.epoch) : undefined;
  if (withheld.length) { // mirror over only what is displayed so far
    const vis: BookOrder[] = chips.filter((c) => c.price !== undefined).map((c) => ({ side: c.side!, price: c.price!, units: c.units! }));
    indicative = vis.length ? (() => { const r = clearBook(vis, tick); return { price: r.price, volume: r.volume }; })() : undefined;
  }
  return {
    withheld,
    stage, epoch: clock.epoch, chips, result, clearing: stage === 'clear' && chips.length > 0 && !result, indicative, held, heldEpoch: held ? book!.epoch : undefined,
    left: Math.max(0, Math.ceil(clock.secondsLeft)), revealFrac: stage === 'reveal' ? clock.secondsLeft / (sch.revealEnd - sch.commitEnd) : null,
    nextIn: Math.max(0, Math.ceil(sch.epochLen - clock.offset)),
  };
}

/* icons (inline SVG, one 1.6px stroke family) */
const Ico = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={d} /></svg>
);
const Lock = () => <Ico d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v6.5h-9z" />;
const Up = () => <Ico d="M8 13V3M3.5 7.5 8 3l4.5 4.5" size={12} />;
const Down = () => <Ico d="M8 3v10M3.5 8.5 8 13l4.5-4.5" size={12} />;
const Ash = () => <Ico d="M3 3l10 10M13 3 3 13" size={12} />;
const Check = () => <Ico d="M3 8.5 6.5 12 13 4.5" size={12} />;

/* chip */
function ChipView({ c, m, who, resPrice, bondText }: { c: Chip; m: Model; who: WalletLabel; resPrice?: number; bondText: string }) {
  const flipped = REVEALED_STATES.includes(c.state);
  const buy = c.side === 0;
  const sealedNote = (() => {
    if (c.state === 'forfeited') return 'bond forfeited';
    if (m.stage === 'commit') return 'bond locked';
    if (m.stage === 'reveal') return m.left !== null ? `forfeits bond in ${m.left}s` : 'forfeits bond at close';
    return 'window closed, bond at risk';
  })();
  const status = (() => {
    switch (c.state) {
      case 'filled': return `filled ${c.filled} @ ${usd(resPrice ?? 0)}`;
      case 'partial': return `filled ${c.filled} of ${c.units} @ ${usd(resPrice ?? 0)}`;
      case 'unmatched': return c.reason ?? 'limit not reached';
      default: return 'revealed, open order';
    }
  })();
  const label = (() => {
    const head = `Order ${c.index}, ${who.name} (${who.bot ? 'scripted keeper bot, ' : ''}${c.trader})`;
    if (c.state === 'sealed') return `${head}: sealed, hash ${shortHash(c.hash)}. Price, size and side are hidden. ${sealedNote}.`;
    if (c.state === 'forfeited') return `${head}: never revealed, bond forfeited.`;
    const what = `${buy ? 'buy' : 'sell'} ${plural(c.units ?? 0, 'unit')}, limit ${usd(c.price ?? 0)}`;
    return `${head}: ${what}. ${status}${c.state === 'filled' || c.state === 'partial' ? ' (uniform price, not the limit)' : ''}.`;
  })();
  const sealedLike = c.state === 'sealed' || c.state === 'forfeited';
  return (
    <li className="sb-chip" data-testid="order-chip" data-state={c.state} data-index={c.index} data-side={c.side === undefined ? undefined : buy ? 'buy' : 'sell'}
      style={{ animationDelay: `${(c.index % 8) * 45}ms` }} aria-label={label}>
      <div className="sb-flip" data-flipped={flipped}>
        <div className="sb-face sb-front" aria-hidden="true">
          <div className="sb-r1"><Lock /><span className="mono sb-hash">{shortHash(c.hash)}</span></div>
          <div className="sb-r2" title={c.trader}>{who.name}</div>
          <div className="sb-r3">{c.state === 'forfeited' ? <Ash /> : null}<span>{sealedNote}</span></div>
          {c.state === 'sealed' && m.stage === 'reveal' && m.revealFrac !== null && <i className="sb-drain" style={{ transform: `scaleX(${Math.max(0, Math.min(1, m.revealFrac))})` }} />}
          {c.state === 'forfeited' && <span className="sr-only">{bondText}</span>}
        </div>
        <div className="sb-face sb-back" aria-hidden="true">
          {!sealedLike && (
            <>
              <div className="sb-r1"><span className={'sb-side ' + (buy ? 'buy' : 'sell')}>{buy ? <Up /> : <Down />}{buy ? 'BUY' : 'SELL'}</span><span className="mono sb-units">×{c.units}</span></div>
              <div className="sb-r2 mono"><b>{usd(c.price ?? 0)}</b><small>limit</small></div>
              <div className="sb-r3">{c.state === 'filled' || c.state === 'partial' ? <Check /> : null}<span>{status}</span></div>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/* depth chart (HTML labels over a non-scaling SVG so text stays crisp at any width) */
function DepthChart({ m, refCents, tick }: { m: Model; refCents: number; tick: number }) {
  const orders: BookOrder[] = m.chips.filter((c) => c.price !== undefined).map((c) => ({ side: c.side!, price: c.price!, units: c.units! }));
  const d = useMemo(() => depth(orders), [JSON.stringify(orders)]); // eslint-disable-line react-hooks/exhaustive-deps
  const prices = orders.map((o) => o.price); if (m.result && m.result.price > 0) prices.push(m.result.price); if (m.indicative && m.indicative.price > 0) prices.push(m.indicative.price);
  let lo = refCents ? refCents * 0.93 : Math.min(...prices, 0); let hi = refCents ? refCents * 1.07 : Math.max(...prices, 1);
  if (prices.length) { lo = Math.min(lo, Math.min(...prices)); hi = Math.max(hi, Math.max(...prices)); }
  const pad = Math.max(tick, (hi - lo) * 0.04); lo = Math.max(0, Math.floor(lo - pad)); hi = Math.ceil(hi + pad); const span = Math.max(1, hi - lo);
  const totB = d.bids.length ? d.bids[d.bids.length - 1].units : 0; const totA = d.asks.length ? d.asks[d.asks.length - 1].units : 0;
  const ymax = Math.max(4, totB, totA, m.result?.volume ?? 0) * 1.12;
  const X = (p: number) => ((p - lo) / span) * 100; const Y = (u: number) => 100 - (u / ymax) * 100;
  const f = (n: number) => n.toFixed(2);
  // bids: cumulative units at price >= p. Steps run from the best bid down to the left edge.
  const bidPath = d.bids.length ? (() => {
    let s = `M${f(X(d.bids[0].price))},100`; d.bids.forEach((b, i) => { s += ` L${f(X(b.price))},${f(Y(b.units))}`; const nx = d.bids[i + 1]; s += nx ? ` L${f(X(nx.price))},${f(Y(b.units))}` : ` L0,${f(Y(b.units))}`; }); return s + ' L0,100 Z';
  })() : '';
  const askPath = d.asks.length ? (() => {
    let s = `M${f(X(d.asks[0].price))},100`; d.asks.forEach((a, i) => { s += ` L${f(X(a.price))},${f(Y(a.units))}`; const nx = d.asks[i + 1]; s += nx ? ` L${f(X(nx.price))},${f(Y(a.units))}` : ` L100,${f(Y(a.units))}`; }); return s + ' L100,100 Z';
  })() : '';
  const empty = !orders.length;
  const finalP = m.result && m.result.volume > 0 ? m.result.price : undefined;
  const indP = !m.result && m.indicative && m.indicative.volume > 0 ? m.indicative.price : undefined;
  const linePrice = finalP ?? indP; const lx = linePrice !== undefined ? Math.max(0, Math.min(100, X(linePrice))) : undefined;
  const labelX = lx === undefined ? 50 : Math.max(17, Math.min(83, lx));
  const summary = empty ? 'Depth chart: no orders revealed yet.' : `Depth chart: ${totB} units bid, ${totA} units offered${finalP ? `, cleared at ${usd(finalP)}` : indP ? `, indicative price ${usd(indP)}` : ''}.`;
  return (
    <div className="sb-chart" data-empty={empty} role="img" aria-label={summary}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {[25, 50, 75].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} className="sb-grid" />)}
        {askPath && <path d={askPath} className="sb-ask" />}{bidPath && <path d={bidPath} className="sb-bid" />}
      </svg>
      {empty && (
        <div className="sb-chart-empty"><Lock /><span>{m.stage === 'commit' ? 'Depth stays hidden while orders are sealed' : 'Depth appears as orders are revealed'}</span></div>
      )}
      {m.result && m.result.volume > 0 && <div className="sb-vol" style={{ bottom: `${(m.result.volume / ymax) * 100}%` }}><span>{plural(m.result.volume, 'unit')} matched</span></div>}
      {lx !== undefined && linePrice !== undefined && (
        <>
          <div className={'sb-line ' + (finalP ? 'final' : 'ind')} style={{ left: `${lx}%` }} />
          <div className={'sb-linelabel ' + (finalP ? 'final' : 'ind')} style={{ left: `${labelX}%` }} key={finalP ? 'f' : 'i'}>
            {finalP ? <Lock /> : null}<span>{finalP ? 'cleared' : 'indicative'}</span><b className="mono">{usd(linePrice)}</b>
          </div>
        </>
      )}
      <div className="sb-axis mono" aria-hidden="true"><span>{usd(lo)}</span><span>{usd(lo + span / 2)}</span><span>{usd(lo + span)}</span></div>
    </div>
  );
}

/* main */
export default function SealedBook({ marketId }: { marketId: string }) {
  const s = useMarket(); const clock = useClock();
  const info = s.markets.find((x) => x.marketId.toLowerCase() === marketId.toLowerCase());
  const tick = info?.tick ?? 1; const refCents = info?.referenceCents ?? 0; const bond = s.schedule?.bond ?? 0;

  const [shown, setShown] = useState<Set<string>>(() => new Set()); let withheld: string[] = [];
  let m: Model | null = null;
  if (clock) { const lm = liveModel(marketId, clock, shown, tick); m = lm; withheld = lm.withheld; }
  const wkey = withheld.join(',');
  useEffect(() => { if (!wkey) return; const id = setTimeout(() => setShown((p) => new Set(p).add(wkey.split(',')[0])), 260); return () => clearTimeout(id); }, [wkey]);

  const bondText = `${(bond / 1e6).toFixed(2)} mUSDG bond forfeited to the treasury`;
  const sealed = m ? m.chips.filter((c) => c.state === 'sealed').length : 0;
  const revealed = m ? m.chips.filter((c) => c.price !== undefined).length : 0;
  const phase = m && clock ? clock.phase : 'loading';
  const result = m?.result;
  const filledCount = m ? m.chips.filter((c) => c.state === 'filled' || c.state === 'partial').length : 0;
  const explorerTx = result?.tx && CHAIN.explorer ? `${CHAIN.explorer}/tx/${result.tx}` : '';

  /* status copy */
  const total = m?.chips.length ?? 0;
  const statusHead = (() => {
    if (!m) return 'Reading the chain';
    if (!total) return m.stage === 'commit' ? 'No sealed orders yet' : 'No orders this epoch';
    if (m.stage === 'commit') return `${plural(sealed, 'sealed order')}`;
    if (m.stage === 'reveal') return `${revealed} of ${total} revealed`;
    return result ? `${revealed} of ${total} revealed` : 'Reveal window closed';
  })();
  const sentence = (() => {
    if (!m) return '';
    if (m.stage === 'commit' && total) return 'Nobody, including other bots, can see price, size or side yet.';
    if (m.stage === 'reveal') return 'Orders open one at a time. Early reveals are visible to later ones, so every order locked a bond: sealed orders forfeit it when the window closes.';
    if (m.stage === 'clear' && total) return result ? (result.volume > 0 ? 'Everyone trades at ONE price, not their limit.' : 'Orders crossed nowhere, so nothing traded and every lock was released.') : 'Anyone can now clear the market. One uniform price will match everyone.';
    return '';
  })();

  return (
    <section className="sb" data-testid="sealed-book" data-phase={phase} data-epoch={m ? clock?.epoch : ''} data-shown-epoch={m ? (m.heldEpoch ?? m.epoch) : ''}
      data-sealed-count={sealed} data-revealed-count={revealed} data-cleared={result ? 'true' : 'false'} data-held={m?.held ? 'true' : 'false'}
      aria-label="Sealed book">
      <header className="sb-head">
        <div className="sb-title">
          <h3>Sealed book</h3>
          {m && <span className={'sb-pill ph-' + m.stage}>{m.stage.toUpperCase()}</span>}
          {m && <span className="sb-mode live" data-testid="mode-badge"><i aria-hidden="true" />LIVE{m.held ? '' : ` epoch ${m.epoch}`}</span>}
        </div>
      </header>

      {/* honest state strips */}
      {s.error && <p className="sb-strip err" role="status" data-testid="rpc-error">RPC error: {s.error}. Showing the last data we have.</p>}
      {!s.ready && !s.error && <p className="sb-strip" role="status" data-testid="history-loading">Loading epoch history from the chain…</p>}
      {m?.held && (
        <p className="sb-strip" data-testid="held-note">
          {m.stage === 'clear' && clock?.phase === 'commit' ? `Epoch ${clock.epoch}: commit window open, no sealed order in this market yet (${m.left}s left). ` : `Epoch ${clock?.epoch}: no orders in this market. `}
          Showing the last result, epoch {m.heldEpoch}.
        </p>
      )}

      {!m && (
        <div className="sb-skel" aria-busy="true"><i /><i /><i /><span className="sb-note">{s.error ? 'Waiting for the chain to respond…' : 'Reading the BlindBook schedule…'}</span></div>
      )}

      {m && (
        <>
          <div className="sb-status">
            <div className="sb-count"><b className="mono" key={statusHead} data-testid="sealed-counter">{statusHead}</b>
              {m.stage === 'commit' && total > 0 && <span className="sb-bond"><Lock />bond locked{bond ? `: ${(bond / 1e6).toFixed(2)} mUSDG each` : ''}</span>}
              {m.stage === 'reveal' && total > 0 && <span className="sb-bond">{sealed} still sealed{m.left !== null ? `, window closes in ${m.left}s` : ''}</span>}
            </div>
            {sentence && <p className="sb-sentence">{sentence}</p>}
          </div>

          {total === 0 ? (
            <div className="sb-empty" data-testid="empty-state"><Lock /><span>{m.stage === 'commit' ? 'Waiting for the first sealed order. Bots commit in the first seconds of the window.' : 'No bot placed an order in this market this epoch. Each epoch only some markets are active.'}</span></div>
          ) : (
            <ul className="sb-chips" aria-label={`Orders in epoch ${m.heldEpoch ?? m.epoch}`}>
              {m.chips.map((c) => <ChipView key={`${m.heldEpoch ?? m.epoch}-${c.index}`} c={c} m={m} who={labelWallet(c.trader, s.traders)} resPrice={result?.price} bondText={bondText} />)}
            </ul>
          )}

          <div className="sb-prices">
            <div><small>{result && m.indicative ? 'Indicative (TypeScript mirror)' : 'Indicative'}</small><b className="mono" data-testid="indicative-price" data-cents={m.indicative?.volume ? m.indicative.price : ''}
              data-match={result && m.indicative ? String(m.indicative.price === result.price && m.indicative.volume === result.volume) : undefined}>
              {m.indicative ? (m.indicative.volume > 0 ? usd(m.indicative.price) : 'no cross yet') : m.stage === 'commit' ? 'hidden' : 'none yet'}</b>
              {result && m.indicative && <span className="sb-match">{m.indicative.price === result.price && m.indicative.volume === result.volume ? 'matches the contract' : 'differs from the contract'}</span>}</div>
            <div className={result ? 'locked' : ''}><small>{result ? 'Clearing price (on-chain)' : 'Clearing price'}</small><b className="mono" data-testid="clearing-price" data-cents={result ? result.price : ''}>
              {result ? (result.volume > 0 ? usd(result.price) : 'no cross') : m.clearing ? 'clearing…' : 'pending'}</b></div>
          </div>

          <DepthChart m={m} refCents={refCents} tick={tick} />
          <p className="sb-legend"><span className="buy"><i />BUY orders, cumulative</span><span className="sell"><i />SELL orders, cumulative</span></p>

          <div className="sb-banner" data-testid="result-banner" aria-live="polite" data-result={result ? (result.volume > 0 ? 'cleared' : 'nocross') : m.clearing ? 'pending' : 'none'}>
            {m.stage === 'clear' && total > 0 && (
              result ? (
                <div className="sb-result" key={`res-${m.epoch}`}>
                  <b className="sb-headline">{result.volume > 0 ? `Cleared at ${usd(result.price)}, ${plural(result.volume, 'unit')}` : 'No cross, no trade'}</b>
                  <span className="sb-sub">
                    {result.volume > 0 ? `${plural(filledCount, 'order')} filled at one uniform price, not their limits. ` : ''}
                    {result.forfeited > 0 ? `${plural(result.forfeited, 'bond')} forfeited. ` : ''}
                    {m.held ? '' : m.nextIn !== null ? `Next epoch in ${m.nextIn}s.` : ''}
                    {explorerTx && <> <a href={explorerTx} target="_blank" rel="noopener noreferrer" className="sb-link">tx <span aria-hidden="true">↗</span><span className="sr-only"> (opens the block explorer in a new tab)</span></a></>}
                  </span>
                </div>
              ) : (
                <div className="sb-result pending"><b className="sb-headline">Clearing<span className="sb-dots" aria-hidden="true" /></b><span className="sb-sub">The price lands on-chain a few seconds after the reveal window closes{m.nextIn !== null ? `. Next epoch in ${m.nextIn}s.` : '.'}</span></div>
              )
            )}
          </div>
        </>
      )}
      {m && <AgentsRound chips={m.chips} epoch={m.heldEpoch ?? m.epoch} held={m.held} traders={s.traders} bots={KEEPER_BOTS} bond={bond} clearPrice={result && result.volume > 0 ? result.price : undefined} source={dataSource(s)} />}
      <RecentEpochs marketId={marketId} />
      <p className="sb-foot">Clearing prices of test units, read from a testnet contract. Not retail prices. Liquidity comes from SKUdesk bots; units are issued by the operator and the token (mUSDG) is a stand-in.</p>
    </section>
  );
}
