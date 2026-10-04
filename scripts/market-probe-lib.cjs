// Pure logic of scripts/market-probe.cjs (no browser, no network, no I/O). Tested by apps/web/test/market/market-probe.test.ts.
//
// Thresholds. TARGET applies to the MEDIAN of the runs of a scenario (strictly below). Because the public RPC is shared and its latency
// varies, a single slow run is tolerated as long as it is within SPREAD x the target; a max above that fails even when the median passes.
// The median of an even number of runs is the mean of the two middle values.
'use strict';
const { parseUsd } = require('./probe-assets-lib.cjs');

const TARGET = { cold: 3000, warm: 1500, fallback: 8000 };        // ms, from navigation start to a real price on the selected market
const EXPECTED_SOURCE = { cold: 'snapshot', warm: 'cache', fallback: 'baked' }; // the store's data-source for each scenario
const WARM_MAX_GETLOGS = 3;                                       // eth_getLogs requests started by the moment the warm page is ready
const IDB_READ_BUDGET_MS = 800;                                   // open + get + parse + validate of a stored snapshot (CACHE_READ_TIMEOUT_MS)
const TOTAL_BUDGET_MS = 240_000;                                  // the whole probe
const SPREAD = 2;
const SNAPSHOT_PATH = '/api/market/snapshot';

// arguments
/** `market-probe.cjs [BASE_URL] [--runs N] [--report-only] [--snapshot-delay MS] [--profile] [--width PX] [--help]`; BASE_URL may also come from the environment. */
function parseArgs(argv, env = {}) {
  const out = { base: null, runs: 3, reportOnly: false, snapshotDelay: 0, width: 1440, profile: false, help: false, unknown: [] };
  const num = (s, lo, hi) => { const n = Number(s); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report-only') out.reportOnly = true;
    else if (a === '--profile') out.profile = true;
    else if (a === '--width' || a.startsWith('--width=')) { const v = a === '--width' ? argv[++i] : a.slice(8); out.width = num(v, 320, 3840) ?? out.width; }
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--runs' || a.startsWith('--runs=')) { const v = a === '--runs' ? argv[++i] : a.slice(7); out.runs = num(v, 1, 10) ?? out.runs; }
    else if (a === '--snapshot-delay' || a.startsWith('--snapshot-delay=')) { const v = a === '--snapshot-delay' ? argv[++i] : a.slice(17); out.snapshotDelay = num(v, 0, 10_000) ?? out.snapshotDelay; }
    else if (a.startsWith('-')) out.unknown.push(a);
    else if (!out.base) out.base = a;
  }
  const base = out.base || env.BASE_URL || null;
  out.base = base ? base.replace(/\/+$/, '') : null;
  return out;
}

// numbers
function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const maxOf = (xs) => (xs.length ? Math.max(...xs) : NaN);

// page / request facts
/** Number of eth_getLogs calls in one JSON-RPC POST body (single object or batch array); 0 for anything else. */
function countGetLogs(postData) {
  if (typeof postData !== 'string') return 0;
  try {
    const j = JSON.parse(postData);
    return (Array.isArray(j) ? j : [j]).filter((c) => c && c.method === 'eth_getLogs').length;
  } catch { return 0; }
}
/** The terminal's price text for a market that traded: a positive dollar amount (not the skeleton, "no trade yet" or $0.00). */
function isRealPrice(text) { const c = parseUsd(text); return c !== null && c > 0; }
/** The browser's own "Failed to load resource" console line for the snapshot request the fallback scenario fails ON PURPOSE. Nothing else is excused. */
function isExpectedConsoleError({ text, url }) {
  return /^Failed to load resource/.test(String(text)) && typeof url === 'string' && url.includes(SNAPSHOT_PATH);
}

// verdicts
/**
 * One scenario's verdict from its runs ({ ms, source, price, getLogsAtReady, errors, selected? }).
 * Fails when: no runs; median >= target; max > SPREAD x target; a run's data-source is not the scenario's; a run has no real price; any
 * console error / unhandled rejection; the selected market is not `expected.selected` (when given); warm used more than WARM_MAX_GETLOGS getLogs by ready.
 */
function judgeScenario(name, runs, expected = {}) {
  const target = TARGET[name]; const reasons = [];
  if (!runs.length) return { name, median: NaN, max: NaN, target, ok: false, reasons: ['no runs'] };
  const ms = runs.map((r) => r.ms); const med = median(ms), max = maxOf(ms);
  if (!(med < target)) reasons.push(`median ${med} ms >= target ${target} ms`);
  if (max > SPREAD * target) reasons.push(`max ${max} ms > ${SPREAD}x target ${SPREAD * target} ms`);
  const want = EXPECTED_SOURCE[name];
  runs.forEach((r, i) => {
    const at = `run ${i + 1}`;
    if (r.source !== want) reasons.push(`${at}: data-source ${r.source}, expected ${want}`);
    if (!isRealPrice(r.price)) reasons.push(`${at}: no real price on the selected market (${JSON.stringify(r.price)})`);
    if (r.errors && r.errors.length) reasons.push(`${at}: ${r.errors.length} console error(s): ${r.errors.slice(0, 2).join(' | ')}`);
    if (expected.selected && r.selected !== undefined && r.selected !== expected.selected) reasons.push(`${at}: selected ${r.selected}, expected ${expected.selected}`);
    if (name === 'warm' && r.getLogsAtReady > WARM_MAX_GETLOGS) reasons.push(`${at}: ${r.getLogsAtReady} eth_getLogs by ready > ${WARM_MAX_GETLOGS}`);
  });
  return { name, median: med, max, target, ok: reasons.length === 0, reasons };
}
/** Verdict of the IndexedDB check list [{ key, ok, detail?, ms? }]. */
function judgeIdb(checks) {
  if (!checks.length) return { ok: false, failed: ['no checks ran'] };
  const failed = checks.filter((c) => !c.ok).map((c) => c.key);
  return { ok: failed.length === 0, failed };
}
const overBudget = (startMs, nowMs) => nowMs - startMs > TOTAL_BUDGET_MS;

