import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './desk.css';
import WorkflowDiagram from './WorkflowDiagram';
import { STAGE_NAMES, guardOfEvent, isFailedTx, stageOfEvent } from './model';
import { CHAIN, RUN, TXS, explorer, short, type RunEvent } from '../../lib/run';
import { proofFor } from '../../lib/chain-proof';
import { useChainProof } from '../proof/useChainProof';
import { ProofBadge, ProofSummary } from '../proof/Proof';
import { useRevealOnce } from '../motion/useRevealOnce';

const EVENTS = RUN.events;
const N = EVENTS.length;
const seconds = (ms: number) => (ms / 1000).toFixed(1) + 's';
const KIND_LABEL: Record<string, string> = {
  policy: 'mandate', snapshot: 'snapshot', agent: 'agent', reason: 'reasoning', gate: 'gate', econ: 'economics', tx: 'transaction', revert: 'refused', state: 'result',
};

const lcfirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
// The one reverted transaction is an attack the contract refused on purpose (an expected result), not a failure of the run.
// Its words come from the run's own attack, so a visitor without JavaScript, before any chain check, reads it as a refusal.
function wording(e: RunEvent): { title: string; detail?: string; kind: string; expected: boolean } {
  if (isFailedTx(e)) {
    const attack = RUN.attacks.find((a) => a.error === guardOfEvent(e));
    return {
      expected: true, kind: 'expected revert',
      title: attack ? `Refused on purpose, on chain: ${lcfirst(attack.name)}` : e.title,
      detail: attack ? `${attack.sentence} The refused transaction is visible on the explorer.` : e.detail,
    };
  }
  return { expected: false, kind: KIND_LABEL[e.kind] ?? e.kind, title: e.title, detail: e.detail };
}

// The whole run is on screen from the first paint (also without JavaScript): every event, and every transaction with its
// explorer link. The controls only choose which event the diagram explains; nothing is played back. The run's
// transactions are compared with the chain, according to the public RPC, once when the log comes near the viewport (components/proof).
export default function AgentDesk({ children }: { children?: ReactNode }) {
  const [cur, setCur] = useState(N); // the event the diagram explains, 1..N; starts at the end of the run
  const moved = useRef(false);       // the log scrolls itself only after the visitor picks an event
  const logRef = useRef<HTMLOListElement>(null);
  const logBox = useRef<HTMLElement>(null);
  const diagRef = useRef<HTMLElement>(null);
  const proof = useChainProof(logBox);
  const reveal = useRevealOnce(logRef);

  const ev: RunEvent = EVENTS[cur - 1];
  const stage = stageOfEvent(ev);
  const guard = guardOfEvent(ev) ?? null;

  /* keep the selected row visible inside the log only (never scrolls the page) */
  useEffect(() => {
    const box = logRef.current;
    if (!box || !moved.current) return;
    const row = box.querySelector<HTMLElement>(`[data-i="${cur}"]`);
    if (!row) return;
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top - 8;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8;
  }, [cur]);

  const prev = () => { if (cur > 1) go(cur - 1); };   // aria-disabled at the ends (not `disabled`): the button keeps keyboard focus
  const next = () => { if (cur < N) go(cur + 1); };
  const go = (i: number) => { moved.current = true; setCur(Math.max(1, Math.min(N, i))); };
  const jump = (i: number, fromLog = false) => {
    go(i);
    if (fromLog) {
      const el = diagRef.current;
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  };
  const stageRail = useMemo(() => STAGE_NAMES.map((s, i) => ({ s, i })), []);

  return (
    <div className="dk-desk">
      <section className="card dk-diagram" aria-label="Workflow diagram" ref={diagRef}>
        <div className="dk-stages" role="list" aria-label="Stages of the run">
          {stageRail.map(({ s, i }) => (
            <span key={s} role="listitem" className={'dk-stage' + (stage === i ? ' on' : '') + (i === 4 ? ' atk' : '') + (i < stage ? ' done' : '')} aria-current={stage === i ? 'step' : undefined}>
              <b>{i + 1}</b><span>{s}</span>
            </span>
          ))}
        </div>
        <WorkflowDiagram stage={stage} highlightGuard={guard} />
        <div className="dk-bar" role="group" aria-label="Pick the event the diagram explains">
          <button className="btn ghost" onClick={prev} aria-disabled={cur <= 1 ? true : undefined} aria-label="Previous event"><span aria-hidden="true">‹</span> Previous</button>
          <button className="btn ghost" onClick={next} aria-disabled={cur >= N ? true : undefined} aria-label="Next event">Next <span aria-hidden="true">›</span></button>
          <label className="dk-scrub">
            <span className="sr-only">Pick one of the {N} events</span>
            <input type="range" min={1} max={N} step={1} value={cur} onChange={(e) => jump(Number(e.target.value))} aria-valuetext={`event ${cur} of ${N}: ${ev.title}`} />
          </label>
          <span className="dk-count mono xs">{`Event ${cur} of ${N}`}</span>{/* one text node: Astro's server render puts <!-- --> between adjacent text nodes */}
        </div>
      </section>

      <div className="dk-below">
      <section className="card dk-log" aria-label="Event log" ref={logBox}>
        <h2>Event log <span className="pill">{N} events</span></h2>
        <p className="note">Every row is one thing that happened in the run, in order. Select a row to see where it happens in the diagram. Times are seconds since the run started.</p>
        <ProofSummary proof={proof} total={TXS.length} chain={CHAIN.name} />
        <ol className="dk-rows" ref={logRef} data-reveal={reveal === 'armed' || reveal === 'run' ? reveal : undefined}>
          {EVENTS.map((e, idx) => {
            const i = idx + 1;
            const state = i === cur ? 'now' : i < cur ? 'past' : 'future';
            const w = wording(e);
            const refused = e.kind === 'revert';
            const href = e.tx ? explorer.tx(e.tx.hash) : '';
            return (
              <li key={e.id} data-i={i} className={`dk-row ${state}${refused ? ' bad' : w.expected ? ' exp' : ''}`} aria-current={state === 'now' ? 'true' : undefined} style={{ '--i': idx } as CSSProperties}>
                <button className="dk-row-btn" onClick={() => jump(i, true)} aria-label={`Explain event ${i}, ${w.kind}: ${w.title}`}>
                  <span className="dk-t mono xs">{seconds(e.at)}</span>
                  <span className={`dk-kind mono xs k-${refused ? 'bad' : w.expected ? 'exp' : e.kind}`}>{w.kind}</span>
                  <span className="dk-title">{w.title}</span>
                </button>
                {(w.detail || e.tx) && (
                  <div className="dk-detail">
                    {w.detail && <span className="dk-d">{w.detail}</span>}
                    {e.tx && (
                      <span className="dk-tx mono xs">
                        <span className={'pill ' + (e.tx.status === 'success' ? 'good' : w.expected ? 'warn' : 'bad')}>{w.expected ? 'expected revert' : e.tx.status}</span>
                        <span>block {e.tx.block}</span>
                        <span>gas {Number(e.tx.gasUsed).toLocaleString('en-US')}</span>
                        {href && <a className="dk-link" href={href} target="_blank" rel="noopener noreferrer">{short(e.tx.hash, 8, 6)} ↗<span className="sr-only"> (opens the block explorer in a new tab)</span></a>}
                      </span>
                    )}
                    {e.tx && <ProofBadge proof={proofFor(proof.report, e.tx.hash)} status={proof.status} />}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>
      {children && <div className="dk-side">{children}</div>}
      </div>
    </div>
  );
}
