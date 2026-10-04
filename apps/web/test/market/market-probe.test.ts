// node --test test/market/market-probe.test.ts   (from apps/web)
// The time-to-ready probe (scripts/market-probe.cjs) decides pass/fail with the pure functions of scripts/market-probe-lib.cjs; here they
// are checked without a browser: argument parsing, median/max, getLogs counting, the per-scenario verdict (median vs target, max vs 2x
// target, expected data-source, warm getLogs cap, console errors), the IndexedDB check verdict, the synthetic snapshot used for the
// 1-3 MB round trip (it must pass the app's own validateSnapshot) and the report table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateSnapshot } from '../../src/lib/market-snap.ts';

type Run = { ms: number; source: string; price: string; getLogsAtReady: number; errors: string[] };
type Verdict = { name: string; median: number; max: number; target: number; ok: boolean; reasons: string[] };
const require = createRequire(import.meta.url);
const lib = require('../../../../scripts/market-probe-lib.cjs') as {
  TARGET: Record<string, number>; EXPECTED_SOURCE: Record<string, string>; WARM_MAX_GETLOGS: number; IDB_READ_BUDGET_MS: number; TOTAL_BUDGET_MS: number; SPREAD: number;
  parseArgs(argv: string[], env?: Record<string, string | undefined>): { base: string | null; runs: number; reportOnly: boolean; snapshotDelay: number; width: number; profile: boolean; help: boolean; unknown: string[] };
  median(xs: number[]): number; maxOf(xs: number[]): number;
  countGetLogs(postData: string | null | undefined): number;
  isRealPrice(text: string): boolean;
  isExpectedConsoleError(msg: { text: string; url?: string }): boolean;
  judgeScenario(name: 'cold' | 'warm' | 'fallback', runs: Run[], expected?: { selected?: string }): Verdict;
  judgeIdb(checks: { key: string; ok: boolean; detail?: string; ms?: number }[]): { ok: boolean; failed: string[] };
  syntheticSnapshot(id: { chainId: number; book: string; deployBlock: number }, targetBytes: number): any;
  formatTable(verdicts: Verdict[], runs: Record<string, Run[]>): string;
  overBudget(startMs: number, nowMs: number): boolean;
  busyBefore(longTasks: [number, number][], ms: number): number;
  selfTimeTop(profile: any, n?: number): { byScript: { key: string; ms: number }[]; byFunction: { key: string; ms: number }[] };
};

const run = (ms: number, over: Partial<Run> = {}): Run => ({ ms, source: 'snapshot', price: '$10.59', getLogsAtReady: 1, errors: [], ...over });
const ID = { chainId: 46630, book: '0x8b4dFd26ab2A7Bdfd2090e434bcfB2C10A296E5d', deployBlock: 128228560 };

test('constants: the targets are the plan numbers, the spread factor is 2, the whole probe has 4 minutes', () => {
  assert.deepEqual(lib.TARGET, { cold: 3000, warm: 1500, fallback: 8000 });
  assert.deepEqual(lib.EXPECTED_SOURCE, { cold: 'snapshot', warm: 'cache', fallback: 'baked' });
  assert.equal(lib.WARM_MAX_GETLOGS, 3); assert.equal(lib.IDB_READ_BUDGET_MS, 800); assert.equal(lib.TOTAL_BUDGET_MS, 240_000); assert.equal(lib.SPREAD, 2);
});

