import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { ApiResult, MerchantStatus, SourcesResponse, V4PoolResponse } from '../../lib/api';
import { modePill } from '../../lib/labels';

type Row = { id: string; name: string; mode: string; detail: string; creds: string; link?: { href: string; text: string } };

const MERCHANT = 'Google Merchant API';
const degraded = (id: string, name: string, detail: string): Row => ({ id, name, mode: 'DEGRADED', detail, creds: '—' });

export function merchantRow(r: ApiResult<MerchantStatus>): Row {
  if (!r.ok) return { id: 'merchant', name: MERCHANT, mode: r.offline ? 'OFFLINE' : 'DEGRADED', detail: r.error?.message ?? 'request failed', creds: '—' };
  const s = r.data;
  if (!s) return degraded('merchant', MERCHANT, 'empty response from /api');
  if (s.mode === 'MOCK') return { id: 'merchant', name: MERCHANT, mode: 'NOT_CONNECTED', detail: 'no API key yet · missing: ' + (Array.isArray(s.missing) ? s.missing.join(', ') : 'unknown'), creds: 'not configured' };
  if (s.mode === 'REAL') {
    // The public status carries no account ids (only hasDataSource); an older or admin-shaped body is tolerated, and its ids are never printed.
    const ms = typeof s.latencyMs === 'number' && Number.isFinite(s.latencyMs) ? ' · ' + s.latencyMs + ' ms' : '';
    const hasDs = typeof s.hasDataSource === 'boolean' ? s.hasDataSource : Boolean(s.dataSource);
    return { id: 'merchant', name: MERCHANT, mode: 'REAL', detail: 'Merchant account connected' + ms + ' · data source ' + (hasDs ? 'set' : 'not set'), creds: 'service account' };
  }
  if (s.mode === 'DEGRADED') return { id: 'merchant', name: MERCHANT, mode: 'DEGRADED', detail: (s.error?.code ?? 'ERROR') + ': ' + (s.error?.hint ?? 'no detail'), creds: 'configured' };
  return degraded('merchant', MERCHANT, 'unrecognised response from /api');
}

const PRETTY: Record<string, string> = { serpapi: 'SerpApi', searchapi: 'SearchApi.io' };

// The failover-only backup of a source (SerpApi -> SearchApi.io). Null-safe: older Workers send no `backup`.
// It is only ever called when the primary fails upstream, so it may read REAL only while the primary itself is REAL and
// configured; otherwise it is on standby and never used, and says so instead of claiming live data.
function backupRow(s: SourcesResponse['sources'][number], i: number): Row[] {
  const b = s.backup;
  if (!b || typeof b !== 'object') return [];
  const primary = typeof s.id === 'string' && PRETTY[s.id] ? PRETTY[s.id] : typeof s.label === 'string' && s.label ? s.label : 'the primary source';
  const backup = typeof b.id === 'string' && PRETTY[b.id] ? PRETTY[b.id] : typeof b.label === 'string' && b.label ? b.label : 'backup';
  const left = b.quotaRemaining === null || b.quotaRemaining === undefined ? '' : ' · ' + b.quotaRemaining + ' calls left';
  const primaryLive = s.mode === 'REAL' && s.configured === true;
  let detail = 'no API key yet · no backup if ' + primary + ' is down';
  if (b.configured) detail = primaryLive
    ? 'configured · standby (used only if ' + primary + ' fails)' + left
    : 'configured · standby (inactive: ' + primary + ' is not REAL, so this backup is never called)' + left;
  return [{
    id: (typeof s.id === 'string' ? s.id : 'source-' + i) + '-backup',
    name: primary + ' backup (' + backup + ')',
    mode: b.configured && primaryLive ? 'REAL' : 'NOT_CONNECTED',
    detail,
    creds: b.configured ? 'configured' : 'not configured',
  }];
}

