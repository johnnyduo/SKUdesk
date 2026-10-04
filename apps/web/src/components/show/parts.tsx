import { useEffect, useState } from 'react';
import { run, snapshot, net, txUrl, addrUrl, usd, fromUnits, pct, short, int, humanize, provenance, checkClaim, EXPLORER_NOTE, ATTESTED, FN_GLOSS, ERR_GLOSS, proceeds, BY_CONSTRUCTION } from './lib';
import type { Step, Vault } from './lib';
import { proofFor } from '../../lib/chain-proof';
import type { ChainProof } from '../proof/useChainProof';
import { MandateNow, ProofBadge, ProofSummary, VerifyList } from '../proof/Proof';

/* small hooks */
export function useTyped(text: string, active: boolean, perChar: number) {
  const [n, setN] = useState(active ? 0 : text.length);
  useEffect(() => {
    if (!active) return;
    setN(0);
    const id = setInterval(() => setN((k) => (k >= text.length ? k : k + 1)), perChar);
    return () => clearInterval(id);
  }, [active, text, perChar]);
  return active ? text.slice(0, n) : text;
}

/** The recorded gate evidence is cut at 40 characters, sometimes mid-word: drop the broken last word. */
const tidyObs = (v: unknown) => { const t = String(v ?? ''); return t.length >= 40 && !/\s$/.test(t) && t.includes(' ') ? t.slice(0, t.lastIndexOf(' ')) + '…' : t; };
function useReveal(total: number, active: boolean, every: number) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    setN(0);
    const id = setInterval(() => setN((k) => Math.min(total, k + 1)), every);
    return () => clearInterval(id);
  }, [active, total, every]);
  return active ? n : total;
}

/* links */
export function HashLink({ hash, kind = 'tx', label }: { hash: string; kind?: 'tx' | 'address'; label?: string }) {
  const href = kind === 'tx' ? txUrl(hash) : addrUrl(hash);
  const text = label ?? short(hash);
  if (!href) return <span className="mono sh-hash" title={hash}>{text}</span>;
  return (
    <a className="mono sh-hash sh-link" href={href} target="_blank" rel="noopener noreferrer" title={hash}>
      {text} <span aria-hidden="true">↗</span>
      <span className="sr-only"> (opens the block explorer in a new tab)</span>
    </a>
  );
}

/* Left panel: agent */
export function SnapshotCard({ proposed }: { proposed: boolean }) {
  const buyId = run.accepted?.buyOfferId, sellId = run.accepted?.sellOfferId;
  const offers: any[] = snapshot.offers ?? [];
  const target = offers.find((o) => o.id === buyId)?.attributes ?? {};
  const diffs = (o: any) => {
    const out: string[] = [];
    for (const k of Object.keys(target)) {
      const v = o.attributes?.[k];
      if (v === undefined) out.push(`${k} missing`);
      else if (v !== target[k]) out.push(`${k}: ${v}`);
    }
    return out;
  };
  return (
    <section className="sh-card" aria-label="Market snapshot the agent saw">
      <h3>What the agent saw <span className="pill warn">a fixed snapshot, not a live feed</span></h3>
      <p className="sh-gl">A frozen list of {offers.length} offers. Its fingerprint (<span className="mono">snapshotHash {short(run.meta.snapshotHash, 8, 6)}</span>) is committed on-chain so anyone can later check what the agent was shown.</p>
      <ul className="sh-offers">
        {offers.map((o) => {
          const role = proposed ? (o.id === buyId ? 'BUY' : o.id === sellId ? 'SELL' : '') : '';
          const d = proposed && !role ? diffs(o) : [];
          return (
            <li key={o.id} className={role ? 'pick' : ''}>
              <span className="mono sh-oid">{o.id}</span>
              <span className="sh-otitle">{o.title}</span>
              <span className="mono sh-oprice">{usd(o.priceCents)}</span>
              {role && <span className="pill ok">{role}</span>}
              {proposed && !role && (
                <span className="sh-skip">{d.length ? `skipped, differs: ${d.join(', ')}` : 'same product, not chosen'}</span>
              )}
            </li>
          );
        })}
      </ul>
      {proposed && <p className="sh-gl">Differences are shown for context only; the real identity check is the gate step below.</p>}
    </section>
  );
}

