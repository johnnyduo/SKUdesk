// Pure motion model for the product ring. No DOM, no Three.js.

export type RingPos = { position: number; active: number; angle: number };
export type ValueState = { value: number; vel: number };

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 32; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** cubic-bezier(.65, 0, .35, 1) */
export const ease = cubicBezier(0.65, 0, 0.35, 1);

const DWELL = 0.2; // share of each segment spent resting at each end

/** Ring position for scroll progress `p` over `n` items. Rests on each item, eases between. */
export function ringAt(p: number, n: number): RingPos {
  const count = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  if (count < 2) return { position: 0, active: 0, angle: 0 };
  const u = clamp01(p) * (count - 1);
  const k = Math.min(count - 2, Math.floor(u));
  const t = ease(Math.min(1, Math.max(0, (u - k - DWELL) / (1 - 2 * DWELL))));
  const position = k + t;
  return { position, active: Math.round(position), angle: position * ((2 * Math.PI) / count) };
}

/** Critically damped smoothing (Unity-style SmoothDamp): no overshoot, frame-rate independent. */
function smoothDamp(current: number, target: number, vel: number, smoothTime: number, dt: number): [number, number] {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (vel + omega * change) * dt;
  let nv = (vel - omega * temp) * e;
  let out = target + (change + temp) * e;
  if ((target - current > 0) === (out > target)) { out = target; nv = 0; }
  return [out, nv];
}

export function restValue(v: number): ValueState { return { value: v, vel: 0 }; }

export function stepValue(s: ValueState, target: number, dt: number, smoothTime = 0.3): ValueState {
  if (!(dt > 0)) return s;
  const [value, vel] = smoothDamp(s.value, target, s.vel, smoothTime, Math.min(dt, 0.1)); // tab returns must not explode the step
  return { value, vel };
}

export function isValueSettled(s: ValueState, target: number): boolean {
  return Math.abs(s.value - target) < 0.002 && Math.abs(s.vel) < 0.01;
}
