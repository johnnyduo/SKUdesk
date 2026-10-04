// Presentational proof components shared by /show and /app/agent. Rules: text plus an icon, never colour alone;
// 'unknown' reads as "could not check right now", never as a failure of the run; nothing here says the run is live.
// Every claim that the chain agrees with the run says "according to the public RPC": a hostile RPC could return a fully
// matching receipt, so the check is only as trustworthy as that endpoint. The explorer links are the independent check.
// Without JavaScript (status 'idle' from the server render) no badge renders: only the explorer links, never a fake state.
import { useId } from 'react';
import { clockText, proofFor, type MandateField, type MandateProof, type ProofDiff, type ProofReport, type TxProof } from '../../lib/chain-proof';
import { explorer, short } from '../../lib/run';
import type { ChainProof, ProofStatus } from './useChainProof';
import './proof.css';

export type Line = { tone: 'ok' | 'bad' | 'wait' | 'na'; icon: string; text: string; state: string };
export type VerifyTx = { id: number; title: string; hash: string };

const RPC = 'according to the public RPC';
const n = (x: number | string) => Number(x).toLocaleString('en-US');
const FIELD: Record<ProofDiff['field'], string> = { status: 'status', block: 'block', gasUsed: 'gas used', from: 'sender', to: 'contract' };
const val = (d: ProofDiff, v: string) => (d.field === 'from' || d.field === 'to' ? short(v, 6, 4) : d.field === 'status' ? v : n(v));
const where = (b: number | null, c: number | null) => (b === null ? '' : ` · block ${n(b)}`) + (c === null ? '' : ` · ${n(c)} confirmation${c === 1 ? '' : 's'}`);

export function badgeLine(p: TxProof | undefined, status: ProofStatus): Line | null {
  if (status === 'checking') return { tone: 'wait', icon: '…', text: 'Checking the chain…', state: 'checking' };
  if (status !== 'done' || !p) return null;
  switch (p.state) {
    case 'confirmed': return { tone: 'ok', icon: '✓', text: `Confirmed on chain, ${RPC}` + where(p.block, p.confirmations), state: p.state };
    case 'reverted': return { tone: 'ok', icon: '✓', text: `Reverted on chain, as in the run, ${RPC}` + where(p.block, p.confirmations), state: p.state };
    case 'mismatch': return { tone: 'bad', icon: '✕', text: `Differs from the run, ${RPC}: ` + p.diffs.map((d) => `${FIELD[d.field]} ${val(d, d.run)} in the run, ${val(d, d.chain)} on chain`).join('; '), state: p.state };
    case 'not-found': return { tone: 'bad', icon: '✕', text: 'The public RPC has no receipt for this hash', state: p.state };
    default: return { tone: 'na', icon: '?', text: 'Not checked: the chain did not answer', state: p.state };
  }
}

export function summaryLine(report: ProofReport | null, status: ProofStatus, total: number, chain: string): Line & { sub: string; again: boolean } {
  if (status === 'unavailable') return { tone: 'na', icon: '!', state: 'unavailable', text: 'This run is from a local chain, so there is no public chain to check it against.', sub: '', again: false };
  if (status === 'idle') return { tone: 'na', icon: '↗', state: 'idle', text: `These ${total} transactions were sent to ${chain}.`, sub: 'The links open the explorer; the check reads them from the public RPC.', again: false };
  if (status === 'checking' || !report) return { tone: 'wait', icon: '…', state: 'checking', text: `Checking ${total} transactions of this run against ${chain}…`, sub: 'One read-only request to the public RPC. Nothing is signed or sent.', again: false };
  const c = report.counts;
  const at = `checked at ${clockText(report.checkedAt)}`;
  if (!report.reachable || c.unknown === c.total) {
    return { tone: 'na', icon: '?', state: 'unknown', text: `Could not reach ${chain} just now, so nothing was checked.`, sub: 'That says nothing about the run itself: the explorer links still work.', again: true };
  }
  const ok = c.confirmed + c.reverted;
  const text = `${ok} of ${c.total} transactions match the chain, ${RPC}`;
  if (ok === c.total) {
    const how = c.reverted ? `${c.confirmed} succeeded and ${c.reverted} reverted, as in the run` : `${c.confirmed} succeeded, as in the run`;
    return { tone: 'ok', icon: '✓', state: 'match', text, sub: [chain, how, report.head !== null ? `latest block ${n(report.head)}` : '', at].filter(Boolean).join(' · '), again: true };
  }
  const bad = c.mismatch > 0 || c.notFound > 0;
  if (!bad) {
    return { tone: 'na', icon: '?', state: 'partial', text: `${text}. ${c.unknown} could not be checked.`, sub: `The explorer links still work · ${at}`, again: true };
  }
  const parts = [
    c.mismatch ? `${c.mismatch} ${c.mismatch === 1 ? 'differs' : 'differ'} from the run` : '',
    c.notFound ? `${c.notFound} ${c.notFound === 1 ? 'has' : 'have'} no receipt on the public RPC` : '',
    c.unknown ? `${c.unknown} could not be checked right now` : '',
  ].filter(Boolean);
  return { tone: 'bad', icon: '✕', state: 'differs', text: `${text}.`, sub: [...parts, at].join(' · '), again: true };
}