export function ThinkingCard({ step, animate }: { step: Step; animate: boolean }) {
  return (
    <section className="sh-card" aria-label="Agent thinking">
      <h3>Agent <span className="pill blue mono">language model</span></h3>
      <p className="sh-gl">The AI model only proposes deals. It holds no money and cannot move any.</p>
      <p className={'mono sm ' + (animate ? 'sh-pulse' : '')}>{step.ev.title}{animate ? '…' : ''}</p>
    </section>
  );
}

export function Reasoning({ items, currentI, animate, perChar }: { items: Step[]; currentI: number; animate: boolean; perChar: number }) {
  return (
    <section className="sh-card" aria-label="Agent reasoning">
      <h3>Reasoning <span className="pill">as written by the model</span></h3>
      <ol className="sh-reason">
        {items.map((s) => <ReasonLine key={s.i} step={s} active={animate && s.i === currentI} perChar={perChar} />)}
      </ol>
    </section>
  );
}
function ReasonLine({ step, active, perChar }: { step: Step; active: boolean; perChar: number }) {
  const t = useTyped(step.ev.title, active, perChar);
  const skipped = /^skipped/i.test(step.ev.title);
  return (
    <li data-step={step.i} className={skipped ? 'skip-line' : ''}>
      <span aria-hidden="true">{t}{active && t.length < step.ev.title.length && <i className="sh-caret" />}</span>
      <span className="sr-only">{step.ev.title}</span>
    </li>
  );
}

export function ProposalCard({ step }: { step: Step }) {
  const p = step.ev.data.proposal;
  const offers: any[] = snapshot.offers ?? [];
  const buy = offers.find((o) => o.id === p.buyOfferId), sell = offers.find((o) => o.id === p.sellOfferId);
  return (
    <section className="sh-card sh-proposal" data-step={step.i} aria-label="Agent proposal">
      <h3>Proposal <span className="pill blue">agent output</span></h3>
      <div className="sh-prop-grid">
        <div><small>Buy</small><b className="mono">{p.buyOfferId}</b>{buy && <span className="muted xs">{buy.source} · {usd(buy.priceCents)} + {usd(buy.shipCents)} shipping</span>}</div>
        <div className="sh-arrow" aria-hidden="true">→</div>
        <div><small>Sell</small><b className="mono">{p.sellOfferId}</b>{sell && <span className="muted xs">{sell.source} · {usd(sell.priceCents)}</span>}</div>
        <div><small>Units</small><b className="mono">{int(p.units)}</b></div>
      </div>
      <p className="sh-gl">A proposal is only a request. Nothing below happens until the checks pass.</p>
    </section>
  );
}

export function GateCard({ step }: { step: Step }) {
  const d = step.ev.data;
  const isBuy = d.offerId === run.accepted?.buyOfferId;
  const isSell = d.offerId === run.accepted?.sellOfferId;
  return (
    <section className="sh-card" data-step={step.i} aria-label={`Identity gate: ${d.offerId}`}>
      <h3>
        Identity gate <span className="mono">{d.offerId}</span>
        {(isBuy || isSell) && <span className="pill">{isBuy ? 'buy side' : 'sell side'}</span>}
        <span className={'sh-verdict ' + (d.locked ? 'locked' : 'rejected')}>{d.locked ? 'LOCKED' : 'REJECTED'}</span>
      </h3>
      <p className="sh-gl">Identity gate = a checklist proving both listings are the exact same product. Run in TypeScript off-chain; the contract only stores a hash of the product, it does not check identity.</p>
      <ul className="sh-gates">
        {d.gates.map((g: any) => (
          <li key={g.gate} className={g.pass ? 'ok' : 'bad'}>
            <span className="sh-gmark" aria-hidden="true">{g.pass ? '✓' : '✕'}</span>
            <span className="sh-gname">{humanize(g.gate)}</span>
            <span className="mono xs sh-gval">{g.expected} {g.pass ? '=' : '≠'} {tidyObs(g.observed)}</span>
            {!g.hard && <span className="pill" title="Soft check: informative, cannot reject on its own">soft</span>}
            <span className="sr-only">{g.pass ? 'passed' : 'failed'}</span>
          </li>
        ))}
      </ul>
      {step.ev.detail && <p className="mono xs muted">{step.ev.detail}</p>}
    </section>
  );
}