export function sourceRows(r: ApiResult<SourcesResponse>): Row[] {
  if (!r.ok) return [{ id: 'sources', name: 'Price sources', mode: r.offline ? 'OFFLINE' : 'DEGRADED', detail: r.error?.message ?? 'request failed', creds: '—' }];
  if (!r.data || !Array.isArray(r.data.sources)) return [degraded('sources', 'Price sources', 'empty response from /api')];
  return r.data.sources.flatMap((s, i): Row[] => [{
    id: typeof s.id === 'string' ? s.id : 'source-' + i,
    name: s.label,
    mode: typeof s.mode === 'string' && s.mode ? (s.mode === 'MOCK' ? 'NOT_CONNECTED' : s.mode) : 'DEGRADED',
    detail: (s.mode === 'MOCK' ? 'no API key yet · ' : '') + (s.searchesByGtin ? 'exact GTIN/UPC lookup' : 'keyword search') + (s.quotaRemaining === null || s.quotaRemaining === undefined ? '' : ' · ' + s.quotaRemaining + '/' + s.dailyBudget + ' calls left today'),
    creds: s.configured ? 'configured' : 'not configured',
  }, ...backupRow(s, i)]);
}

const V4_NAME = 'Uniswap v4 pool (test token pair)';
const V4_VENUE = 'secondary venue, not a hook';
const EXPLORER_PREFIX = 'https://explorer.testnet.chain.robinhood.com/';
const SYMBOL = /^[A-Za-z0-9._-]{1,16}$/;
// The stable token's symbol comes from the API (whichever stable the pool uses, it follows a re-pool); a missing or malformed symbol reads "stable".
const stableSymbolOf = (p: { stableSymbol?: unknown }): string => (typeof p.stableSymbol === 'string' && SYMBOL.test(p.stableSymbol) ? p.stableSymbol : 'stable');

// Read-only view of the reference pool from /api/v4/pool. Null-safe: a malformed answer reads DEGRADED, never REAL.
export function v4PoolRow(r: ApiResult<V4PoolResponse>): Row {
  if (!r.ok) return { id: 'v4pool', name: V4_NAME, mode: r.offline ? 'OFFLINE' : 'DEGRADED', detail: r.error?.message ?? 'request failed', creds: '—' };
  const p = r.data;
  const href = p && typeof p === 'object' && typeof p.explorer?.poolManager === 'string' && p.explorer.poolManager.startsWith(EXPLORER_PREFIX) ? p.explorer.poolManager : null;
  const link = href ? { href, text: 'PoolManager on the explorer' } : undefined;
  const row = (mode: string, detail: string): Row => ({ id: 'v4pool', name: V4_NAME, mode, detail, creds: 'public RPC', ...(link ? { link } : {}) });
  if (!p || typeof p !== 'object') return row('DEGRADED', 'empty response from /api · ' + V4_VENUE);
  if (p.mode === 'REAL' && typeof p.priceMusdcPerUnit === 'string' && p.priceMusdcPerUnit) {
    const live = p.inRange === true && typeof p.liquidity === 'string' && p.liquidity !== '' && p.liquidity !== '0';
    const block = typeof p.blockNumber === 'number' && Number.isFinite(p.blockNumber) ? ' · block ' + p.blockNumber : '';
    return row('REAL', 'price ' + p.priceMusdcPerUnit + ' ' + stableSymbolOf(p) + ' per unit · liquidity in range ' + (live ? 'yes' : 'no') + block + ' · ' + V4_VENUE);
  }
  if (p.mode === 'DEGRADED') return row('DEGRADED', 'chain read unavailable (' + (typeof p.error?.code === 'string' ? p.error.code : 'ERROR') + ') · ' + V4_VENUE);
  return row('DEGRADED', 'unrecognised response from /api · ' + V4_VENUE);
}

export function ConnectorTable({ rows }: { rows: Row[] }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Connector status, scrollable">
      <table>
        <thead><tr><th>Connector</th><th>Status</th><th>Detail</th><th>Creds</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const p = modePill(r.mode);
            return <tr key={r.id}><td>{r.name}</td><td><span className={'pill ' + p.cls}>{p.text}</span></td><td className="sm">{r.detail}{r.link ? <> · <a href={r.link.href} target="_blank" rel="noopener noreferrer">{r.link.text}</a></> : null}</td><td>{r.creds}</td></tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

// Live connector health from this site's /api. Without credentials every row reads NOT CONNECTED; if the API is not
// deployed (e.g. `astro dev`), rows read API NOT CONNECTED.
export default function LiveConnectors() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([api.merchantStatus(), api.priceSources(), api.v4Pool()])
      .then(([m, s, v]) => [merchantRow(m), ...sourceRows(s), v4PoolRow(v)])
      .catch(() => [degraded('status', 'Live backend', 'could not read the /api response')])
      .then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, []);
  if (!rows) return <p className="note" aria-live="polite">Checking /api…</p>;
  return <ConnectorTable rows={rows} />;
}
