// Asset list: every market with last clearing price, change, sparkline and an activity dot. Click or keyboard selects.
import { useRef } from 'react';
import { useMarket, useSelectedMarket, useSelectionSettled, useClock, selectMarket } from '../../lib/market-app';
import Sk from './Sk';
import { usd, pctStr, dirOf, lc } from './mk-fmt';

function Spark({ prices, dir }: { prices: number[]; dir: 'up' | 'down' | 'flat' }) {
  const W = 52, H = 20;
  if (prices.length < 2) return <svg className="mk-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><line x1="2" x2={W - 2} y1={H / 2} y2={H / 2} className="mk-spark-none" /></svg>;
  const lo = Math.min(...prices), hi = Math.max(...prices), sp = hi - lo || 1;
  const pts = prices.map((p, i) => `${(2 + (i / (prices.length - 1)) * (W - 4)).toFixed(1)},${(H - 3 - ((p - lo) / sp) * (H - 6)).toFixed(1)}`).join(' ');
  return <svg className={`mk-spark mk-spark-${dir}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><polyline points={pts} fill="none" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export default function AssetList() {
  const s = useMarket(); const sel = useSelectedMarket(); const settled = useSelectionSettled(); const clock = useClock(); const list = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0; if (!d) return; e.preventDefault();
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-testid="asset-row"]'); rows?.[(i + d + s.markets.length) % s.markets.length]?.focus();
  };
  return (
    <section className="mk-panel mk-assets o1" data-panel="assets" aria-labelledby="mk-assets-h" aria-busy={!settled}>
      <div className="mk-ph"><h2 id="mk-assets-h">Markets</h2><span className="mk-ph-r">last cleared price</span></div>
      <div className="mk-al" ref={list} role="group" aria-label="Markets. Arrow keys move between rows, Enter selects.">
        {s.markets.map((m, i) => {
          const traded = m.last > 0; const dir = traded ? dirOf(m.change) : 'flat';
          const b = s.live[lc(m.marketId)]; const sealed = !!b && !!clock && b.epoch === clock.epoch ? b.orders.length : 0;
          const on = settled && sel.index === i;   // no row is marked selected until the default pick has settled
          return (
            <button key={m.id} type="button" className={`mk-ar${on ? ' on' : ''}`} data-testid="asset-row" data-symbol={m.symbol} aria-current={on ? 'true' : undefined} aria-pressed={on}
              onClick={() => selectMarket(i)} onKeyDown={(e) => onKey(e, i)} style={{ ['--ac' as any]: m.accent }}>
              <span className="mk-ar-id">
                <span className="mk-ar-sym"><i className="mk-sw" aria-hidden="true" />{m.symbol}{sealed > 0 && <i className="mk-act" title={`${sealed} sealed order${sealed === 1 ? '' : 's'} in this epoch`} aria-hidden="true" />}</span>
                <span className="mk-ar-name" title={m.name}>{m.subtitle}</span>
              </span>
              <Spark prices={m.prices} dir={dir} />
              <span className="mk-ar-pc">
                <span className={`mk-ar-px ${traded ? '' : 'none'}`}>{traded ? usd(m.last) : settled ? 'no trade yet' : <Sk n={9} />}</span>
                <span className={`mk-ar-ch ${dir}`}>{traded && m.prices.length > 1 ? pctStr(m.change) : traded ? '0.00%' : ''}</span>
              </span>
              {sealed > 0 && <span className="sr-only">{sealed} sealed orders this epoch</span>}
            </button>
          );
        })}
        {!s.ready && s.markets.length === 0 && <div className="mk-sk" style={{ height: 120 }} />}
      </div>
      <p className="mk-foot">Liquidity comes from SKUdesk bots. Reference prices are a fixed snapshot plus a deterministic drift, not a live feed.</p>
    </section>
  );
}