const LABELS: Record<string, string> = {
  landed: 'Landed cost (everything paid per unit)',
  marketplaceFee: 'Marketplace fee (rounded up)',
  returnReserve: 'Return reserve (rounded up)',
  net: 'Net profit per unit',
  marginBps: 'Margin',
  breakeven: 'Total cost per unit at this sell price',
  totalCost: 'Total cost per unit at this sell price',
};
export function EconCard({ step, active, every }: { step: Step; active: boolean; every: number }) {
  const proof: any[] = step.ev.data.proof ?? [];
  const shown = useReveal(proof.length, active, every);
  const d = step.ev.data;
  return (
    <section className="sh-card" data-step={step.i} aria-label="Unit economics proof">
      <h3>Unit economics <span className="pill">integer cents</span></h3>
      <p className="sh-gl">The exact arithmetic the contract will re-run on its own. Fees are rounded up so profit is never overstated. 1 basis point (bps) = 0.01%.</p>
      <ol className="sh-proof">
        {proof.slice(0, shown).map((l) => {
          const isBps = /bps/i.test(l.label);
          return (
            <li key={l.label}>
              <span className="sh-plabel">{LABELS[l.label] ?? humanize(l.label)}</span>
              <span className="mono xs sh-pformula">{l.formula}</span>
              <span className="mono sh-pres">= {isBps ? `${l.resultCents} bps (${pct(l.resultCents)})` : usd(l.resultCents)}</span>
            </li>
          );
        })}
      </ol>
      {shown >= proof.length && d.units != null && (
        <p className="mono sm sh-spend">{int(d.units)} units × {usd(d.landedCents)} landed = <b>{usd(d.spendCents)}</b> total spend (derived, not claimed)</p>
      )}
    </section>
  );
}

/* Right panel: chain */
// showNow: the 'on chain now' mandate line renders once per page; the walkthrough's done state shows it in FinalCard instead.
export function MandateCard({ step, proof, showNow = true }: { step: Step; proof: ChainProof; showNow?: boolean }) {
  const p = run.policy, m = run.meta;
  const d = step.ev.data ?? {};
  const rows: [string, string, string][] = [
    ['Per-trade cap', usd(Number(p.maxExec)), 'most the agent can commit to one purchase'],
    ['Daily cap', usd(Number(p.dailySpendCap)), 'most new buying it can commit to per UTC day (not a cash-out limit)'],
    ['Margin floor', pct(Number(p.minMarginBps)), 'minimum profit as a share of the sale price'],
    ['Quote freshness', `${p.quoteTTL}s`, 'quotes the agent dates as older are rejected (the agent supplies the date)'],
  ];
  if (d.vaultFree != null) rows.push(['Vault funds', fromUnits(d.vaultFree), 'owner’s money held by the contract']);
  return (
    <section className="sh-card" data-step={step.i} aria-label="On-chain mandate">
      <h3>Mandate <span className="pill good">set by the owner</span></h3>
      <p className="sh-gl">The mandate is the rulebook the owner wrote into the contract. The agent cannot edit it.</p>
      <dl className="sh-kv">
        {rows.map(([k, v, g]) => (
          <div key={k}><dt>{k}<small>{g}</small></dt><dd className="mono">{v}</dd></div>
        ))}
      </dl>
      {showNow && <MandateNow mandate={proof.report?.mandate ?? null} status={proof.status} />}
      <div className="sh-roles">
        <div><small>Contract</small><HashLink kind="address" hash={m.core} label={short(m.core, 8, 6)} /></div>
        <div><small>Owner (sets rules)</small><span className="mono sh-hash" title={m.owner}>{short(m.owner, 8, 6)}</span></div>
        <div><small>Agent (proposes only)</small><span className="mono sh-hash" title={m.agent}>{short(m.agent, 8, 6)}</span></div>
        <div><small>Supplier (approved payee)</small><span className="mono sh-hash" title={m.supplier}>{short(m.supplier, 8, 6)}</span></div>
      </div>
    </section>
  );
}

