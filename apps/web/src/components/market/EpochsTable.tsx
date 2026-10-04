// Recent epochs for the selected market: what each sealed-bid auction cleared at. Epochs with no trade are dimmed.
import { useMarket, useSelectedMarket } from '../../lib/market-app';
import { explorer } from '../../lib/run';
import Provenance from '../ui/Provenance';
import { dataSource, loadFailed } from '../../lib/market-view';
import { usd, lc, hhmmss, dmon, int } from './mk-fmt';

export default function EpochsTable() {
  const s = useMarket(); const sel = useSelectedMarket();
  const rows = [...(s.clears[lc(sel.marketId)] ?? [])].sort((a, b) => b.epoch - a.epoch).slice(0, 30);
  const src = dataSource(s); const ready = s.ready && !loadFailed(s); const bondTok = s.schedule ? s.schedule.bond / 1e6 : 2;
  return (
    <section className="mk-panel mk-epochs" data-panel="chart" aria-labelledby="mk-ep-h">
      <div className="mk-ph"><h2 id="mk-ep-h">Recent epochs</h2><span className="mk-ph-r">{src && <Provenance kind={src.kind} note={src.note} />} {sel.info.symbol} · last {rows.length}</span></div>
      <div className="mk-tscroll">
        <table className="mk-tbl">
          <thead><tr>
            <th scope="col" className="l"><span className="hl">Epoch</span><span className="hs">Ep</span></th><th scope="col" className="l">Time</th><th scope="col" className="r"><span className="hl">Clearing price</span><span className="hs">Price</span></th><th scope="col" className="r"><span className="hl">Volume</span><span className="hs">Vol</span></th>
            <th scope="col" className="r"><span className="hl">Bids</span><span className="hs">Bid</span></th><th scope="col" className="r"><span className="hl">Asks</span><span className="hs">Ask</span></th><th scope="col" className="r" title="Orders committed but never revealed; each loses its bond"><span className="hl">Forfeited</span><span className="hs">Forf</span></th><th scope="col" className="r"><span className="sr-only">Transaction</span></th>
          </tr></thead>
          <tbody>
            {!ready && Array.from({ length: 5 }, (_, i) => <tr key={i}><td colSpan={8}><div className="mk-sk mk-sk-row" /></td></tr>)}
            {ready && rows.length === 0 && <tr><td colSpan={8} className="mk-none">No epoch has cleared for {sel.info.symbol} in the loaded history.</td></tr>}
            {rows.map((c) => {
              const href = explorer.tx(c.tx); const none = c.volume === 0;
              return (
                <tr key={c.epoch} data-testid="epochs-row" data-epoch={c.epoch} className={none ? 'nt' : ''}>
                  <td className="l n">{c.epoch}</td>
                  <td className="l n dim" title={c.time ? `${dmon(c.time)}, local time` : undefined}>{c.time ? hhmmss(c.time) : ''}</td>
                  <td className="r n">{none ? <span title="Cleared with no trade: no overlapping bids and asks">no trade</span> : usd(c.price)}</td>
                  <td className="r n">{none ? '0' : int(c.volume)}</td>
                  <td className="r n">{c.buys}</td>
                  <td className="r n">{c.sells}</td>
                  <td className="r n" title={c.forfeited ? `${c.forfeited} unrevealed order${c.forfeited === 1 ? '' : 's'} lost the ${bondTok} mUSDG bond` : 'every order was revealed'}>{c.forfeited || '-'}</td>
                  <td className="r">{href ? <a className="mk-tx" href={href} target="_blank" rel="noopener noreferrer" aria-label={`View epoch ${c.epoch} clearing transaction on the explorer`} title="View transaction on the explorer">↗</a> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
