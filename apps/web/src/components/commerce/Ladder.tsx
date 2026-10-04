import { ROWS, GROSS_SPREAD_CENTS, type Row } from './market';
import { ECON, usdCents, pct } from '../../lib/run';

// Real bid/ask ladder of the recorded snapshot. Bar length = listed stock. Rejected rows are hatched and struck through
// because the identity gates (computed at build time by packages/matching) say they are not the target product.
// Rendered on the server; no client JS.
function LRow({ r }: { r: Row }) {
  const max = Math.max(...ROWS.map((x) => x.stock));
  return (
    <div className={`mk-lr ${r.side} ${r.locked ? '' : 'rejected'} ${r.role ? 'chosen' : ''}`}>
      <span className="p">{usdCents(r.priceCents)}</span>
      <div className="track" role="img" aria-label={`${r.stock} in stock`}><div className="bar" style={{ width: Math.max(4, (r.stock / max) * 100) + '%' }} /></div>
      <div className="d">
        <span>{r.id} · {r.seller}{r.role ? (r.role === 'BUY' ? ' · CHOSEN BUY' : ' · CHOSEN SELL') : ''}</span>
        <small>{r.locked ? `locked · stock ${r.stock.toLocaleString('en-US')}` : `rejected: ${r.failing.map((g) => g.label).join(', ')} (${r.failing[0]?.observed})`}</small>
      </div>
    </div>
  );
}

export default function Ladder({ rows = ROWS }: { rows?: Row[] }) {
  const demand = rows.filter((r) => r.side === 'demand').sort((a, b) => b.priceCents - a.priceCents);
  const supply = rows.filter((r) => r.side === 'supply').sort((a, b) => b.priceCents - a.priceCents);
  return (
    <div className="mk-ladder mono">
      <div className="mk-lh">Demand · free-shipping retail listings (what the agent could sell into)</div>
      {demand.map((r) => <LRow key={r.id} r={r} />)}
      <div className="mk-lmid">
        <span>Chosen spread: {usdCents(ECON.landedCents + GROSS_SPREAD_CENTS)} sell − {usdCents(ECON.landedCents)} landed = {usdCents(GROSS_SPREAD_CENTS)} gross</span>
        <span>net {usdCents(ECON.netCents)} per unit · {pct(ECON.marginBps)}</span>
      </div>
      <div className="mk-lh">Supply · listings that charge shipping (what the agent could buy from)</div>
      {supply.map((r) => <LRow key={r.id} r={r} />)}
      <div className="mk-legend" aria-hidden="true"><span><i className="a" />locked supply</span><span><i className="b" />locked demand</span><span><i className="c" />rejected by an identity gate</span></div>
    </div>
  );
}