export function VaultCard({ v, total, start }: { v: Vault; total: number; start: number }) {
  const w = (x: number) => `${Math.max(0, Math.min(100, (x / total) * 100))}%`;
  return (
    <section className="sh-card" aria-label="Vault balance">
      <h3>Vault <span className="pill">mUSDG</span></h3>
      <p className="sh-gl">The vault is the contract-held pot of money. Escrow = money locked for one specific purchase. Paid out = released to the approved supplier.</p>
      <div className="sh-vbar" role="img" aria-label={`Free ${fromUnits(v.free)}, escrow ${fromUnits(v.escrow)}, paid out ${fromUnits(v.paid)}`}>
        <i className="free" style={{ width: w(v.free) }} />
        <i className="escrow" style={{ width: w(v.escrow) }} />
        <i className="paid" style={{ width: w(v.paid) }} />
        <u style={{ left: w(start) }} title="Amount originally deposited" />
      </div>
      <div className="sh-legend">
        <div><i className="free" /><small>Free</small><b className="mono">{fromUnits(v.free)}</b></div>
        <div><i className="escrow" /><small>In escrow</small><b className="mono">{fromUnits(v.escrow)}</b></div>
        <div><i className="paid" /><small>Paid out</small><b className="mono">{fromUnits(v.paid)}</b></div>
      </div>
      {v.proceeds > 0 && <p className="mono xs muted">Sale proceeds received: {fromUnits(v.proceeds)} (tick marks the original deposit)</p>}
    </section>
  );
}

