// node --test test/market/product3d-start-gate.test.ts   (from apps/web)
// The 3D scene is created only after the market store is ready (or a max wait), at a browser idle moment, and only near the viewport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStart, createStartGate, MAX_WAIT_MS, IDLE_TIMEOUT_MS, IDLE_FALLBACK_MS } from '../../src/components/market/product3d/start-gate.ts';

test('shouldStart: needs visible and idle, and ready or the max wait elapsed', () => {
  assert.equal(shouldStart({ ready: true, elapsedMs: 0, visible: true, idle: true }), true);
  assert.equal(shouldStart({ ready: false, elapsedMs: MAX_WAIT_MS - 1, visible: true, idle: true }), false);
  assert.equal(shouldStart({ ready: false, elapsedMs: MAX_WAIT_MS, visible: true, idle: true }), true);
  assert.equal(shouldStart({ ready: true, elapsedMs: 9999, visible: false, idle: true }), false);
  assert.equal(shouldStart({ ready: true, elapsedMs: 9999, visible: true, idle: false }), false);
  assert.equal(MAX_WAIT_MS, 2500); assert.equal(IDLE_TIMEOUT_MS, 400); assert.equal(IDLE_FALLBACK_MS, 50);
});

// a manual clock with timers and an idle queue
function env(withIdle = true) {
  let t = 0, id = 0; const timers = new Map<number, { at: number; fn: () => void }>(); const idles = new Map<number, { fn: () => void; timeout: number }>();
  const e: any = {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const i = ++id; timers.set(i, { at: t + ms, fn }); return i; },
    clearTimer: (i: any) => { timers.delete(i); },
    requestIdle: withIdle ? (fn: () => void, timeout: number) => { const i = ++id; idles.set(i, { fn, timeout }); return i; } : undefined,
    cancelIdle: withIdle ? (i: any) => { idles.delete(i); } : undefined,
  };
  return {
    e, timers, idles,
    advance(ms: number) { const end = t + ms; for (;;) { const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; t = next[1].at; timers.delete(next[0]); next[1].fn(); } t = end; },
    runIdle() { const [[i, v]] = [...idles.entries()]; idles.delete(i); v.fn(); },
  };
}

test('waits for ready, then one idle callback (timeout 400), then starts once', () => {
  const x = env(); let starts = 0; const g = createStartGate(x.e, () => { starts++; });
  g.setVisible(true); x.advance(1000);
  assert.equal(x.idles.size, 0, 'no idle request while the store is not ready'); assert.equal(starts, 0);
  g.setReady(true); assert.equal(x.idles.size, 1); assert.equal([...x.idles.values()][0].timeout, IDLE_TIMEOUT_MS);
  g.setReady(true); assert.equal(x.idles.size, 1, 'no second idle request');
  x.runIdle(); assert.equal(starts, 1);
  g.setReady(true); g.setVisible(true); x.advance(5000); assert.equal(starts, 1);
});

test('a stuck store never blocks: after the max wait the idle moment is requested', () => {
  const x = env(); let starts = 0; const g = createStartGate(x.e, () => { starts++; });
  g.setVisible(true); x.advance(MAX_WAIT_MS - 1); assert.equal(x.idles.size, 0);
  x.advance(1); assert.equal(x.idles.size, 1); x.runIdle(); assert.equal(starts, 1);
});

test('not visible: nothing is requested until the panel is near the viewport', () => {
  const x = env(); let starts = 0; const g = createStartGate(x.e, () => { starts++; });
  g.setReady(true); x.advance(MAX_WAIT_MS + 100); assert.equal(x.idles.size, 0); assert.equal(starts, 0);
  g.setVisible(true); assert.equal(x.idles.size, 1); x.runIdle(); assert.equal(starts, 1);
});

test('without requestIdleCallback the fallback is a 50 ms timer', () => {
  const x = env(false); let starts = 0; const g = createStartGate(x.e, () => { starts++; });
  g.setVisible(true); g.setReady(true); assert.equal(starts, 0); x.advance(IDLE_FALLBACK_MS - 1); assert.equal(starts, 0); x.advance(1); assert.equal(starts, 1);
});

test('dispose cancels the pending idle callback, the max-wait timer and prevents any start', () => {
  const x = env(); let starts = 0; const g = createStartGate(x.e, () => { starts++; });
  g.setVisible(true); assert.equal(x.timers.size, 1); g.setReady(true); assert.equal(x.idles.size, 1);
  g.dispose(); assert.equal(x.idles.size, 0); assert.equal(x.timers.size, 0);
  g.setReady(true); g.setVisible(true); x.advance(9999); assert.equal(starts, 0);
  const y = env(); const h = createStartGate(y.e, () => { starts++; }); h.setVisible(true); h.setReady(true);
  const [[, idle]] = [...y.idles.entries()]; h.dispose(); idle.fn(); assert.equal(starts, 0, 'a late idle callback after dispose is ignored');
});

test('the fallback timer is cancelled on dispose too', () => {
  const x = env(false); let starts = 0; const g = createStartGate(x.e, () => { starts++; });
  g.setVisible(true); g.setReady(true); g.dispose(); x.advance(1000); assert.equal(starts, 0);
});

test('a second gate (StrictMode remount or market change) starts independently; one gate starts exactly once', () => {
  const x = env(); let a = 0, b = 0;
  const g1 = createStartGate(x.e, () => { a++; }); g1.setVisible(true); g1.setReady(true); g1.dispose();
  const g2 = createStartGate(x.e, () => { b++; }); g2.setVisible(true); g2.setReady(true);
  assert.equal(x.idles.size, 1); x.runIdle(); assert.equal(a, 0); assert.equal(b, 1);
});

test('Product3D wires the gate: scene creation goes through it, never straight from a timer or the observer', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/components/market/Product3D.tsx', import.meta.url), 'utf8');
  assert.match(src, /createStartGate\(browserEnv\(\), start\)/);
  assert.match(src, /setReady\(state\.ready\)/);
  assert.doesNotMatch(src, /setTimeout\(start/);
  assert.match(src, /g\.dispose\(\)/);
});
