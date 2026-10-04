import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ApiResult, DryRunResponse, ListingStatusResponse, PublishResponse } from '../../lib/api';
import { fmtCents, listingPill, modePill } from '../../lib/labels';
import type { Pill } from '../../lib/labels';

type Props = { lotId: string; title: string; link: string; imageLink: string; priceCents: number; brand: string; gtin: string | null };
type PublishResult = ApiResult<DryRunResponse | PublishResponse>;
type Failure = Extract<ApiResult<unknown>, { ok: false }>;

const PillTag = ({ p }: { p: Pill }) => <span className={'pill ' + p.cls}>{p.text}</span>;

// After "Delete listing" the same button becomes "Confirm delete" under the pointer; it stays disabled this long
// so a double-click cannot complete a delete.
const CONFIRM_ARM_MS = 800;

type Action = 'publish' | 'delete' | 'status';

// A failed call is never shown as success. Offline is checked FIRST (a 401 with a non-JSON body means no Worker
// answered), then a 401 says the operator token is required or invalid, anything else shows the Worker's error.
function Problem({ r, action }: { r: Failure; action: Action }) {
  const pill: Pill = r.offline ? modePill('OFFLINE') : { cls: 'bad', text: r.status === 401 ? 'OPERATOR TOKEN' : r.error.code };
  const nothing = action === 'delete' ? ' Nothing was deleted.' : action === 'publish' ? ' Nothing was published.' : '';
  const msg = r.offline ? r.error.message : r.status === 401 ? 'Operator token required or invalid.' + nothing : r.error.message;
  return <p className="sm" role="alert"><PillTag p={pill} /> {msg}{r.error.requestId ? ' · request ' + r.error.requestId : ''}</p>;
}

// "Publish listing" for Google Merchant. Dry run by default; a live publish needs the operator token, which is
// held in React state only (never written to storage, a URL or any DOM attribute) and sent as X-Admin-Token.
export default function PublishListing(p: Props) {
  const [token, setToken] = useState('');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState<'publish' | 'refresh' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [armed, setArmed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [status, setStatus] = useState<ApiResult<ListingStatusResponse> | null>(null);
  const [statusAction, setStatusAction] = useState<Action>('status');

  // A pending confirmation starts disarmed, moves keyboard focus to Cancel (the safe choice) and arms after CONFIRM_ARM_MS.
  useEffect(() => {
    if (!confirmDelete) { setArmed(false); return; }
    setArmed(false);
    cancelRef.current?.focus();
    const id = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(id);
  }, [confirmDelete]);

  function onToken(value: string) {
    setToken(value);
    // Without a token there is nothing to confirm: dismiss the pending confirmation (it must not reappear on retyping).
    if (!value) setConfirmDelete(false);
  }
  function toggleLive(on: boolean) {
    setLive(on);
    setConfirmDelete(false);
    if (!on) setToken('');
  }
  async function publish() {
    setBusy('publish');
    setConfirmDelete(false);
    setStatus(null);
    try {
      const body = { lotId: p.lotId, title: p.title, link: p.link, imageLink: p.imageLink, priceCents: p.priceCents, brand: p.brand, ...(p.gtin ? { gtin: p.gtin } : {}), dryRun: !live };
      setResult(await api.publishListing(body, live ? token : undefined));
    } finally {
      setBusy(null);
    }
  }
  async function refresh() {
    setBusy('refresh');
    setConfirmDelete(false);
    try {
      setStatusAction('status');
      setStatus(await api.listingStatus(p.lotId));
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    if (!armed) return;
    setBusy('delete');
    setConfirmDelete(false);
    try {
      const r = await api.deleteListing(p.lotId, token);
      setStatusAction('delete');
      if (r.ok) {
        // One coherent state: drop the earlier "submitted" line and show REAL · DELETED only.
        setResult(null);
        setStatus({ ok: true, status: r.status, data: { mode: 'REAL', offerId: p.lotId, status: 'DELETED', issues: [], lastCheckedAt: null, productName: null } });
      } else {
        setStatus(r);
      }
    } finally {
      setBusy(null);
    }
  }

  const data = result && result.ok ? result.data : null;
  const deleted = !!status && status.ok && status.data.status === 'DELETED';
  return (
    <div className="panel publish-listing" aria-busy={busy !== null}>
      <p className="mono sm">{p.title} · {fmtCents(p.priceCents)} USD · offerId {p.lotId}</p>
      <label className="check"><input type="checkbox" checked={live} onChange={(e) => toggleLive(e.currentTarget.checked)} />Live publish to Google Merchant (operator only)</label>
      {live && (
        <div className="field">
          <label className="label" htmlFor="op-token">Operator token (kept in this tab's memory only)</label>
          <input id="op-token" type="password" autoComplete="new-password" spellCheck={false} onChange={(e) => onToken(e.currentTarget.value)} />
        </div>
      )}
      <div className="actions">
        <button className="btn" type="button" disabled={busy !== null || (live && token.length === 0)} onClick={publish}>{busy === 'publish' ? 'Publishing…' : live ? 'Publish live' : 'Publish listing (dry run)'}</button>
        {data && data.mode === 'REAL' && <button className="btn ghost" type="button" disabled={busy !== null} onClick={refresh}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}</button>}
        {data && data.mode === 'REAL' && live && token && <button className="btn ghost" type="button" disabled={busy !== null || (confirmDelete && !armed)} onClick={remove}>{busy === 'delete' ? 'Deleting…' : confirmDelete ? 'Confirm delete' : 'Delete listing'}</button>}
        {confirmDelete && busy === null && <button className="btn ghost" type="button" ref={cancelRef} onClick={() => setConfirmDelete(false)}>Cancel</button>}
      </div>
      <div aria-live="polite">
        {confirmDelete && <p className="sm">This removes the listing from Google Merchant. Press Confirm delete to continue.</p>}
        {result && !result.ok && <Problem r={result} action="publish" />}
        {data && data.mode === 'DRY_RUN' && (
          <div>
            <p className="sm"><PillTag p={modePill('DRY_RUN')} /> {data.configured ? 'Merchant account configured.' : 'Merchant account not configured yet.'} Nothing was sent. Account ids are hidden; the request below uses placeholders for them:</p>
            <pre className="code">{JSON.stringify(data.wouldSend, null, 2)}</pre>
          </div>
        )}
        {data && data.mode === 'REAL' && (
          <p className="sm"><PillTag p={modePill('REAL')} /> <PillTag p={listingPill(data.status)} /> {data.idempotent ? 'Already submitted with identical data; nothing re-sent.' : data.updated ? 'Listing updated.' : 'Listing submitted; Google processes it within minutes.'}</p>
        )}
        {status && status.ok && deleted && (
          <p className="sm"><PillTag p={modePill('REAL')} /> <PillTag p={listingPill('DELETED')} /> Listing deleted from Google Merchant.</p>
        )}
        {status && status.ok && !deleted && (
          <div className="sm">
            <p><PillTag p={listingPill(status.data.status)} /> last checked {status.data.lastCheckedAt ?? 'never'}{status.data.refreshError ? ' · refresh failed: ' + status.data.refreshError : ''}</p>
            {status.data.issues.length > 0 && <ul className="mono xs">{status.data.issues.map((i) => <li key={i.code}>{i.code}: {i.description}</li>)}</ul>}
          </div>
        )}
        {status && !status.ok && <Problem r={status} action={statusAction} />}
      </div>
    </div>
  );
}
