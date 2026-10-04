import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { run, net, buildScript, deriveMoney, vaultAt, STAGES, eyebrowText } from './lib';
import WorkflowDiagram from '../flow/WorkflowDiagram';
import { guardOfEvent } from '../flow/model';
import {
  SnapshotCard, ThinkingCard, Reasoning, ProposalCard, GateCard, EconCard,
  MandateCard, VaultCard, TxList, BlockedList, Theater, FinalCard,
} from './parts';
import { useChainProof } from '../proof/useChainProof';
import { ProofPill } from '../proof/Proof';

const SPEEDS = [1, 1.5, 2, 0.75];
const clampSpeed = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(4, Math.max(0.25, n)) : 1);

// /show: one finished agent run. The first paint already shows the result and the evidence: every transaction links to the
// explorer and is checked against the chain once the page is open. "Walk through the run" is an optional step-by-step
// explainer over the same data. Nothing here is live, and nothing is presented as if it were happening now.
/** Every step is about 12% shorter than its recorded dwell time. The x1 label keeps meaning "normal pace". */
const PACE = 1.14;
export default function Player() {
  const steps = useMemo(() => buildScript(run), []);
  const money = useMemo(() => deriveMoney(run), []);
  const last = steps.length - 1;
  const attackSteps = steps.filter((s) => s.kind === 'revert');

  const [cur, setCur] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [reduced, setReduced] = useState(false);
  const [hidden, setHidden] = useState(-2); // step index whose overlay the viewer dismissed
  const [mapOpen, setMapOpen] = useState(false); // closed on the opening view so the evidence comes first; opens when the walkthrough starts
  const rootRef = useRef<HTMLDivElement>(null);
  const proof = useChainProof(rootRef);

  /* URL params + reduced-motion, client only */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has('speed')) setSpeed(clampSpeed(parseFloat(q.get('speed') ?? '')));
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    if (q.get('autoplay') === '1') setPlaying(true);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  /* The walkthrough: current step index -> next step after its dwell time. */
  useEffect(() => {
    if (!playing) return;
    if (cur >= last) { setPlaying(false); return; }
    const d = cur < 0 ? 0 : steps[cur].dwell / (speed * PACE);
    const t = setTimeout(() => setCur((c) => c + 1), d);
    return () => clearTimeout(t);
  }, [playing, cur, speed, last, steps]);

  const started = cur >= 0;
  const done = cur >= last && last >= 0;
  const step = started ? steps[cur] : undefined;
  const visible = useMemo(() => steps.slice(0, cur + 1), [steps, cur]);

  /* The diagram follows the walkthrough: it opens once when it starts, and afterwards stays as the visitor left it. */
  const wasStarted = useRef(false);
  useEffect(() => {
    if (started && !wasStarted.current) setMapOpen(true);
    wasStarted.current = started;
  }, [started]);

  /* Keep the newest thing on screen */
  useEffect(() => {
    if (cur < 2) return;
    const root = rootRef.current;
    if (!root) return;
    const el = (root.querySelector(`[data-follow="${cur}"]`) ?? root.querySelector(`[data-step="${cur}"]`)) as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [cur, reduced]);
  useEffect(() => {
    if (done) rootRef.current?.querySelector('#final')?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [done, reduced]);

  /* Controls: walk through, pause/resume, step; at the end, go back to the opening view (a navigation, not a re-run). */
  const toStart = useCallback(() => {
    setPlaying(false); setCur(-1); setHidden(-2);
    rootRef.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [reduced]);
  const play = useCallback(() => {
    if (done) { toStart(); return; }
    setPlaying((p) => !p);
  }, [done, toStart]);
  const next = useCallback(() => { setPlaying(false); setCur((c) => Math.min(last, c + 1)); }, [last]);
  const cycleSpeed = () => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] ?? 1);

  const playLabel = done ? 'Back to start' : playing ? 'Pause' : started ? 'Resume' : 'Walk through the run';
  const playIcon = done ? '«' : playing ? '❚❚' : '▶';
  const perChar = Math.max(4, 14 / (speed * PACE));

  /* Derived views */
  const activeStage = step ? step.stage : -1;
  const vault = vaultAt(steps, cur, money);
  const policy = visible.find((s) => s.kind === 'policy');
  const txs = visible.filter((s) => s.kind === 'tx');
  const blocked = visible.filter((s) => s.kind === 'revert');
  const showTheater = !!step && step.isAttack && hidden !== cur;
  const theaterIdx = step ? (step.isFailedTx ? 0 : attackSteps.findIndex((s) => s.i === step.i) + 1) : 0;
  const proposed = visible.some((s) => s.isProposal);

  /* Left column: render steps in order; consecutive reasons collapse into one list. */
  const left: JSX.Element[] = [];
  for (let k = 0; k < visible.length; k++) {
    const s = visible[k];
    const isCur = s.i === cur && playing;
    if (s.kind === 'snapshot') left.push(<div key={s.i} data-step={s.i}><SnapshotCard proposed={proposed} /></div>);
    else if (s.kind === 'agent' && !s.isProposal) left.push(<div key={s.i} data-step={s.i}><ThinkingCard step={s} animate={isCur} /></div>);
    else if (s.kind === 'reason') {
      const group = [s];
      while (visible[k + 1]?.kind === 'reason') group.push(visible[++k]);
      left.push(<Reasoning key={'r' + s.i} items={group} currentI={cur} animate={!reduced && playing} perChar={perChar} />);
    } else if (s.isProposal) left.push(<ProposalCard key={s.i} step={s} />);
    else if (s.kind === 'gate') left.push(<GateCard key={s.i} step={s} />);
    else if (s.kind === 'econ') left.push(<EconCard key={s.i} step={s} active={s.i === cur && !reduced} every={Math.max(120, 750 / (speed * PACE))} />);
  }

  return (
    <div ref={rootRef} className={'sh-player' + (started ? ' started' : '')}>
      <section className={'sh-hero' + (started ? ' compact' : '')}>
        <p className="sh-eyebrow mono">{eyebrowText}</p>
        <h1>Watch an AI agent trade inside limits the contract enforces.</h1>
        {!started && (
          <p className="sh-sub">A smart contract holds the money and re-does the agent&rsquo;s math. This is one finished run: the AI proposed a deal, the contract checked it. We then made the agent try {run.attacks.length} things it must not do, and the contract refused all {run.attacks.length}.</p>
        )}
      </section>

      <div className="sh-bar" role="group" aria-label="Walkthrough controls and progress">
        <div className="sh-ctl">
          <button className={'btn' + (!started ? ' lg' : '')} onClick={play} aria-label={playLabel}>
            <span aria-hidden="true">{playIcon}</span> {playLabel}
          </button>
          <button className="btn ghost" onClick={next} disabled={done} aria-label="Step to the next event">Step <span aria-hidden="true">›</span></button>
          <button className="btn ghost sh-speed" onClick={cycleSpeed} aria-label={`×${speed} walkthrough speed`}>×{speed}</button>
          <span className="sh-prog mono xs" aria-live="off">{started ? `${cur + 1}/${steps.length}` : `${steps.length} events`}</span>
          <ProofPill proof={proof} />
        </div>
        <ol className="sh-rail" aria-label="Progress">
          {STAGES.map((s, i) => {
            const state = done || i < activeStage ? 'done' : i === activeStage ? 'on' : '';
            return (
              <li key={s.long} className={state} aria-current={state === 'on' ? 'step' : undefined}>
                <span className="sh-dotn" aria-hidden="true">{state === 'done' ? '✓' : i + 1}</span>
                <span className="sh-rl long">{s.long}</span><span className="sh-rl shortl">{s.short}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <details className="sh-map" open={mapOpen} onToggle={(e) => setMapOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary><span>How the pieces connect</span><small>{activeStage >= 0 ? `now: ${STAGES[activeStage].long}` : 'follows the walkthrough step by step'}</small></summary>
        <WorkflowDiagram stage={activeStage >= 0 ? activeStage : null} highlightGuard={step?.isAttack ? guardOfEvent(step.ev) ?? null : null} />
      </details>

      {!started && (
        <>
          <FinalCard steps={steps} proof={proof} />
          <ol className="sh-tiles">
            <li><b>1 · The owner sets a budget</b><span>A cap per purchase, a cap on new commitments per UTC day and a profit floor are written into the contract.</span></li>
            <li><b>2 · The agent proposes, the contract disposes</b><span>The contract recomputes every number itself instead of trusting the agent.</span></li>
            <li><b>3 · Bad requests are refused</b><span>Inflated profit, overspending, replays and stale-dated quotes are all turned down.</span></li>
          </ol>
        </>
      )}
      {started && (
        <>
          {done && <FinalCard steps={steps} proof={proof} />}
          <div className="sh-stage">
            {showTheater && step && (
              <Theater step={step} index={theaterIdx} total={attackSteps.length} onHide={() => setHidden(cur)} proof={proof} />
            )}
            <div className="sh-panels">
              <div className="sh-col" aria-label="Agent side, off-chain">
                <h2 className="sh-colh"><span>Agent</span><small>off-chain · proposes</small></h2>
                {left}
              </div>
              <div className="sh-col" aria-label="Chain side, on-chain">
                <h2 className="sh-colh"><span>Chain</span><small>on-chain · decides</small></h2>
                {policy && <MandateCard step={policy} proof={proof} showNow={!done} />}
                {policy && <VaultCard v={vault} total={money.total} start={money.start} />}
                {txs.length > 0 && <TxList items={txs} currentI={cur} proof={proof} />}
                {blocked.length > 0 && <BlockedList items={blocked} />}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