export function pillLine(report: ProofReport | null, status: ProofStatus): Line | null {
  if (status === 'unavailable' || status === 'idle') return null;
  if (status === 'checking' || !report) return { tone: 'wait', icon: '…', text: 'Checking the chain', state: 'checking' };
  const c = report.counts;
  const ok = c.confirmed + c.reverted;
  if (!report.reachable || c.unknown === c.total) return { tone: 'na', icon: '?', text: 'Chain not reachable', state: 'unknown' };
  if (ok === c.total) return { tone: 'ok', icon: '✓', text: `${ok}/${c.total} on chain (public RPC)`, state: 'match' };
  const bad = c.mismatch > 0 || c.notFound > 0;
  return { tone: bad ? 'bad' : 'na', icon: bad ? '✕' : '?', text: `${ok}/${c.total} match the chain (public RPC)`, state: bad ? 'differs' : 'partial' };
}

const usd = (cents: string) => '$' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FMT: Record<MandateField, [string, (v: string) => string]> = {
  maxExec: ['per-run cap', usd],
  dailySpendCap: ['daily cap', usd],
  minMarginBps: ['margin floor', (v) => (Number(v) / 100).toFixed(2).replace(/\.?0+$/, '') + '%'],
  quoteTTL: ['quote freshness', (v) => v + 's'],
};
export function mandateLine(m: MandateProof | null, status: ProofStatus): Line | null {
  if (status !== 'done' || !m || m.state === 'unknown') return null;
  if (m.state === 'same') return { tone: 'ok', icon: '✓', text: `On chain now, ${RPC}: the same four limits as in the run.`, state: 'same' };
  const changed = m.fields.filter((f) => f.chain !== f.run).map((f) => `${FMT[f.field][0]} ${FMT[f.field][1](f.run)} in the run, ${FMT[f.field][1](f.chain ?? '')} now`);
  return { tone: 'na', icon: '!', text: `The owner has changed the mandate since the run, ${RPC}: ${changed.join('; ')}.`, state: 'changed' };
}

export function ProofBadge({ proof, status }: { proof?: TxProof; status: ProofStatus }) {
  const l = badgeLine(proof, status);
  if (!l) return null;
  return <span className={'pf-badge ' + l.tone} data-testid="proof-badge" data-proof={l.state}><span className="pf-ico" aria-hidden="true">{l.icon}</span>{l.text}</span>;
}

export function ProofSummary({ proof, total, chain, id }: { proof: ChainProof; total: number; chain: string; id?: string }) {
  const s = summaryLine(proof.report, proof.status, total, chain);
  const checking = proof.status === 'checking';
  const showButton = s.again || (checking && proof.report !== null);
  return (
    <div className={'pf-sum ' + s.tone} id={id} data-testid="proof-summary" data-state={s.state}>
      <div className="pf-sum-text" role="status" aria-live="polite" aria-atomic="true">
        <p className="pf-sum-head"><span className="pf-ico" aria-hidden="true">{s.icon}</span>{s.text}</p>
        {s.sub && <p className="pf-sum-sub">{s.sub}</p>}
      </div>
      {showButton && (
        <button type="button" className="btn ghost pf-again" aria-disabled={checking ? true : undefined} onClick={() => { if (!checking) proof.check(); }}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      )}
    </div>
  );
}

const PILL_TONE: Record<Line['tone'], string> = { ok: ' good', bad: ' bad', na: ' warn', wait: '' };

export function ProofPill({ proof }: { proof: ChainProof }) {
  const l = pillLine(proof.report, proof.status);
  if (!l) return null;
  return <span className={'pill pf-pill hide-sm' + PILL_TONE[l.tone]} data-testid="proof-pill" title="Each transaction of this run is read from the public RPC and compared with the run"><span aria-hidden="true">{l.icon}</span> {l.text}</span>;
}

export function MandateNow({ mandate, status }: { mandate: MandateProof | null; status: ProofStatus }) {
  const l = mandateLine(mandate, status);
  if (!l) return null;
  return <p className={'pf-mandate ' + l.tone} data-testid="mandate-now" data-state={l.state}><span className="pf-ico" aria-hidden="true">{l.icon}</span>{l.text}</p>;
}

function Ext({ href, text, title }: { href: string; text: string; title?: string }) {
  if (!href) return <span className="mono pf-hash" title={title}>{text}</span>;
  return (
    <a className="mono pf-hash pf-link" href={href} target="_blank" rel="noopener noreferrer" title={title}>
      {text} <span aria-hidden="true">↗</span><span className="sr-only"> (opens the block explorer in a new tab)</span>
    </a>
  );
}

export function VerifyList({ proof, txs, addresses }: { proof: ChainProof; txs: VerifyTx[]; addresses: { label: string; address: string }[] }) {
  const headingId = useId();
  return (
    <section className="pf-verify" aria-labelledby={headingId} data-testid="verify-list">
      <h3 id={headingId}>Verify it yourself</h3>
      <p className="pf-note">Each link opens the public block explorer in a new tab. The explorer does not depend on this website.</p>
      {addresses.length > 0 && (
        <dl className="pf-addrs">
          {addresses.map((a) => <div key={a.label}><dt>{a.label}</dt><dd><Ext href={explorer.address(a.address)} text={a.address} /></dd></div>)}
        </dl>
      )}
      <ol className="pf-txs" role="list">
        {txs.map((t) => (
          <li key={t.id}>
            <span className="pf-tx-title">{t.title}</span>
            <Ext href={explorer.tx(t.hash)} text={short(t.hash, 10, 8)} title={t.hash} />
            <span className="pf-slot"><ProofBadge proof={proofFor(proof.report, t.hash)} status={proof.status} /></span>
          </li>
        ))}
      </ol>
    </section>
  );
}
