// node --test test/site/proof-lifecycle.test.ts   (from apps/web)
// The lifecycle of the proof hook and the reveal hook as pure controllers with injected observe / verify / timer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNodeModule } from './helpers/bundle.ts';

type PState = { status: string; report: { reachable: boolean; marker?: string; counts: { total: number; unknown: number } } | null };
type Ctl = { start(): void; check(): void; stop(): void };
type Mod = {
  createProofController(d: unknown): Ctl;
  initialProofState(enabled: boolean): PState;
  unreachableReport(input: unknown, at: number, reason: string): { reachable: boolean; txs: { state: string }[]; counts: { total: number; unknown: number }; mandate: unknown; checkedAt: number; reason?: string };
  createRevealController(d: unknown): { start(): () => void };
  revealPlan(o: { reduced: boolean; hasIO: boolean; top: number; viewport: number }): 'skip' | 'arm';
  REVEAL_THRESHOLD: number;
  REVEAL_ROOT_MARGIN: string;
};
const mod = await loadNodeModule<Mod>(`
  export { createProofController, initialProofState, unreachableReport } from './src/components/proof/useChainProof.ts';
  export { createRevealController, revealPlan, REVEAL_THRESHOLD, REVEAL_ROOT_MARGIN } from './src/components/motion/useRevealOnce.ts';
`);

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
function rig(enabled = true) {
  const seen: PState[] = [];
  const jobs: { resolve(v: unknown): void; reject(e: unknown): void }[] = [];
  const obs = { cbs: [] as (() => void)[], off: 0, calls: 0 };
  let verifyThrows = false;
  const ctl = mod.createProofController({
    enabled,
    verify: () => { jobs.length; if (verifyThrows) throw new Error('sync boom'); return new Promise((resolve, reject) => jobs.push({ resolve, reject })); },
    unreachable: (reason: string) => ({ reachable: false, marker: 'unreachable:' + reason, counts: { total: 9, unknown: 9 } }),
    observe: (cb: () => void) => { obs.calls++; obs.cbs.push(cb); return () => { obs.off++; }; },
    onChange: (s: PState) => seen.push(s),
  });
  return { ctl, seen, jobs, obs, last: () => seen[seen.length - 1], throwOnVerify: () => { verifyThrows = true; } };
}
const rep = (marker: string) => ({ reachable: true, marker, counts: { total: 9, unknown: 0 } });

test('initial state: idle with a public RPC, unavailable without; a disabled controller never observes or verifies', () => {
  assert.deepEqual(mod.initialProofState(true), { status: 'idle', report: null });
  assert.deepEqual(mod.initialProofState(false), { status: 'unavailable', report: null });
  const r = rig(false);
  r.ctl.start(); r.ctl.check();
  assert.equal(r.obs.calls, 0); assert.equal(r.jobs.length, 0); assert.equal(r.seen.length, 0);
});

test('nothing is sent before the target is visible; one check when it becomes visible; never again on its own', async () => {
  const r = rig();
  r.ctl.start();
  await tick();
  assert.equal(r.jobs.length, 0); assert.equal(r.seen.length, 0);
  r.obs.cbs[0]();
  assert.equal(r.jobs.length, 1);
  assert.deepEqual(r.last(), { status: 'checking', report: null });
  r.jobs[0].resolve(rep('first'));
  await tick();
  assert.deepEqual(r.last(), { status: 'done', report: rep('first') });
  r.obs.cbs[0]();            // a second "visible" signal is ignored
  for (let i = 0; i < 5; i++) await tick();   // no polling, no timers
  assert.equal(r.jobs.length, 1);
  assert.equal(r.obs.calls, 1);
});

test('check() while checking is a no-op; after the result it runs again and the previous report stays visible meanwhile', async () => {
  const r = rig();
  r.ctl.start(); r.obs.cbs[0]();
  r.ctl.check(); r.ctl.check();
  assert.equal(r.jobs.length, 1);
  r.jobs[0].resolve(rep('one'));
  await tick();
  r.ctl.check();
  assert.equal(r.jobs.length, 2);
  assert.deepEqual(r.last(), { status: 'checking', report: rep('one') });
  r.ctl.check();
  assert.equal(r.jobs.length, 2);
  r.jobs[1].resolve(rep('two'));
  await tick();
  assert.deepEqual(r.last(), { status: 'done', report: rep('two') });
});

