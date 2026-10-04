// "Recent results": the final on-chain result of the last cleared epochs of the selected market, under the sealed book.
// Static rows, no animation: each row is what the chain stored when that epoch cleared, with its clearing transaction on the
// explorer and, when the epoch's book is loaded, who ordered (names from market-view walletLabel via market-app labelWallet).
import { useMemo } from 'react';
import { useMarket, marketStore, labelWallet } from '../../lib/market-app';
import { recentEpochs, RECENT_EPOCHS, type RecentEpoch } from '../../lib/market-recent';
import { historyReadError, type WalletLabel } from '../../lib/market-view';
import { CHAIN } from '../../lib/run';
import { usd, hhmmss } from './mk-fmt';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function RecentEpochsView({ rows, ready, error, complete = true, explorer, label }: { rows: RecentEpoch[]; ready: boolean; error?: string; complete?: boolean; explorer: string; label: (address: string) => WalletLabel }) {
  return (
    <section className="sb-recent" data-testid="recent-epochs" aria-labelledby="sb-recent-h">
      <h4 id="sb-recent-h">Recent results</h4>
      <p className="sb-recent-note">The final result of the last {RECENT_EPOCHS} cleared epochs in this market, read from the chain. Each links to its clearing transaction.</p>
      {rows.length === 0 ? (
        <p className="sb-recent-empty" data-testid="recent-empty">{!ready ? 'Loading epoch history from the chain…'
          : error ? `Could not read the epoch history from the chain (${error}). Trying again on the next update.`
          : !complete ? 'No cleared epoch found in the history loaded so far; older history is still loading.'
          : 'No cleared epoch in this market yet.'}</p>
      ) : (
        <ol className="sb-recent-list">
          {rows.map((r) => {
            const href = r.tx && explorer ? `${explorer}/tx/${r.tx}` : '';
            const head = r.volume > 0 ? `Cleared at ${usd(r.price)}, ${plural(r.volume, 'unit')}` : 'No cross, no trade';
            const extra = (r.forfeited > 0 ? ` · ${plural(r.forfeited, 'bond')} forfeited` : '') + (complete && r.buyOrders !== null ? ` · ${plural(r.buyOrders, 'buy order')}, ${plural(r.sellOrders ?? 0, 'sell order')} revealed` : '');
            return (
              <li key={r.epoch} className="sb-recent-row" data-testid="recent-epoch" data-epoch={r.epoch} data-cents={r.volume > 0 ? r.price : ''}>
                <div className="sb-recent-top"><b>Final result of epoch {r.epoch}</b>{r.time > 0 && <span className="sb-recent-when mono">{hhmmss(r.time)}</span>}</div>
                <p className="sb-recent-res">{head}{extra}</p>
                {href && <a className="sb-link" href={href} target="_blank" rel="noopener noreferrer">Clearing transaction <span aria-hidden="true">↗</span><span className="sr-only"> for epoch {r.epoch} (opens the block explorer in a new tab)</span></a>}
                {complete && r.orders && (
                  <details className="sb-recent-orders">
                    <summary>{plural(r.orders.length, 'order')} in epoch {r.epoch}</summary>
                    <div className="sb-recent-scroll" role="region" aria-label={`Orders in epoch ${r.epoch}`} tabIndex={0}>
                      <table>
                        <thead><tr><th scope="col">Trader</th><th scope="col">Side</th><th scope="col">Limit</th><th scope="col">Units</th><th scope="col">Filled</th></tr></thead>
                        <tbody>
                          {r.orders.map((o) => {
                            const who = label(o.trader);
                            return (
                              <tr key={o.index}>
                                <th scope="row" title={o.trader}>{who.name}<span className="sr-only"> ({who.bot ? 'scripted keeper bot, ' : ''}{o.trader})</span></th>
                                <td>{o.side === undefined ? 'never revealed' : o.side === 0 ? 'buy' : 'sell'}</td>
                                <td className="mono">{o.price === undefined ? '—' : usd(o.price)}</td>
                                <td className="mono">{o.units ?? '—'}</td>
                                <td className="mono">{o.side === undefined ? 'bond forfeited' : (o.filled ?? 0)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!complete && rows.length > 0 && <p className="sb-recent-note" data-testid="recent-partial">Order lists appear once the older history has finished loading; until then an epoch could show only some of its orders.</p>}
    </section>
  );
}

export default function RecentEpochs({ marketId }: { marketId: string }) {
  const s = useMarket();
  const pts = s.clears[marketId.toLowerCase()];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => recentEpochs(pts, (e) => marketStore.getBook(marketId, e)), [pts, marketId, s.updatedAt]);
  return <RecentEpochsView rows={rows} ready={s.ready} error={historyReadError(s)} complete={s.historyComplete} explorer={CHAIN.explorer} label={(a) => labelWallet(a, s.traders)} />;
}
