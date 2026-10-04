// Checks the run against the chain once, when `target` comes near the viewport (never before first paint, never on a
// timer), and again only when the visitor asks. Without a public RPC (local dev chain) it never sends anything.
// The lifecycle lives in createProofController (no React, no DOM) so it is unit-tested; the hook is a thin wrapper.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { countTxs, verifyRun, type ProofInput, type ProofReport } from '../../lib/chain-proof';
import { CHAIN, RUN, TXS } from '../../lib/run';

export type ProofStatus = 'unavailable' | 'idle' | 'checking' | 'done';
export type ChainProof = { status: ProofStatus; report: ProofReport | null; check: () => void };
export type ProofState = { status: ProofStatus; report: ProofReport | null };

export const RUN_PROOF_INPUT: ProofInput = {
  rpc: CHAIN.rpc,
  txs: TXS.map((e) => ({ id: e.id, hash: e.tx.hash, block: e.tx.block, gasUsed: e.tx.gasUsed, status: e.tx.status })),
  from: RUN.meta.agent,
  to: RUN.meta.core,
  mandate: { core: RUN.meta.core, policy: RUN.policy },
};

export const initialProofState = (enabled: boolean): ProofState => ({ status: enabled ? 'idle' : 'unavailable', report: null });

/** The report shape the library uses when the RPC cannot be reached: every transaction 'unknown'. */
export function unreachableReport(input: ProofInput, at: number, reason: string): ProofReport {
  const txs = input.txs.map((t) => ({ id: t.id, hash: t.hash, state: 'unknown' as const, block: null, gasUsed: null, confirmations: null, diffs: [], reason }));
  return { reachable: false, head: null, checkedAt: at, txs, counts: countTxs(txs), mandate: null, reason };
}

export type ProofDeps = {
  enabled: boolean;
  verify: () => Promise<ProofReport>;
  unreachable: (reason: string) => ProofReport;
  /** Calls `onVisible` when the target is near the viewport; returns the cleanup. */
  observe: (onVisible: () => void) => () => void;
  onChange: (s: ProofState) => void;
};

export function createProofController(d: ProofDeps): { start(): void; check(): void; stop(): void } {
  let state = initialProofState(d.enabled);
  let stopped = false;
  let gen = 0;
  let fired = false;
  let unobserve: (() => void) | undefined;
  const drop = () => { const u = unobserve; unobserve = undefined; u?.(); };
  const set = (s: ProofState) => { state = s; d.onChange(s); };
  const run = () => {
    if (stopped || !d.enabled || state.status === 'checking') return;
    const mine = ++gen;
    set({ status: 'checking', report: state.report });
    const done = (r: ProofReport) => { if (!stopped && mine === gen) set({ status: 'done', report: r }); };
    let job: Promise<ProofReport>;
    try { job = d.verify(); } catch (e) { job = Promise.reject(e); }
    // A failing job ends as the unreachable report: the status never stays 'checking', and Check again is offered.
    job.then(done, () => done(d.unreachable('check failed')));
  };
  return {
    start() {
      if (stopped || !d.enabled || fired || unobserve) return;
      unobserve = d.observe(() => { if (fired) return; fired = true; drop(); run(); });
      if (fired) drop();   // the observer answered synchronously
    },
    check: run,
    stop() { stopped = true; drop(); },
  };
}

function observeNear(el: Element | null, onVisible: () => void): () => void {
  if (el && typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) onVisible(); }, { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }
  const t = setTimeout(onVisible, 0);
  return () => clearTimeout(t);
}

export function useChainProof(target: RefObject<Element>, input: ProofInput = RUN_PROOF_INPUT): ChainProof {
  const enabled = Boolean(input.rpc);
  const [state, setState] = useState<ProofState>(() => initialProofState(enabled));
  // The effect is keyed on the RPC, not on the input object: an inline object that is equal on every render must not start another check.
  const latest = useRef(input);
  latest.current = input;
  const ctl = useRef<ReturnType<typeof createProofController> | null>(null);

  useEffect(() => {
    const fresh = initialProofState(enabled);
    setState((s) => (s.status === fresh.status && s.report === null ? s : fresh));
    if (!enabled) return;
    const c = createProofController({
      enabled: true,
      verify: () => verifyRun(latest.current),
      unreachable: (reason) => unreachableReport(latest.current, Date.now(), reason),
      observe: (onVisible) => observeNear(target.current, onVisible),
      onChange: setState,
    });
    ctl.current = c;
    c.start();
    return () => { c.stop(); ctl.current = null; };
  }, [enabled, input.rpc, target]);

  const check = useCallback(() => ctl.current?.check(), []);
  return { status: state.status, report: state.report, check };
}
