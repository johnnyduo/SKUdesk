// /market trading terminal: composes the panels and owns only layout state (mobile tab, explainer). All data comes from the market hooks.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useMarket, useSelectedMarket, useSelectionSettled } from '../../lib/market-app';
import { explorer, CHAIN } from '../../lib/run';
import { BOOK_ADDRESS } from '../../lib/market-app';
import WalletButton from '../wallet/WalletButton';
import AssetList from './AssetList';
import PriceChart from './PriceChart';
import Tape from './Tape';
import EpochsTable from './EpochsTable';
import HowItWorks, { HowBanner, INTRO_KEY } from './HowItWorks';
import EpochClock from './EpochClock';
import SealedBook from './SealedBook';
import AssetSwitcher from './AssetSwitcher';
import NavMenu from './NavMenu';
import ProductFacts from './ProductFacts';
import Sk from './Sk';
import Provenance from '../ui/Provenance';
import { dataSource, loadFailed, priceSourceLine } from '../../lib/market-view';
import { tradeStats } from '../../lib/market-chart';
import { changeWindow } from '../../lib/market-core';
import { usd, pctStr, dirOf, lc, int, useReducedMotion } from './mk-fmt';
import './market.css';
import './product3d.css';

// three.js and the scene are heavy: the viewer loads after the terminal has rendered. The placeholder has the viewer's exact box, so nothing moves.
const Product3D = lazy(() => import('./Product3D'));

type Tab = 'chart' | 'book' | 'trades' | 'assets';
const TABS: [Tab, string][] = [['chart', 'Chart'], ['book', 'Book'], ['trades', 'Trades'], ['assets', 'Assets']];

function Stat({ k, v, sub, cls, tid }: { k: string; v: React.ReactNode; sub?: string; cls?: string; tid?: string }) {
  return <div className="mk-stat"><span className="mk-k">{k}</span><b className={`mk-v n ${cls ?? ''}`} data-testid={tid}>{v}</b>{sub && <span className="mk-sub">{sub}</span>}</div>;
}

/** The hero before the default selection has settled: the same boxes as the real summary, no symbol, name, price or reference. */
function HeroSkeleton() {
  const stat = (k: string, last = false) => <div className={`mk-stat${last ? ' mk-last' : ''}`} key={k}><span className="mk-k">{k}</span><b className="mk-v n"><Sk n={last ? 9 : 7} /></b><span className="mk-sub"><Sk n={10} /></span></div>;
  return (
    <section className="mk-panel mk-stats" data-panel="all" data-testid="hero-skeleton" aria-label="Market summary" aria-busy="true">
      <div className="mk-id"><h2><i className="mk-sw" aria-hidden="true" /><Sk n={7} /></h2><span className="mk-nm"><Sk n={22} /></span></div>
      {stat('Last price', true)}{stat('Change')}{stat('High')}{stat('Low')}{stat('Volume')}{stat('Trades')}
      <p className="mk-psrc"><span className="sr-only">Loading the market.</span><Sk n={90} /></p>
    </section>
  );
}

