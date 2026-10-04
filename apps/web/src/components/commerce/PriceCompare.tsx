import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ApiResult, CompareResult } from '../../lib/api';
import Provenance from '../ui/Provenance';
import { flagText, fmtBpsPct, fmtCents, modePill } from '../../lib/labels';

type Props = { sku: string };

// "2026-10-03 04:14Z" (UTC date and time); '—' when the timestamp is missing or does not parse.
function fmtObserved(iso: string | null | undefined): string {
  if (typeof iso !== 'string') return '—';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}
const FEED_NAME: Record<string, string> = { serpapi: 'SerpApi', searchapi: 'SearchApi.io' };
const feedName = (id: string): string => FEED_NAME[id] ?? id;
// The Worker serves paid sources (SerpApi) from the KV cache only for a visitor without the operator token; a miss comes back with this stable code.
// It is not a failure, so it renders as a neutral note, never as an error.
const OPERATOR_CODE = 'refresh_requires_operator';
const CACHED_ONLY_NOTE = 'Cached data only. Refreshing paid sources needs the operator.';

// Same SKU priced by every registered source (eBay, Best Buy, Google Shopping via SerpApi, or via its SearchApi.io backup when SerpApi is down). Only offers that pass
// the identity gates count toward "best". Sources without credentials are labeled TEST DATA and never mixed into a
// REAL spread. Render exactly the sources the API returns: a free-text or non-manifest query may omit a source.
export default function PriceCompare({ sku }: Props) {
  const [gtin, setGtin] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ApiResult<CompareResult> | null>(null);
  const seq = useRef(0);

  async function run(withGtin: string) {
    const mine = ++seq.current;
    setBusy(true);
    const r = await api.compare(withGtin ? { sku, gtin: withGtin } : { sku });
    if (mine !== seq.current) return;
    setRes(r);
    setBusy(false);
  }
  useEffect(() => { void run(''); return () => { seq.current++; }; }, [sku]);

  const data = res && res.ok ? res.data : null;
  const spread = data ? data.spread : null;
  const spreadPct = spread && typeof spread.deltaBps === 'number' ? fmtBpsPct(spread.deltaBps) : '—';
  return (
    <div className="price-compare">
      <form className="actions" onSubmit={(e) => { e.preventDefault(); void run(gtin.trim()); }}>
        <div className="field grow">
          <label className="label" htmlFor={'gtin-' + sku}>Real GTIN/UPC (optional; catalog SKUs have none assigned)</label>
          <input id={'gtin-' + sku} inputMode="numeric" pattern="[0-9]{8,14}" value={gtin} onChange={(e) => setGtin(e.currentTarget.value)} placeholder="e.g. 012345678905" />
        </div>
        <button className="btn ghost" type="submit" disabled={busy}>{busy ? 'Comparing…' : 'Compare prices'}</button>
      </form>
      {res && !res.ok && <p className="sm" role="alert"><span className={'pill ' + (res.offline ? 'bad' : 'warn')}>{res.offline ? modePill('OFFLINE').text : res.error.code}</span> {res.error.message}</p>}
      {res && res.ok && !data && <p className="sm" role="status"><span className="pill warn">NO DATA</span> The API returned no comparison.</p>}
      {data && (
        <>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Price sources, scrollable">
            <table>
              <thead><tr><th>Source</th><th>Status</th><th className="num">Best (incl. ship)</th><th className="num">Matched / offers</th><th>Data</th></tr></thead>
              <tbody>
                {data.sources.map((s) => {
                  const p = modePill(s.mode);
                  return (
                    <tr key={s.id}>
                      <td>{s.label}<span className="cell-sub">Prices from {s.attribution}</span></td>
                      <td><span className={'pill ' + p.cls}>{p.text}</span>{s.mode === 'MOCK' ? <span className="cell-sub">Not connected: no API key yet, so these are generated test offers</span> : null}{s.error === OPERATOR_CODE ? <span className="cell-sub" data-note="cached-only">{CACHED_ONLY_NOTE}</span> : s.error ? <span className="cell-sub">{s.error}</span> : null}{s.fallbackFor ? <span className="cell-sub">{feedName(s.fallbackFor)} unavailable ({s.primaryError ?? 'error'}) — served by {feedName(s.id)}</span> : null}</td>
                      <td className="mono num">{s.bestUrl && s.bestUrl.startsWith('https://') && s.mode !== 'MOCK' ? <a href={s.bestUrl} target="_blank" rel="noopener noreferrer nofollow">{fmtCents(s.bestCents)}</a> : fmtCents(s.bestCents)}</td>
                      <td className="mono num">{s.locked} / {s.offers}</td>
                      <td className="mono xs">{s.mode === 'MOCK' ? <Provenance kind="test" /> : s.offers > 0 ? (s.mode === 'DEGRADED' && s.cache === 'STALE' ? <Provenance kind="snapshot" note="stale copy" /> : <Provenance kind="live" />) : null}<span className="cell-sub">{s.cache}{s.observedAt ? ' · ' + fmtObserved(s.observedAt) : ''}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mono sm">
            {spread
              ? <>{spread.basis === 'REAL' ? <Provenance kind="live" /> : <Provenance kind="test" />} Spread {fmtCents(spread.deltaCents)} ({spreadPct}) · {fmtCents(spread.minCents)} → {fmtCents(spread.maxCents)} across {spread.sources} {spread.basis === 'REAL' ? 'REAL' : 'test-data'} sources</>
              : 'Spread —: fewer than two sources priced this exact item.'}
          </p>
          {data.flags.length > 0 && <div className="pills">{data.flags.map((f) => <span key={f} className="pill warn">{flagText(f)}</span>)}</div>}
          <p className="note xs">Prices include shipping when the source states it, and exclude tax and fees. Locked means the offer passed the title and identity gates; it is not necessarily GTIN-verified. Data can be cached: eBay up to 6 h, Best Buy up to 72 h (Prices from Best Buy), SerpApi and its SearchApi.io backup up to 24 h.</p>
        </>
      )}
    </div>
  );
}
