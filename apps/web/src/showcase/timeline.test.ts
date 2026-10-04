import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ease, ringAt, restValue, stepValue, isValueSettled } from './timeline.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('ease is 0 at 0, 1 at 1, monotonic', () => {
  near(ease(0), 0); near(ease(1), 1);
  let last = -1;
  for (let i = 0; i <= 100; i++) { const v = ease(i / 100); assert.ok(v >= last); last = v; }
});

test('ringAt starts on the first item and ends on the last', () => {
  const a = ringAt(0, 5), z = ringAt(1, 5);
  near(a.position, 0); assert.equal(a.active, 0); near(a.angle, 0);
  near(z.position, 4); assert.equal(z.active, 4); near(z.angle, 4 * (2 * Math.PI) / 5);
});

test('ringAt dwells at each stop and moves between them', () => {
  // n=5: segments are 0.25 wide; 20% of a segment at each end is a dwell
  near(ringAt(0.04, 5).position, 0);          // inside the first dwell
  near(ringAt(0.25 - 0.04, 5).position, 1);   // inside the dwell before stop 1
  const mid = ringAt(0.125, 5).position;      // middle of segment 0→1
  assert.ok(mid > 0.3 && mid < 0.7, `mid ${mid}`);
});

test('ringAt picks the nearest item as active', () => {
  assert.equal(ringAt(0.25, 5).active, 1);
  assert.equal(ringAt(0.5, 5).active, 2);
  assert.equal(ringAt(0.75, 5).active, 3);
});

test('ringAt is monotonic and continuous', () => {
  let prev = ringAt(0, 7).position;
  for (let i = 1; i <= 1000; i++) {
    const cur = ringAt(i / 1000, 7).position;
    assert.ok(cur >= prev - 1e-9, `went backwards at ${i}`);
    assert.ok(cur - prev <= 0.05, `jump at ${i}: ${cur - prev}`);
    prev = cur;
  }
});

test('ringAt clamps out-of-range and non-finite progress; handles n < 2', () => {
  assert.deepEqual(ringAt(-3, 5), ringAt(0, 5));
  assert.deepEqual(ringAt(9, 5), ringAt(1, 5));
  assert.deepEqual(ringAt(NaN, 5), ringAt(0, 5));
  assert.deepEqual(ringAt(0.5, 1), { position: 0, active: 0, angle: 0 });
  assert.deepEqual(ringAt(0.5, 0), { position: 0, active: 0, angle: 0 });
  assert.deepEqual(ringAt(0.5, NaN), { position: 0, active: 0, angle: 0 });
});

test('stepValue converges without overshoot', () => {
  let s = restValue(0);
  for (let i = 0; i < 600; i++) {
    s = stepValue(s, 4, 1 / 60);
    assert.ok(s.value <= 4 + 1e-9, `overshoot ${s.value}`);
  }
  near(s.value, 4, 0.005);
  assert.ok(isValueSettled(s, 4));
});

test('stepValue is frame-rate independent (one 32ms step ≈ two 16ms steps)', () => {
  const a = stepValue(restValue(0), 4, 0.032);
  const b = stepValue(stepValue(restValue(0), 4, 0.016), 4, 0.016);
  assert.ok(Math.abs(a.value - b.value) < 1e-3, `${a.value} vs ${b.value}`);
});

test('stepValue survives a huge frame gap and dt <= 0', () => {
  const big = stepValue(restValue(0), 4, 5);
  assert.ok(Number.isFinite(big.value) && big.value > 0 && big.value <= 4);
  assert.deepEqual(stepValue(restValue(0), 4, 5), stepValue(restValue(0), 4, 0.1)); // dt clamped to 0.1 s
  assert.equal(stepValue(restValue(1), 4, 0).value, 1);
  assert.equal(stepValue(restValue(1), 4, -1).value, 1);
});

test('isValueSettled is false while moving', () => {
  assert.equal(isValueSettled(restValue(0), 4), false);
});