export function TxList({ items, currentI, proof }: { items: Step[]; currentI: number; proof: ChainProof }) {
  return (
    <section className="sh-card" aria-label="Transactions">
      <h3>Transactions <span className="pill">{items.length}</span></h3>
      <p className="sh-gl">Each row is an on-chain transaction. Gas = the fee the network charges for running it.</p>
      <ol className="sh-txs">
        {items.map((s) => {
          const tx = s.ev.tx!;
          const failed = s.isFailedTx;
          const attested = !!s.fn && ATTESTED.includes(s.fn);
          const rem = s.ev.title.replace(/^\w+:?\s*/, '').replace(/\(agent-attested\)/i, '').trim();
          const text = failed ? s.ev.title : rem || (s.fn ? FN_GLOSS[s.fn] : '') || '';
          return (
            <li key={s.i} data-step={s.i} className={'sh-tx' + (failed ? ' failed' : '') + (s.i === currentI ? ' now' : '')}>
              <div className="sh-tx-top">
                <span className={'pill ' + (failed ? 'bad' : 'good')}>{failed ? 'REVERTED' : 'SUCCESS'}</span>
                {s.fn && <span className="mono sh-fn">{s.fn}</span>}
                {attested && <span className="pill warn" title="The contract cannot see the real world; the agent says this happened.">agent-attested</span>}
              </div>
              <p className="sh-tx-title">{text}</p>
              {s.ev.detail && !failed && <p className="mono xs muted">{s.ev.detail}</p>}
              <div className="mono xs sh-tx-meta">
                <span>block {int(tx.block)}</span><span>gas {int(tx.gasUsed)}</span>
                <HashLink hash={tx.hash} />
              </div>
              <ProofBadge proof={proofFor(proof.report, tx.hash)} status={proof.status} />
              {failed && <p className="xs sh-gl">A reverted transaction is one the blockchain refused and undid. It still costs gas and leaves a public record.</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function BlockedList({ items }: { items: Step[] }) {
  return (
    <section className="sh-card" aria-label="Blocked attempts">
      <h3>Blocked attempts <span className="pill bad">{items.length}</span></h3>
      <ul className="sh-blocked">
        {items.map((s) => (
          <li key={s.i} data-step={s.i}>
            <span className="mono sh-err">✕ {s.ev.data?.error}</span>
            <span className="xs">{s.ev.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* Attack theater */
export function Theater({ step, index, total, onHide, proof }: { step: Step; index: number; total: number; onHide: () => void; proof: ChainProof }) {
  const ev = step.ev;
  const d = ev.data ?? {};
  const attack = run.attacks?.find((a: any) => a.name === ev.title);
  const error: string | undefined = attack?.error ?? d.error;
  const args: string[] = attack?.args ?? d.args ?? [];
  const sentence = attack?.sentence ?? ev.detail ?? ev.title;
  const units = Number(run.accepted?.units ?? 0);
  const claimed = Number(args[0]), derived = Number(args[1]);
  return (
    <div className="sh-theater" role="region" aria-label="Refused request">
      <div className={'sh-tcard' + (step.isBig ? ' big' : '')} key={step.i} data-follow={step.i}>
        <button className="sh-hide" onClick={onHide} aria-label="Hide this overlay">Hide</button>
        <div className="sh-stamp" aria-hidden="true">{step.isFailedTx ? 'FAILED ON-CHAIN' : 'REVERTED'}</div>
        {step.isFailedTx ? (
          <>
            <p className="sh-kicker">Real failed transaction</p>
            <p className="sh-sentence" aria-live="polite">{ev.title}</p>
            <div className="sh-failtx">
              <span className="pill bad">status: {ev.tx!.status}</span>
              <span className="mono sm">block {int(ev.tx!.block)}</span>
              <span className="mono sm">gas {int(ev.tx!.gasUsed)}</span>
              <HashLink hash={ev.tx!.hash} label={short(ev.tx!.hash, 14, 10)} />
            </div>
            <ProofBadge proof={proofFor(proof.report, ev.tx!.hash)} status={proof.status} />
            <p className="sh-gl">The contract refused the tampered numbers and undid the transaction; no money moved.{net.real ? ' Open the explorer link to see the failed status on the public record.' : ' This run is from a local chain, so there is no public explorer page.'}</p>
          </>
        ) : (
          <>
            <p className="sh-kicker">Refused {index} of {total} · {ev.title}</p>
            <p className="sh-sentence" aria-live="polite">{sentence}</p>
            {step.isBig && Number.isFinite(claimed) && Number.isFinite(derived) && (
              <div className="sh-versus" aria-label="Claimed versus contract-derived net profit">
                <div className="lie"><small>Agent claimed (per unit)</small><b className="mono">{usd(claimed)}</b>{units > 0 && <span className="mono xs">{int(units)} units = {usd(claimed * units)}</span>}</div>
                <div className="vs" aria-hidden="true">≠</div>
                <div className="truth"><small>Contract derived (per unit)</small><b className="mono">{usd(derived)}</b>{units > 0 && <span className="mono xs">{int(units)} units = {usd(derived * units)}</span>}</div>
              </div>
            )}
            {error && ERR_GLOSS[error] && <p className="sh-gl sh-why">{ERR_GLOSS[error]}</p>}
            <p className="mono xs sh-decoded">error {error}({args.join(', ')})</p>
            {!ev.tx && <p className="xs muted">Decoded from a dry run of the agent&rsquo;s transaction (eth_call). The contract refused it; no state changed.</p>}
          </>
        )}
      </div>
    </div>
  );
}

/* Final frame */
export function FinalCard({ steps, proof }: { steps: Step[]; proof: ChainProof }) {
  const { end, meta } = run;
  const econ = run.events.find((e) => e.kind === 'econ');
  const pol = run.events.find((e) => e.kind === 'policy');
  const units = Number(run.accepted?.units ?? econ?.data?.units ?? 0);
  const predicted = Number(econ?.data?.netCents ?? 0) * units; // cents, contract-derived
  const realized = (Number(end.totalProceeds) - Number(end.totalPaidOut)) / 10000; // cents
  const match = predicted === realized;
  const dep = Number(pol?.data?.vaultFree ?? 0);
  const left = Number(end.free) + Number(end.totalEscrow) + Number(end.totalPaidOut);
  const rightSide = dep + Number(end.totalProceeds);
  const conserved = left === rightSide;
  const txs = steps.filter((s) => s.kind === 'tx');
  const failed = txs.filter((s) => s.isFailedTx).length;
  const blocked = steps.filter((s) => s.kind === 'revert').length;
  return (
    <section className="sh-final" id="final" aria-label="Final result">
      <h2>Settled profit against the contract's net</h2>
      <ProofSummary proof={proof} total={txs.length} chain={net.name} id="proof" />
      <MandateNow mandate={proof.report?.mandate ?? null} status={proof.status} />
      <div className="sh-versus final">
        <div className="truth"><small>Contract-derived net</small><b className="mono">{usd(predicted)}</b><span className="mono xs">{int(units)} units × {usd(Number(econ?.data?.netCents ?? 0))}</span></div>
        <div className={'vs ' + (match ? 'okk' : 'badd')} aria-hidden="true">{match ? '=' : '≠'}</div>
        <div className="truth"><small>Settled P&amp;L (tokens received − paid out, owner’s test wallet)</small><b className="mono">{usd(realized)}</b><span className="mono xs">{fromUnits(end.totalProceeds)} − {fromUnits(end.totalPaidOut)}</span></div>
      </div>
      <p className={'sh-verdict-line ' + (match ? 'ok' : 'bad')}>{match ? BY_CONSTRUCTION : 'WARNING: realized profit does not equal the contract-derived net in this run.'}</p>
      {proceeds.ok && <p className="sh-gl">{proceeds.sentence}</p>}
      <div className="sh-conserve mono sm">
        <span className="muted">Conservation</span>
        <span>free {fromUnits(end.free)} + escrow {fromUnits(end.totalEscrow)} + paid out {fromUnits(end.totalPaidOut)} = <b>{fromUnits(left)}</b></span>
        <span>deposited {fromUnits(dep)} + proceeds {fromUnits(end.totalProceeds)} = <b>{fromUnits(rightSide)}</b></span>
        <span className={conserved ? 'okk' : 'badd'}>{conserved ? '✓ no money created or lost' : '✕ does not balance'}</span>
      </div>
      <dl className="sh-facts">
        <div><dt>Contract</dt><dd><HashLink kind="address" hash={meta.core} label={meta.core} /></dd></div>
        <div><dt>Transactions</dt><dd className="mono">{txs.length} on-chain ({txs.length - failed} succeeded, {failed} reverted) · {blocked} refused requests checked with dry runs</dd></div>
        <div><dt>Network</dt><dd className="mono">{net.name}</dd></div>
      </dl>
      <VerifyList
        proof={proof}
        txs={run.events.filter((e) => e.tx).map((e) => ({ id: e.id, title: e.title, hash: e.tx!.hash }))}
        addresses={[
          { label: 'Vault contract (SKUdeskCore)', address: meta.core },
          { label: 'Test token (mUSDG)', address: meta.token },
          { label: 'Agent (sent every transaction)', address: meta.agent },
        ]}
      />
      <p className="sh-honest"><b>Honesty line.</b> This is a finished run{provenance.date ? ` from ${provenance.date}` : ''}, not a live one: this page walks through it{checkClaim(provenance.txCount).clause ? ` and ${checkClaim(provenance.txCount).clause}. ${EXPLORER_NOTE}` : '.'} Market prices were a fixed snapshot, and the contract proves the arithmetic and the budget, not that the prices were true. Buying, receiving, listing and selling are agent-attested. Settlement uses test USDG (mUSDG), a testnet stand-in token.</p>
    </section>
  );
}
