// When to create the 3D scene: after the market store is ready (or a max wait, so a stuck store never blocks the viewer), at a browser idle
// moment, and only when the panel is near the viewport. Pure decision plus a small scheduler with injected clock and idle hooks (unit-tested).
export const MAX_WAIT_MS = 2500, IDLE_TIMEOUT_MS = 400, IDLE_FALLBACK_MS = 50;

export type GateInput = { ready: boolean; elapsedMs: number; visible: boolean; idle: boolean };
export const shouldStart = (i: GateInput): boolean => i.visible && i.idle && (i.ready || i.elapsedMs >= MAX_WAIT_MS);

export type GateEnv = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void;
  requestIdle?: (fn: () => void, timeoutMs: number) => unknown; cancelIdle?: (h: unknown) => void;
};

export function createStartGate(env: GateEnv, start: () => void) {
  const t0 = env.now();
  let ready = false, visible = false, dead = false, done = false, idle = false;
  let waitTimer: unknown = null, idleHandle: unknown = null, idlePending = false;
  const elapsed = () => env.now() - t0;
  const clearIdle = () => { if (!idlePending) return; idlePending = false; if (env.requestIdle && env.cancelIdle) env.cancelIdle(idleHandle); else env.clearTimer(idleHandle); };
  const clearWait = () => { if (waitTimer !== null) { env.clearTimer(waitTimer); waitTimer = null; } };
  const onIdle = () => {
    idlePending = false; if (dead || done) return; idle = true;
    if (shouldStart({ ready, elapsedMs: elapsed(), visible, idle })) { done = true; clearWait(); start(); } else idle = false; // e.g. not near the viewport: wait for the next signal
  };
  function evaluate() {
    if (dead || done || idlePending || !visible) return;
    if (!ready && elapsed() < MAX_WAIT_MS) { if (waitTimer === null) waitTimer = env.setTimer(() => { waitTimer = null; evaluate(); }, MAX_WAIT_MS - elapsed()); return; }
    clearWait(); idlePending = true;
    idleHandle = env.requestIdle ? env.requestIdle(onIdle, IDLE_TIMEOUT_MS) : env.setTimer(onIdle, IDLE_FALLBACK_MS);
  }
  return {
    setReady(v: boolean) { ready = v; evaluate(); },
    setVisible(v: boolean) { visible = v; evaluate(); },
    dispose() { dead = true; clearWait(); clearIdle(); },
  };
}

// the browser environment (SSR safe: only called from effects)
export const browserEnv = (): GateEnv => {
  const w = globalThis as any;
  const ric = typeof w.requestIdleCallback === 'function';
  return {
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as any),
    requestIdle: ric ? (fn, timeout) => w.requestIdleCallback(fn, { timeout }) : undefined,
    cancelIdle: ric ? (h) => w.cancelIdleCallback(h) : undefined,
  };
};