test('parseArgs: base url, --runs N / --runs=N, --report-only, --snapshot-delay, --profile, unknown flags, --help', () => {
  assert.deepEqual(lib.parseArgs([]), { base: null, runs: 3, reportOnly: false, snapshotDelay: 0, width: 1440, profile: false, help: false, unknown: [] });
  assert.deepEqual(lib.parseArgs(['http://127.0.0.1:4394/', '--runs', '5', '--report-only', '--snapshot-delay=120', '--profile', '--width', '390']), { base: 'http://127.0.0.1:4394', runs: 5, reportOnly: true, snapshotDelay: 120, width: 390, profile: true, help: false, unknown: [] });
  assert.equal(lib.parseArgs(['--runs=2']).runs, 2);
  assert.equal(lib.parseArgs([], { BASE_URL: 'https://x.test/' }).base, 'https://x.test');
  assert.equal(lib.parseArgs(['--runs', '0']).runs, 3, 'a nonsense run count keeps the default'); assert.equal(lib.parseArgs(['--runs', 'abc']).runs, 3); assert.equal(lib.parseArgs(['--runs', '99']).runs, 3);
  assert.equal(lib.parseArgs(['--width=100']).width, 1440, 'a width below 320 keeps the default'); assert.equal(lib.parseArgs(['--width=1920']).width, 1920);
  assert.deepEqual(lib.parseArgs(['--bogus']).unknown, ['--bogus']); assert.equal(lib.parseArgs(['-h']).help, true);
});

test('median / maxOf: middle value, mean of the two middles for an even count, empty is NaN', () => {
  assert.equal(lib.median([5, 1, 3]), 3); assert.equal(lib.median([4, 1, 2, 3]), 2.5); assert.equal(lib.median([7]), 7);
  assert.ok(Number.isNaN(lib.median([]))); assert.equal(lib.maxOf([5, 1, 3]), 5); assert.ok(Number.isNaN(lib.maxOf([])));
});

test('countGetLogs: counts eth_getLogs calls in a JSON-RPC body, single or batched, 0 for anything else', () => {
  const one = (m: string) => ({ jsonrpc: '2.0', id: 1, method: m, params: [] });
  assert.equal(lib.countGetLogs(JSON.stringify(one('eth_getLogs'))), 1);
  assert.equal(lib.countGetLogs(JSON.stringify(one('eth_blockNumber'))), 0);
  assert.equal(lib.countGetLogs(JSON.stringify([one('eth_getLogs'), one('eth_call'), one('eth_getLogs')])), 2);
  assert.equal(lib.countGetLogs('not json'), 0); assert.equal(lib.countGetLogs(null), 0); assert.equal(lib.countGetLogs(undefined), 0); assert.equal(lib.countGetLogs('{"method":5}'), 0);
});

test('isRealPrice: a positive terminal dollar price only (no skeleton, no "no trade yet", no $0.00)', () => {
  for (const t of ['$10.59', '$1,199.00', '$0.05', ' $7.00 ']) assert.equal(lib.isRealPrice(t), true, t);
  for (const t of ['', 'no trade yet', '$0.00', '$10', '10.59', 'Loading', '$-1.00']) assert.equal(lib.isRealPrice(t), false, t);
});