// where the time went
/** Milliseconds of long tasks ([startTime, duration] pairs from a PerformanceObserver) that fall inside [0, ms]. */
function busyBefore(longTasks, ms) {
  let sum = 0;
  for (const [start, dur] of longTasks) { const end = Math.min(start + dur, ms); if (end > start) sum += end - start; }
  return sum;
}
/**
 * Self time per script (file name) and per function from a CDP cpu profile ({ nodes, samples, timeDeltas }), largest first, the idle node left out.
 * A sample lasts until the next one (timeDeltas are microseconds between samples); the last sample has no successor and counts for nothing.
 */
function selfTimeTop(profile, n = 6) {
  const empty = { byScript: [], byFunction: [] };
  if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas)) return empty;
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd.callFrame ?? {}]));
  const scripts = new Map(), funcs = new Map();
  profile.samples.forEach((id, i) => {
    const us = profile.timeDeltas[i + 1]; const cf = byId.get(id);
    if (!cf || !(us > 0) || cf.functionName === '(idle)') return;
    const file = (cf.url || '').split('/').pop().split('?')[0] || cf.functionName || '(unknown)';
    const fn = `${cf.functionName || '(anonymous)'} ${file}${cf.url ? ':' + ((cf.lineNumber ?? 0) + 1) : ''}`;
    scripts.set(file, (scripts.get(file) ?? 0) + us / 1000); funcs.set(fn, (funcs.get(fn) ?? 0) + us / 1000);
  });
  const top = (m) => [...m].map(([key, ms]) => ({ key, ms: Math.round(ms * 10) / 10 })).sort((a, b) => b.ms - a.ms).slice(0, n);
  return { byScript: top(scripts), byFunction: top(funcs) };
}

// synthetic snapshot (IndexedDB round trip)
const hexw = (n, w) => n.toString(16).padStart(w, '0');
/**
 * A VALID MarketSnapshot (passes market-snap validateSnapshot for `id`) of about `targetBytes` of JSON (never above it): many full books of
 * 24 orders (the contract's cap), for the 1-3 MB IndexedDB round trip. Deterministic. It is not market data and is never shown to the app.
 */
function syntheticSnapshot(id, targetBytes) {
  const mk = (n) => {
    const m = '0x' + hexw(1, 64); const cursor = id.deployBlock + 10_000_000;
    const books = [];
    for (let k = 0; k < n; k++) {
      const e = 100 + k; const o = [];
      for (let i = 0; i < 24; i++) o.push({ i, t: '0x' + hexw(0xa0000 + ((k * 24 + i) % 997), 40), h: '0x' + hexw(k * 24 + i + 1, 64), s: i % 2, p: 1000 + ((k + i) % 50), u: 1 + (i % 3), f: i % 2 });
      books.push({ m, e, fb: id.deployBlock + k * 20, lb: id.deployBlock + k * 20 + 19, o, c: { e, p: 1000 + (k % 50), v: 10, b: 12, s: 12, f: 0, k: id.deployBlock + k * 20 + 19, tx: '0x' + hexw(k + 1, 64) } });
    }
    return { v: 1, chainId: id.chainId, book: id.book, deployBlock: id.deployBlock, cursor, head: cursor, headTime: 1_700_000_000, builtAt: 1_700_000_000_000, complete: true,
      schedule: { t0: 1_700_000_000, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2_000_000 }, cold: {}, hot: { clears: {}, books } };
  };
  const per = JSON.stringify(mk(1).hot.books[0]).length + 1;
  let n = Math.max(1, Math.floor((targetBytes - 400) / per)); let s = mk(n);
  while (n > 1 && JSON.stringify(s).length > targetBytes) { n--; s = mk(n); }
  return s;
}

// report
const pad = (s, w) => String(s).padEnd(w);
/** The result table: one row per scenario (ok/FAIL, median, max, target, every run, source, getLogs by ready), then the reasons of failed rows. */
function formatTable(verdicts, runs) {
  const head = `${pad('', 4)}  ${pad('scenario', 8)}  ${pad('median', 10)}  ${pad('max', 10)}  ${pad('target', 10)}  ${pad('runs (ms)', 22)}  ${pad('source', 8)}  getLogs by ready`;
  const rows = verdicts.map((v) => {
    const rs = runs[v.name] ?? [];
    return `${pad(v.ok ? 'ok' : 'FAIL', 4)}  ${pad(v.name, 8)}  ${pad(`${v.median} ms`, 10)}  ${pad(`${v.max} ms`, 10)}  ${pad(`< ${v.target} ms`, 10)}  ${pad(rs.map((r) => r.ms).join(', '), 22)}  ${pad([...new Set(rs.map((r) => r.source))].join('/'), 8)}  ${rs.map((r) => r.getLogsAtReady).join(', ')}`;
  });
  const why = verdicts.filter((v) => !v.ok).flatMap((v) => v.reasons.map((r) => `  ${v.name}: ${r}`));
  return [head, ...rows, ...why].join('\n');
}

module.exports = { TARGET, EXPECTED_SOURCE, WARM_MAX_GETLOGS, IDB_READ_BUDGET_MS, TOTAL_BUDGET_MS, SPREAD, SNAPSHOT_PATH, parseArgs, median, maxOf, countGetLogs, isRealPrice, isExpectedConsoleError, judgeScenario, judgeIdb, overBudget, busyBefore, selfTimeTop, syntheticSnapshot, formatTable };
