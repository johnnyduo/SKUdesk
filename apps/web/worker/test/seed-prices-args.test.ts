import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeedArgs, counterAlignment } from '../scripts/seed-prices.ts';

// seed-prices.ts is an operator CLI. Importing it must never run it (no key read, no network): only these pure helpers load.

test('parseSeedArgs: defaults keep the dry-run, a reserve of 20, and no counter alignment', () => {
  assert.deepEqual(parseSeedArgs([]), { manifest: 'dist/p/manifest.json', go: false, reserve: 20, cacheDir: '.wrangler/seed-cache', out: 'seed-out', alignCounter: false });
});

test('parseSeedArgs: --reserve accepts non-negative integers, including 0', () => {
  assert.equal(parseSeedArgs(['--reserve', '0']).reserve, 0);
  assert.equal(parseSeedArgs(['--reserve', '35']).reserve, 35);
  assert.equal(parseSeedArgs(['--go', '--align-counter']).go, true);
  assert.equal(parseSeedArgs(['--align-counter']).alignCounter, true);
});

test('parseSeedArgs: a non-numeric, negative, fractional or oversized --reserve aborts with a clear message (never NaN)', () => {
  for (const bad of ['abc', '', '-1', '1.5', '1e3', '12abc', ' 5', '0x10', '99999999999999999999']) {
    assert.throws(() => parseSeedArgs(['--reserve=' + bad]), (e: unknown) => e instanceof Error && /--reserve must be a non-negative integer/.test(e.message), JSON.stringify(bad));
  }
});

test('parseSeedArgs: the space-separated negative form is also refused (node reports it as ambiguous)', () => {
  assert.throws(() => parseSeedArgs(['--reserve', '-1']));
});

test('parseSeedArgs: unknown options are rejected', () => {
  assert.throws(() => parseSeedArgs(['--reservee', '5']));
});

test('counterAlignment: only an explicit flag and a sane this_month_usage may overwrite the monthly counter', () => {
  assert.deepEqual(counterAlignment(false, 42, 3), { write: false, value: null, warning: 'monthly counter NOT written: SerpApi reports usage for its own billing period, which may differ from the UTC calendar month the app counts in. Re-run with --align-counter to write it anyway.' });
  assert.deepEqual(counterAlignment(true, 42, 3), { write: true, value: 45, warning: 'monthly counter written from SerpApi this_month_usage (billing period assumed to equal the current UTC month; check the account page if it renews mid-month).' });
  for (const bad of [undefined, -1, 1.5, Number.NaN, '7' as unknown as number]) {
    const r = counterAlignment(true, bad, 3);
    assert.equal(r.write, false, String(bad));
    assert.equal(r.value, null);
    assert.match(r.warning, /this_month_usage/);
  }
});