test('stop() (unmount) drops a late result, unobserves, and later calls do nothing', async () => {
  const r = rig();
  r.ctl.start(); r.obs.cbs[0]();
  const n = r.seen.length;
  r.ctl.stop();
  assert.equal(r.obs.off, 1);
  r.jobs[0].resolve(rep('late'));
  await tick();
  assert.equal(r.seen.length, n);
  r.ctl.check(); r.obs.cbs[0]();
  assert.equal(r.jobs.length, 1);
  assert.equal(r.seen.length, n);
});

test('stop() before the target is visible: a later visible signal starts nothing', () => {
  const r = rig();
  r.ctl.start(); r.ctl.stop();
  r.obs.cbs[0]();
  assert.equal(r.jobs.length, 0);
});

test('a failing verify never leaves "checking": it ends as the unreachable report and Check again works', async () => {
  const r = rig();
  r.ctl.start(); r.obs.cbs[0]();
  r.jobs[0].reject(new Error('boom'));
  await tick();
  assert.equal(r.last().status, 'done');
  assert.equal(r.last().report!.marker, 'unreachable:check failed');
  r.ctl.check();
  assert.equal(r.jobs.length, 2);
  r.jobs[1].resolve(rep('ok'));
  await tick();
  assert.equal(r.last().report!.marker, 'ok');
  const t = rig();
  t.throwOnVerify(); t.ctl.start(); t.obs.cbs[0]();
  await tick();
  assert.equal(t.last().status, 'done');
  assert.equal(t.last().report!.marker, 'unreachable:check failed');
});

test('unreachableReport has the shape the summary reads as "could not reach": all unknown, reachable false', () => {
  const input = { rpc: 'https://x', txs: [{ id: 1, hash: '0xaa', block: 1, gasUsed: '1', status: 'success' }, { id: 2, hash: '0xbb', block: 2, gasUsed: '2', status: 'reverted' }] };
  const r = mod.unreachableReport(input, 1000, 'check failed');
  assert.equal(r.reachable, false);
  assert.deepEqual(r.txs.map((t) => t.state), ['unknown', 'unknown']);
  assert.deepEqual([r.counts.total, r.counts.unknown], [2, 2]);
  assert.equal(r.checkedAt, 1000); assert.equal(r.mandate, null); assert.equal(r.reason, 'check failed');
});

function reveal(plan: 'skip' | 'arm') {
  const seen: string[] = [];
  const obs = { cbs: [] as (() => void)[], off: 0 };
  const timers: { fn(): void; ms: number; cancelled: boolean }[] = [];
  const c = mod.createRevealController({
    plan: () => plan, ms: 1200,
    observe: (cb: () => void) => { obs.cbs.push(cb); return () => { obs.off++; }; },
    later: (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    onChange: (s: string) => seen.push(s),
  });
  return { c, seen, obs, timers };
}

test('reveal: skip plan means "off" (content stays visible) and nothing is observed', () => {
  const r = reveal('skip');
  r.c.start();
  assert.deepEqual(r.seen, ['off']);
  assert.equal(r.obs.cbs.length, 0);
});

test('reveal: armed, then run once when visible, then done after ms; a second visible signal is ignored', () => {
  const r = reveal('arm');
  r.c.start();
  assert.deepEqual(r.seen, ['armed']);
  r.obs.cbs[0]();
  assert.deepEqual(r.seen, ['armed', 'run']);
  assert.equal(r.timers[0].ms, 1200);
  r.obs.cbs[0]();
  assert.equal(r.timers.length, 1);
  r.timers[0].fn();
  assert.deepEqual(r.seen, ['armed', 'run', 'done']);
});

test('reveal: cleanup before visible unobserves; cleanup during run cancels the timer', () => {
  const a = reveal('arm');
  const stopA = a.c.start();
  stopA();
  assert.equal(a.obs.off, 1);
  const b = reveal('arm');
  const stopB = b.c.start();
  b.obs.cbs[0]();
  stopB();
  assert.equal(b.timers[0].cancelled, true);
});

test('reveal: an effect re-run that now plans "skip" returns an armed block to "off" so it is never left hidden', () => {
  let plan: 'skip' | 'arm' = 'arm';
  const seen: string[] = [];
  const c = mod.createRevealController({ plan: () => plan, ms: 1, observe: () => () => {}, later: () => () => {}, onChange: (s: string) => seen.push(s) });
  const stop = c.start();
  stop();
  plan = 'skip';
  c.start();
  assert.deepEqual(seen, ['armed', 'off']);
});

test('reveal: observer options reach a block taller than the viewport (threshold 0, shrunk bottom edge)', () => {
  assert.equal(mod.REVEAL_THRESHOLD, 0);
  assert.equal(mod.REVEAL_ROOT_MARGIN, '0px 0px -10% 0px');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 5000, viewport: 800 }), 'arm');
});