export default function Terminal() {
  const s = useMarket(); const sel = useSelectedMarket(); const reduced = useReducedMotion(); const settled = useSelectionSettled();   // false: the default pick is not decided yet, so no market identity is shown
  const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), []);   // the lazy 3D viewer is rendered only after hydration (a Suspense boundary updated mid-hydration throws React #421)
  const [tab, setTab] = useState<Tab>('chart'); const [help, setHelp] = useState(false); const [intro, setIntro] = useState(false);
  const m = sel.info; const mid = lc(sel.marketId); const src = dataSource(s);
  useEffect(() => { void import('./Product3D'); }, []);   // warm the viewer chunk (no three.js yet) while the selection settles
  useEffect(() => { try { if (localStorage.getItem(INTRO_KEY) !== '1') setIntro(true); } catch { setIntro(true); } }, []);
  const dismiss = () => { setIntro(false); try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* private mode: fine */ } };

  const all = s.clears[mid] ?? [];
  // the change% window is market-core's changeWindow (the one summarize uses for m.change): it never starts on an aggregated hourly point
  const cw = changeWindow(all); const span = cw.first && cw.last ? cw.last.epoch - cw.first.epoch : 0; const moved = !!cw.first && cw.first !== cw.last;
  const st = tradeStats(all);   // high, low, volume and trade count (aggregated hourly points count by n, high and low); high and low carry their epoch
  const traded = m.last > 0; const dir = traded && moved ? dirOf(m.change) : 'flat';

  // flash the last price when a new clearing price arrives
  const prevLast = useRef<{ id: string; v: number } | null>(null); const [flash, setFlash] = useState('');
  useEffect(() => {
    const p = prevLast.current; prevLast.current = { id: mid, v: m.last };
    if (!p || p.id !== mid || !p.v || !m.last || p.v === m.last || reduced) return;
    setFlash(m.last > p.v ? 'fl-up' : 'fl-dn'); const t = setTimeout(() => setFlash(''), 900); return () => clearTimeout(t);
  }, [m.last, mid, reduced]);

  const blockTxt = s.lastBlock ? `block ${int(s.lastBlock)}` : 'connecting';
  const down = !!s.error;
  // the chain itself can stall (the public testnet did): then nothing new will arrive, so say so instead of looking "live".
  // The browser clock and the chain clock are aligned by useClock's skew; here a generous 75s threshold avoids false alarms.
  const blockAge = s.lastBlockTime ? Date.now() / 1000 - s.lastBlockTime : 0;
  const stalled = !down && s.ready && s.lastBlockTime > 0 && blockAge > 75;
  const noData = loadFailed(s);
  // ready can be forced with nothing loaded (total failure): keep the skeletons under the error banner, never "no trade yet"
  const shown = s.ready && !noData; const none = shown ? 'no trade yet' : '';
  const ep = (e: number, n?: number) => (n ? `${n} epochs to ${e}` : `epoch ${e}`);

  return (
    <div className="mk" data-testid="market-terminal" data-ready={s.ready ? 'true' : 'false'} data-selected={settled ? m.symbol : ''} data-settled={settled ? 'true' : 'false'} data-tab={tab} data-source={s.source} data-history={s.historyComplete ? 'complete' : 'partial'}>
      <header className="mk-top">
        <a className="mk-brand" href="/" aria-label="SKUdesk home"><span className="logo-mark"><svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true"><path d="M8 22 16 8l8 14" stroke="#CCFF00" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg></span><b>SKUdesk</b></a>
        <nav className="mk-links" aria-label="Site"><a href="/app">1 Desk</a><a href="/show">2 Agent trade</a><a href="/app/create" data-testid="market-next">Next: 4 Deploy agent →</a></nav>
        <span className="mk-sp" />
        <span className={`mk-live${down ? ' bad' : ''}`} role="status" title={down ? s.error : `Reading ${CHAIN.name} every 2 seconds`}><i aria-hidden="true" />{down ? 'RPC unreachable' : s.ready ? blockTxt : 'loading'}</span>
        <button type="button" className="mk-q" data-testid="howitworks-btn" onClick={() => setHelp(true)} aria-label="How this market works" aria-haspopup="dialog" title="How this market works">?</button>
        <WalletButton />
        <NavMenu />
      </header>
      <main className="mk-main" id="main" tabIndex={-1}>
      <div className="mk-note" data-testid="testnet-note">
        <h1 className="mk-h1">Market</h1>
        <span className="mk-pill">Testnet</span><span>Testnet. Test units, not real stock. Bots provide liquidity. Test token (mUSDG).</span>
        <button type="button" className="mk-link" onClick={() => setHelp(true)}>How it works</button>
      </div>
      {intro && <HowBanner onOpen={() => { setHelp(true); }} onDismiss={dismiss} />}
      {stalled && <div className="mk-err" role="status" data-testid="chain-stalled"><b>The testnet is not producing blocks right now.</b> The last block is {Math.round(blockAge / 60)} minute{Math.round(blockAge / 60) === 1 ? '' : 's'} old, so no new epochs can settle. Everything below is real history read from the chain; live trading resumes when the network does.</div>}
      {down && <div className="mk-err" role="alert"><b>{noData ? 'Could not load the market.' : 'Connection to the chain lost.'}</b> {noData ? 'The RPC is unreachable, so no history has loaded yet.' : 'The data below is the last we received and may be stale.'} Retrying automatically; the wait between tries grows to 30 seconds. <span className="mk-err-d">({s.error})</span></div>}

      <div className="mk-body">
        <div className="mk-col mk-col-l">
          <div className="mk-panel mk-p3d o2" data-panel="assets" aria-busy={!settled}>{mounted && settled ? <Suspense fallback={<div className="p3d p3d-ph" aria-hidden="true" />}><Product3D marketId={sel.marketId} /></Suspense> : <div className="p3d p3d-ph" aria-hidden="true" />}</div>
          <ProductFacts />
          <AssetList />
        </div>

        <div className="mk-col mk-col-c">
          <AssetSwitcher />
          {!settled ? <HeroSkeleton /> :
          <section className="mk-panel mk-stats" data-panel="all" aria-label={`${m.symbol} summary`}>
            <div className="mk-id">
              <h2><i className="mk-sw" style={{ background: m.accent }} aria-hidden="true" />{m.symbol}</h2>
              <span className="mk-nm" title={m.name}>{m.name}</span>
            </div>
            <div className="mk-stat mk-last">
              <span className="mk-k">Last price</span>
              {!shown ? <b className="mk-v mk-sk mk-sk-v" data-testid="last-price" aria-label="Loading" />
                : traded ? <b className={`mk-v n ${dir} ${flash}`} data-testid="last-price">{usd(m.last)}</b>
                : <b className="mk-v mk-none-v" data-testid="last-price">no trade yet</b>}
              <span className="mk-sub">last cleared{traded ? `, ep ${m.lastEpoch}` : ''}{traded && src ? <> <Provenance kind={src.kind} /></> : null}</span>
            </div>
            <Stat k="Change" v={traded && moved ? pctStr(m.change) : '-'} cls={dir} sub={moved ? `last ${span} epoch${span === 1 ? '' : 's'}` : traded ? 'needs 2 trades' : none} />
            <Stat k="High" v={traded ? usd(st.high) : '-'} sub={traded ? ep(st.highEpoch, st.highN) : none} tid="stat-high" />
            <Stat k="Low" v={traded ? usd(st.low) : '-'} sub={traded ? ep(st.lowEpoch, st.lowN) : none} tid="stat-low" />
            <Stat k="Volume" v={traded ? int(st.volume) : '-'} sub={traded ? 'units traded' : none} tid="stat-volume" />
            <Stat k="Trades" v={traded ? int(st.n) : '-'} sub={traded ? 'epochs with a trade' : none} tid="stat-trades" />
            <p className="mk-psrc" data-testid="price-source">{priceSourceLine(m)}</p>
          </section>}
          <PriceChart />
          <EpochsTable />
        </div>

        <div className="mk-col mk-col-r">
          <section className="mk-panel mk-clockp o1" data-panel="book" aria-label="Epoch clock"><EpochClock /></section>
          <section className="mk-panel mk-bookp o2" data-panel="book" aria-label="Sealed book" tabIndex={0}><SealedBook key={sel.marketId} marketId={sel.marketId} /></section>
          <Tape />
        </div>
      </div>
      </main>

      <nav className="mk-tabs" aria-label="Terminal sections">
        <div className="mk-tl" role="tablist" aria-label="Choose a panel">
          {TABS.map(([k, l]) => <button key={k} type="button" role="tab" id={`mk-tab-${k}`} aria-selected={tab === k} data-tab={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </nav>

      <footer className="mk-foot-bar">
        <span>Prices are on-chain clearing prices of test units on {CHAIN.name}. Not retail prices.</span>
        {explorer.address(BOOK_ADDRESS) && <a href={explorer.address(BOOK_ADDRESS)} target="_blank" rel="noopener noreferrer">BlindBook contract ↗<span className="sr-only"> (opens the block explorer in a new tab)</span></a>}
        <a href="/app">Desk</a><a href="/show">Agent trade</a><a href="/app/create" data-testid="market-next-foot">Next: Deploy agent</a>
      </footer>
      <HowItWorks open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