test('isExpectedConsoleError: only the browser\'s own resource-failure line for the snapshot URL the probe fails on purpose', () => {
  assert.equal(lib.isExpectedConsoleError({ text: 'Failed to load resource: the server responded with a status of 503 ()', url: 'http://127.0.0.1:1/api/market/snapshot' }), true);
  assert.equal(lib.isExpectedConsoleError({ text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', url: 'http://127.0.0.1:1/favicon.ico' }), false);
  assert.equal(lib.isExpectedConsoleError({ text: 'Uncaught TypeError: x', url: 'http://127.0.0.1:1/api/market/snapshot' }), false);
  assert.equal(lib.isExpectedConsoleError({ text: 'Failed to load resource: net::ERR_FAILED' }), false, 'without the URL it cannot be told apart from a real failure');
});

test('judgeScenario: median under the target and max within 2x passes; the median is what the target applies to', () => {
  const v = lib.judgeScenario('cold', [run(2000), run(2900), run(5500)]);
  assert.equal(v.median, 2900); assert.equal(v.max, 5500); assert.equal(v.target, 3000); assert.equal(v.ok, true, 'one slow run under 2x the target is network variance, not a failure');
  assert.deepEqual(v.reasons, []);
  assert.equal(lib.judgeScenario('cold', [run(100), run(3000), run(3100)]).ok, false, 'median exactly on the target is a miss (strictly below)');
  const slow = lib.judgeScenario('cold', [run(2000), run(2100), run(6100)]);
  assert.equal(slow.ok, false); assert.match(slow.reasons.join('|'), /max 6100 ms > 2x target 6000 ms/);
  const med = lib.judgeScenario('warm', [run(1600, { source: 'cache' }), run(1700, { source: 'cache' }), run(1400, { source: 'cache' })]);
  assert.equal(med.ok, false); assert.match(med.reasons.join('|'), /median 1600 ms >= target 1500 ms/);
});

test('judgeScenario: the data-source must be the expected one in EVERY run (cold snapshot, warm cache, fallback baked)', () => {
  assert.equal(lib.judgeScenario('cold', [run(900, { source: 'snapshot' }), run(900, { source: 'rpc' }), run(900)]).ok, false);
  assert.match(lib.judgeScenario('cold', [run(900, { source: 'cache' })]).reasons.join('|'), /data-source cache, expected snapshot/);
  assert.equal(lib.judgeScenario('warm', [run(500, { source: 'cache' })]).ok, true);
  assert.equal(lib.judgeScenario('warm', [run(500, { source: 'snapshot' })]).ok, false);
  assert.equal(lib.judgeScenario('fallback', [run(5000, { source: 'baked', getLogsAtReady: 5 })]).ok, true);
  assert.equal(lib.judgeScenario('fallback', [run(5000, { source: 'rpc', getLogsAtReady: 40 })]).ok, false, 'the baked history must be the base when there is no snapshot and no cache');
});

test('judgeScenario: warm may use at most 3 getLogs requests by ready; cold and fallback have no cap', () => {
  assert.equal(lib.judgeScenario('warm', [run(500, { source: 'cache', getLogsAtReady: 3 })]).ok, true);
  const v = lib.judgeScenario('warm', [run(500, { source: 'cache', getLogsAtReady: 4 })]);
  assert.equal(v.ok, false); assert.match(v.reasons.join('|'), /4 eth_getLogs by ready > 3/);
  assert.equal(lib.judgeScenario('cold', [run(500, { getLogsAtReady: 9 })]).ok, true);
});

test('judgeScenario: any console error or unhandled rejection fails; a missing price fails; no runs fails', () => {
  const e = lib.judgeScenario('cold', [run(500, { errors: ['pageerror: boom'] })]);
  assert.equal(e.ok, false); assert.match(e.reasons.join('|'), /1 console error/);
  const p = lib.judgeScenario('cold', [run(500, { price: 'no trade yet' })]);
  assert.equal(p.ok, false); assert.match(p.reasons.join('|'), /no real price/);
  const none = lib.judgeScenario('cold', []); assert.equal(none.ok, false); assert.match(none.reasons.join('|'), /no runs/);
});

test('judgeScenario: the selected market must be the expected default in every run when one is given', () => {
  const r = (sel: string) => ({ ...run(500), selected: sel }) as Run;
  assert.equal(lib.judgeScenario('cold', [r('IP16-CLR'), r('IP16-CLR')], { selected: 'IP16-CLR' }).ok, true);
  const bad = lib.judgeScenario('cold', [r('IP16-CLR'), r('PS5')], { selected: 'IP16-CLR' });
  assert.equal(bad.ok, false); assert.match(bad.reasons.join('|'), /selected PS5, expected IP16-CLR/);
});

test('judgeIdb: ok only when every check is ok; names the failed ones', () => {
  assert.deepEqual(lib.judgeIdb([{ key: 'a', ok: true }, { key: 'b', ok: true }]), { ok: true, failed: [] });
  assert.deepEqual(lib.judgeIdb([{ key: 'a', ok: true }, { key: 'b', ok: false, detail: 'x' }]), { ok: false, failed: ['b'] });
  assert.deepEqual(lib.judgeIdb([]), { ok: false, failed: ['no checks ran'] });
});

test('syntheticSnapshot: validates with the app\'s validateSnapshot and lands near the requested size (1-3 MB round trip)', () => {
  for (const target of [1_000_000, 2_000_000, 2_900_000]) {
    const s = lib.syntheticSnapshot(ID, target); const bytes = JSON.stringify(s).length;
    assert.ok(bytes >= target * 0.9 && bytes <= target, `${bytes} for ${target}`);
    const v = validateSnapshot(JSON.parse(JSON.stringify(s)), ID);
    assert.ok(v, `valid at ${target}`); assert.equal(v!.hot.books.length, s.hot.books.length); assert.equal(v!.cursor, s.cursor);
  }
  assert.equal(validateSnapshot(lib.syntheticSnapshot({ ...ID, deployBlock: 5 }, 1_000_000), ID), null, 'it carries the identity it was given');
});

test('overBudget: the whole probe has 4 minutes', () => {
  assert.equal(lib.overBudget(1000, 1000 + 239_999), false); assert.equal(lib.overBudget(1000, 1000 + 240_001), true);
});

test('formatTable: one line per scenario with median, max, runs, source and getLogs; FAIL rows carry the reason', () => {
  const runs = { cold: [run(2000), run(2200), run(2100)], warm: [run(900, { source: 'cache' }), run(950, { source: 'cache' }), run(1000, { source: 'cache' })], fallback: [run(9000, { source: 'baked', getLogsAtReady: 4 })] };
  const verdicts = (['cold', 'warm', 'fallback'] as const).map((n) => lib.judgeScenario(n, runs[n]));
  const t = lib.formatTable(verdicts, runs); const lines = t.split('\n');
  assert.match(lines[0], /scenario/); assert.match(lines[0], /median/); assert.match(lines[0], /target/);
  const row = (n: string) => lines.find((l) => l.includes(n))!;
  assert.match(row('cold'), /ok\s+cold\s+2100 ms/); assert.match(row('warm'), /ok\s+warm\s+950 ms/); assert.match(row('fallback'), /FAIL\s+fallback\s+9000 ms/);
  assert.match(t, /median 9000 ms >= target 8000 ms/);
});

test('busyBefore: long-task time inside [0, ms] (a task straddling ms is clipped, later ones are ignored)', () => {
  assert.equal(lib.busyBefore([[75, 756], [832, 521], [1504, 351], [3063, 2466]], 1800), 756 + 521 + (1800 - 1504));
  assert.equal(lib.busyBefore([[10, 50]], 5), 0); assert.equal(lib.busyBefore([], 1000), 0); assert.equal(lib.busyBefore([[0, 100]], 1000), 100);
});

test('selfTimeTop: self time per script and per function from a CDP cpu profile, idle excluded, largest first', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' } },
      { id: 2, callFrame: { functionName: 'render', url: 'http://h/_astro/Terminal.abc.js', lineNumber: 4 } },
      { id: 3, callFrame: { functionName: 'init', url: 'http://h/_astro/three.module.xyz.js', lineNumber: 9 } },
      { id: 4, callFrame: { functionName: '(idle)', url: '' } },
    ],
    samples: [2, 3, 3, 4, 2], timeDeltas: [0, 1000, 2000, 5000, 1000],   // sample i lasts until sample i+1 (the last one has no successor)
  };
  const t = lib.selfTimeTop(profile, 5);
  assert.deepEqual(t.byScript, [{ key: 'three.module.xyz.js', ms: 7 }, { key: 'Terminal.abc.js', ms: 1 }]);
  assert.deepEqual(t.byFunction.map((f) => f.key), ['init three.module.xyz.js:10', 'render Terminal.abc.js:5']);
  assert.deepEqual(lib.selfTimeTop({ nodes: [], samples: [], timeDeltas: [] }), { byScript: [], byFunction: [] });
  assert.deepEqual(lib.selfTimeTop(null as any), { byScript: [], byFunction: [] });
});
