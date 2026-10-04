// Trade tape: recent fills for the selected market, newest first, each linked to its transaction on the explorer.
import { useEffect, useRef } from 'react';
import { useMarket, useSelectedMarket, labelWallet } from '../../lib/market-app';
import { explorer } from '../../lib/run';
import Provenance from '../ui/Provenance';
import { dataSource, loadFailed } from '../../lib/market-view';
import { usd, lc, ago, hhmmss, int, useNowSec, sideName } from './mk-fmt';

export default function Tape() {
  const s = useMarket(); const sel = useSelectedMarket(); const now = useNowSec(1000);
  const mid = lc(sel.marketId); const src = dataSource(s); const ready = s.ready && !loadFailed(s);
  const rows = s.fills.filter((f) => lc(f.marketId) === mid).slice(0, 40);
  const seen = useRef<Set<string> | null>(null); const mk = useRef('');
  const keyOf = (f: (typeof rows)[number]) => `${f.tx}:${f.index}`;
  // rows that were not on screen at the previous render flash once (nothing flashes on first load or when switching market)
  const fresh = new Set<string>();
  if (seen.current && mk.current === mid) for (const f of rows) if (!seen.current.has(keyOf(f))) fresh.add(keyOf(f));
  useEffect(() => { seen.current = new Set(rows.map(keyOf)); mk.current = mid; });
  return (
    <section className="mk-panel mk-tape" data-panel="trades" aria-labelledby="mk-tape-h">
      <div className="mk-ph"><h2 id="mk-tape-h">Trades</h2><span className="mk-ph-r">{src && <Provenance kind={src.kind} note={src.note} />} {sel.info.symbol}</span></div>
      <div className="mk-th" aria-hidden="true"><span>Side</span><span>Agent</span><span>Price</span><span>Units</span><span>Time</span><span /></div>
      <div className="mk-tbody" role="list" aria-label={`Recent fills for ${sel.info.symbol}`}>
        {!ready && Array.from({ length: 6 }, (_, i) => <div key={i} className="mk-sk mk-sk-row" />)}
        {ready && rows.length === 0 && <p className="mk-none">No fills yet for {sel.info.symbol}. Fills appear here once an epoch clears with a trade.</p>}
        {rows.map((f) => {
          const href = explorer.tx(f.tx); const who = labelWallet(f.trader, s.traders);
          return (
            <div key={keyOf(f)} role="listitem" data-testid="tape-row" data-market-id={lc(f.marketId)} className={`mk-tr${fresh.has(keyOf(f)) ? ' flash' : ''}`}>
              <span className={f.side === 0 ? 'buy' : 'sell'}>{sideName(f.side)}</span>
              <span className="mk-who" title={f.trader}>{who.name}<span className="sr-only"> ({who.bot ? 'scripted keeper bot, ' : ''}{f.trader})</span></span>
              <span className="n">{usd(f.price)}</span>
              <span className="n">{int(f.units)}</span>
              <span className="n dim" title={f.time ? `Epoch ${f.epoch}, ${hhmmss(f.time)} local` : `Epoch ${f.epoch}`}>{f.time ? ago(f.time, now) : `ep ${f.epoch}`}</span>
              {href ? <a className="mk-tx" href={href} target="_blank" rel="noopener noreferrer" aria-label={`View fill transaction on the explorer (epoch ${f.epoch})`} title="View transaction on the explorer">↗</a> : <span />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
