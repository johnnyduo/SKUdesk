import { ROWS, type Row } from '../commerce/market';
import { usdCents } from '../../lib/run';

// Compact strip of the recorded snapshot: one tile per offer with its identity-gate verdict.
// Real data only (snapshot.json + packages/matching at build time). Rendered on the server; no client JS.
export default function Tape({ rows = ROWS }: { rows?: Row[] }) {
  return (
    <ul className="mk-tape" aria-label="The 10 offers in the market snapshot and their identity-gate verdicts">
      {rows.map((r) => (
        <li key={r.id} className={`${r.locked ? 'locked' : 'rejected'} ${r.role ? 'chosen' : ''}`}>
          <div className="t-top"><span className="t-id mono" title={r.title}>{r.id}</span><span className={`mk-chip ${r.locked ? 'locked' : 'rejected'}`}>{r.locked ? 'LOCKED' : 'REJECTED'}</span></div>
          <span className="t-price">{usdCents(r.priceCents)}</span>
          <span className="t-ev">{r.role ? (r.role === 'BUY' ? 'Chosen buy. ' : 'Chosen sell. ') : ''}{r.failing.length ? `${r.failing[0].label}: ${r.failing[0].observed}` : r.device}</span>
        </li>
      ))}
    </ul>
  );
}
