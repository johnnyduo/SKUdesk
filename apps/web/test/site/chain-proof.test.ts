// node --test test/site/chain-proof.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toFunctionSelector } from 'viem';
import {
  MANDATE_FIELDS, MANDATE_SELECTORS, PROOF_TIMEOUT_MS, blockSpan, buildBatch, clockText, hexQty, judgeReceipt, latestOnly,
  proofFor, runDateText, verifyRun, type ProofInput, type RunTx,
} from '../../src/lib/chain-proof.ts';

const RUN = JSON.parse(readFileSync(new URL('../../src/data/run.json', import.meta.url), 'utf8'));
const TXS: RunTx[] = RUN.events.filter((e: any) => e.tx).map((e: any) => ({ id: e.id, ...e.tx }));
const AGENT: string = RUN.meta.agent;
const CORE: string = RUN.meta.core;
const RPC = 'https://rpc.example.test';
const INPUT: ProofInput = { rpc: RPC, txs: TXS, from: AGENT, to: CORE, mandate: { core: CORE, policy: RUN.policy } };
// Counts and ids come from run.json, so a fresh agent run does not break these tests. The UI copy relies on the run having
// exactly one transaction that reverted on purpose (the inflated-profit commit); the first test pins that property.
const N = TXS.length;
const FAILED_ID: number = TXS.find((t) => t.status === 'reverted')!.id;
const HEAD = Math.max(...TXS.map((t) => t.block)) + 550_013; // a head above every run block
const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16);
const word = (n: number | bigint | string) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const receiptOf = (t: RunTx) => ({ transactionHash: t.hash, status: t.status === 'success' ? '0x1' : '0x0', blockNumber: hex(t.block), gasUsed: hex(BigInt(t.gasUsed)), from: AGENT.toLowerCase(), to: CORE.toLowerCase(), logs: [] });

type Call = { jsonrpc: string; id: number; method: string; params: any[] };
type Answer = { result: unknown } | { error: unknown } | undefined;
// A fake JSON-RPC endpoint: `answer` decides each call; `undefined` leaves that call out of the reply.
function fakeRpc(answer: (c: Call) => Answer, opts: { reverse?: boolean; extra?: unknown[] } = {}) {
  const seen: { url: string; calls: Call[]; signal?: AbortSignal; init: any }[] = [];
  const fetch = async (url: string, init: any) => {
    const calls = JSON.parse(init.body) as Call[];
    seen.push({ url, calls, signal: init.signal, init });
    let out: unknown[] = calls.flatMap((c) => { const a = answer(c); return a === undefined ? [] : [{ jsonrpc: '2.0', id: c.id, ...a }]; });
    if (opts.reverse) out = out.reverse();
    if (opts.extra) out = [...out, ...opts.extra];
    return { ok: true, status: 200, json: async () => out };
  };
  return { fetch, seen };
}
// The chain as it is today: every receipt matches the run and the mandate equals the run's policy. `over` changes parts of it.
const chain = (over: { receipts?: Record<string, unknown>; head?: unknown; mandate?: Partial<Record<string, string>> } = {}) => (c: Call): Answer => {
  if (c.method === 'eth_blockNumber') return { result: 'head' in over ? over.head : hex(HEAD) };
  if (c.method === 'eth_getTransactionReceipt') {
    const t = TXS.find((x) => x.hash === c.params[0])!;
    if (over.receipts && t.hash in over.receipts) return { result: over.receipts[t.hash] };
    return { result: receiptOf(t) };
  }
  if (c.method === 'eth_call') {
    const field = MANDATE_FIELDS.find((f) => MANDATE_SELECTORS[f] === c.params[0].data)!;
    const v = over.mandate?.[field];
    return { result: v === undefined ? word(RUN.policy[field]) : v };
  }
  return { error: { code: -32601, message: 'method not found' } };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test('the run has transactions; exactly one (the inflated-profit commit) is an expected revert', () => {
  assert.ok(N > 1);
  assert.deepEqual(TXS.filter((t) => t.status !== 'success').map((t) => t.id), [FAILED_ID]);
  assert.match(RUN.events.find((e: any) => e.id === FAILED_ID).title, /inflated-profit commit reverted/);
});

test('mandate selectors are pinned to keccak256 of the getter signatures', () => {
  for (const f of MANDATE_FIELDS) assert.equal(MANDATE_SELECTORS[f], toFunctionSelector(`function ${f}()`), f);
});

test('one batch: head first, one receipt per run tx in order, then four mandate reads; ids are unique', () => {
  const b = buildBatch(INPUT);
  assert.equal(b.length, 1 + N + 4);
  assert.deepEqual(b[0], { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  TXS.forEach((t, i) => assert.deepEqual(b[1 + i], { jsonrpc: '2.0', id: 2 + i, method: 'eth_getTransactionReceipt', params: [t.hash] }));
  MANDATE_FIELDS.forEach((f, k) => assert.deepEqual(b[1 + N + k], { jsonrpc: '2.0', id: 2 + N + k, method: 'eth_call', params: [{ to: CORE, data: MANDATE_SELECTORS[f] }, 'latest'] }));
  assert.equal(new Set(b.map((c) => c.id)).size, b.length);
  assert.equal(buildBatch({ ...INPUT, mandate: undefined }).length, 1 + N);
});

test('verifyRun sends exactly one POST with a JSON body and an AbortSignal', async () => {
  const rpc = fakeRpc(chain());
  await verifyRun(INPUT, { fetch: rpc.fetch });
  assert.equal(rpc.seen.length, 1);
  assert.equal(rpc.seen[0].url, RPC);
  assert.equal(rpc.seen[0].init.method, 'POST');
  assert.equal(rpc.seen[0].init.headers['content-type'], 'application/json');
  assert.ok(rpc.seen[0].signal);
});

test('the chain as it is: all but one confirmed, 1 reverted as in the run, confirmations from the head, mandate unchanged', async () => {
  const now = Date.UTC(2026, 9, 3, 14, 54, 36);
  const r = await verifyRun(INPUT, { fetch: fakeRpc(chain()).fetch, now: () => now });
  assert.equal(r.reachable, true); assert.equal(r.head, HEAD); assert.equal(r.checkedAt, now); assert.equal(r.reason, undefined);
  assert.deepEqual(r.counts, { total: N, confirmed: N - 1, reverted: 1, mismatch: 0, notFound: 0, unknown: 0 });
  assert.deepEqual(proofFor(r, TXS[0].hash), { id: TXS[0].id, hash: TXS[0].hash, state: 'confirmed', block: TXS[0].block, gasUsed: TXS[0].gasUsed, confirmations: HEAD - TXS[0].block + 1, diffs: [] });
  assert.equal(proofFor(r, TXS.find((t) => t.id === FAILED_ID)!.hash)!.state, 'reverted');
  assert.equal(proofFor(r, TXS[0].hash.toUpperCase().replace('0X', '0x'))!.id, TXS[0].id, 'proofFor ignores hash case');
  assert.equal(r.mandate!.state, 'same');
});

test('answers are matched by id: reversed order and stray ids or junk entries change nothing', async () => {
  const r = await verifyRun(INPUT, { fetch: fakeRpc(chain(), { reverse: true, extra: [{ jsonrpc: '2.0', id: 99, result: '0x1' }, 'junk', null, { id: '3', result: null }] }).fetch });
  assert.deepEqual(r.counts, { total: N, confirmed: N - 1, reverted: 1, mismatch: 0, notFound: 0, unknown: 0 });
});

test('a missing answer or a per-call error makes only that transaction unknown', async () => {
  const lost = TXS[2].hash; const err = TXS[4].hash; const base = chain();
  const r = await verifyRun(INPUT, { fetch: fakeRpc((c) => (c.params[0] === lost ? undefined : c.params[0] === err ? { error: { code: -32000, message: 'busy' } } : base(c))).fetch });
  assert.deepEqual([proofFor(r, lost)!.state, proofFor(r, lost)!.reason], ['unknown', 'no answer']);
  assert.deepEqual([proofFor(r, err)!.state, proofFor(r, err)!.reason], ['unknown', 'rpc error']);
  assert.deepEqual(r.counts, { total: N, confirmed: N - 3, reverted: 1, mismatch: 0, notFound: 0, unknown: 2 });
});

test('expected revert: run reverted + chain 0x0 is a match (reverted); any status disagreement is a mismatch', () => {
  const failed = TXS.find((t) => t.status === 'reverted')!; const ok = TXS[0];
  assert.equal(judgeReceipt(failed, receiptOf(failed), HEAD, { from: AGENT, to: CORE }).state, 'reverted');
  const a = judgeReceipt(ok, { ...receiptOf(ok), status: '0x0' }, HEAD);
  assert.equal(a.state, 'mismatch'); assert.deepEqual(a.diffs, [{ field: 'status', run: 'success', chain: 'reverted' }]);
  const b = judgeReceipt(failed, { ...receiptOf(failed), status: '0x1' }, HEAD);
  assert.equal(b.state, 'mismatch'); assert.deepEqual(b.diffs, [{ field: 'status', run: 'reverted', chain: 'success' }]);
});

test('mismatch lists every field that differs, run value next to chain value; addresses compare case-insensitively', () => {
  const t = TXS[0];
  const p = judgeReceipt(t, { ...receiptOf(t), blockNumber: hex(t.block + 1), gasUsed: hex(214000), from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40) }, HEAD, { from: AGENT, to: CORE });
  assert.equal(p.state, 'mismatch');
  assert.deepEqual(p.diffs, [
    { field: 'block', run: String(t.block), chain: String(t.block + 1) },
    { field: 'gasUsed', run: t.gasUsed, chain: '214000' },
    { field: 'from', run: AGENT.toLowerCase(), chain: '0x' + '1'.repeat(40) },
    { field: 'to', run: CORE.toLowerCase(), chain: '0x' + '2'.repeat(40) },
  ]);
  assert.equal(judgeReceipt(t, { ...receiptOf(t), from: undefined }, HEAD, { from: AGENT }).diffs[0].chain, 'none');
  assert.equal(judgeReceipt(t, { ...receiptOf(t), from: AGENT.toUpperCase().replace('0X', '0x') }, HEAD, { from: AGENT }).state, 'confirmed');
  assert.equal(judgeReceipt(t, { ...receiptOf(t), from: '0x' + '1'.repeat(40) }, HEAD).state, 'confirmed', 'no expectation, no comparison');
});

test('no receipt (result null) is not-found', async () => {
  const gone = TXS[5].hash;
  const r = await verifyRun(INPUT, { fetch: fakeRpc(chain({ receipts: { [gone]: null } })).fetch });
  assert.equal(proofFor(r, gone)!.state, 'not-found'); assert.equal(r.counts.notFound, 1);
});

test('no receipt from a node whose head is below the transaction block is unknown (lagging node), not not-found', () => {
  const t = TXS[5];
  assert.equal(judgeReceipt(t, null, t.block - 1).state, 'unknown');
  assert.equal(judgeReceipt(t, null, t.block).state, 'not-found');
  assert.equal(judgeReceipt(t, null, null).state, 'not-found', 'head unknown: keep the old answer');
});

test('strict hex: malformed receipts are unknown, never confirmed and never a mismatch', () => {
  const t = TXS[0];
  for (const bad of [{ status: '0x2' }, { status: '1' }, { status: 1 }, { blockNumber: 'abc' }, { blockNumber: '0x' }, { gasUsed: '0x' + 'f'.repeat(65) }, { gasUsed: '12' }, { transactionHash: 'nope' }]) {
    const p = judgeReceipt(t, { ...receiptOf(t), ...bad }, HEAD);
    assert.deepEqual([p.state, p.reason], ['unknown', 'bad receipt'], JSON.stringify(bad));
  }
  assert.equal(judgeReceipt(t, 'x', HEAD).state, 'unknown');
  assert.equal(judgeReceipt(t, [], HEAD).state, 'unknown');
  const other = judgeReceipt(t, { ...receiptOf(t), transactionHash: TXS[1].hash }, HEAD);
  assert.deepEqual([other.state, other.reason], ['unknown', 'receipt for another hash']);
  assert.equal(hexQty('0x00ff'), 255n); assert.equal(hexQty('0xg'), null); assert.equal(hexQty(255), null); assert.equal(hexQty('0x'), null);
});

test('a lagging or broken head never breaks the check: confirmations are left out, never negative', async () => {
  for (const head of ['0x1', 'nope', null]) {
    const r = await verifyRun(INPUT, { fetch: fakeRpc(chain({ head })).fetch });
    assert.equal(r.counts.confirmed + r.counts.reverted, N, String(head));
    for (const t of r.txs) assert.equal(t.confirmations, null);
  }
  assert.equal(judgeReceipt(TXS[0], receiptOf(TXS[0]), TXS[0].block).confirmations, 1);
});

test('unknown, never a failure: network error, sync throw, HTTP error, bad JSON, non-batch answer', async () => {
  const cases: [string, any][] = [
    ['network', async () => { throw new TypeError('Failed to fetch'); }],
    ['network', () => { throw new Error('sync throw'); }],
    ['http 503', async () => ({ ok: false, status: 503, json: async () => ({}) })],
    ['bad json', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } })],
    ['not a batch answer', async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch not allowed' } }) })],
  ];
  for (const [reason, fetch] of cases) {
    const r = await verifyRun(INPUT, { fetch });
    assert.deepEqual([r.reachable, r.reason, r.head], [false, reason, null], reason);
    assert.deepEqual(r.counts, { total: N, confirmed: 0, reverted: 0, mismatch: 0, notFound: 0, unknown: N });
    assert.equal(r.mandate!.state, 'unknown');
  }
});

test('an empty batch answer is reachable but leaves every transaction unchecked', async () => {
  const r = await verifyRun(INPUT, { fetch: async () => ({ ok: true, status: 200, json: async () => [] }) });
  assert.equal(r.reachable, true); assert.equal(r.counts.unknown, N); assert.equal(r.reason, undefined);
});

test('timeout: a hung RPC is abandoned after timeoutMs, the request is aborted, every tx is unknown', async () => {
  let signal: AbortSignal | undefined; const t0 = Date.now();
  const r = await verifyRun(INPUT, { timeoutMs: 30, fetch: (_u: string, init: any) => { signal = init.signal; return new Promise(() => {}); } });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.reason, 'timeout'); assert.equal(r.counts.unknown, N); assert.equal(signal?.aborted, true);
  assert.equal(PROOF_TIMEOUT_MS, 8000);
});

test('no RPC (local dev chain): nothing is sent', async () => {
  let calls = 0;
  const r = await verifyRun({ ...INPUT, rpc: '' }, { fetch: async () => { calls++; return { ok: true, status: 200, json: async () => [] }; } });
  assert.equal(calls, 0); assert.equal(r.reason, 'no rpc'); assert.equal(r.reachable, false);
});

test('mandate: a changed limit reads as changed with both values; a non-word answer reads as unknown; no mandate input, no reads', async () => {
  const changed = await verifyRun(INPUT, { fetch: fakeRpc(chain({ mandate: { maxExec: word(300000) } })).fetch });
  assert.equal(changed.mandate!.state, 'changed');
  assert.deepEqual(changed.mandate!.fields.find((f) => f.field === 'maxExec'), { field: 'maxExec', run: '250000', chain: '300000' });
  assert.equal((await verifyRun(INPUT, { fetch: fakeRpc(chain({ mandate: { quoteTTL: '0x' } })).fetch })).mandate!.state, 'unknown');
  assert.equal((await verifyRun({ ...INPUT, mandate: undefined }, { fetch: fakeRpc(chain()).fetch })).mandate, null);
});

test('latestOnly: a slow first check never overwrites a newer one; nothing applies after stop()', async () => {
  const resolvers: ((v: number) => void)[] = []; const applied: number[] = [];
  const c = latestOnly(() => new Promise<number>((r) => resolvers.push(r)), (v) => applied.push(v));
  c.check(); c.check(); resolvers[1](2); resolvers[0](1); await tick();
  assert.deepEqual(applied, [2]);
  c.check(); c.stop(); resolvers[2](3); await tick();
  assert.deepEqual(applied, [2]);
  c.check(); assert.equal(resolvers.length, 3, 'no new job after stop()');
  const bad = latestOnly(() => Promise.reject(new Error('x')), () => assert.fail('applied a rejection'));
  bad.check(); await tick();
});

test('provenance helpers: fixed-format UTC date, block span, clock', () => {
  assert.equal(runDateText('2026-10-02T15:17:28.542Z'), '2 Oct 2026, 15:17 UTC');
  assert.match(runDateText(RUN.meta.startedAt), /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$/);
  assert.equal(runDateText('not a date'), '');
  assert.deepEqual(blockSpan(TXS), { first: Math.min(...TXS.map((t) => t.block)), last: Math.max(...TXS.map((t) => t.block)) });
  assert.deepEqual(blockSpan([{ block: 7 }, { block: 3 }, { block: 5 }] as RunTx[]), { first: 3, last: 7 });
  assert.equal(blockSpan([]), null);
  assert.equal(clockText(Date.UTC(2026, 9, 3, 14, 54, 36)), '14:54:36 UTC');
});

test('expected revert needs the run to say exactly "reverted"; any other run status is a mismatch against either chain status', () => {
  const t = TXS[0];
  for (const status of ['Success', 'pending', '', undefined as unknown as string, 'REVERTED']) {
    for (const chainStatus of ['0x0', '0x1']) {
      const p = judgeReceipt({ ...t, status }, { ...receiptOf(t), status: chainStatus }, HEAD);
      assert.equal(p.state, 'mismatch', `${String(status)} vs ${chainStatus}`);
      assert.equal(p.diffs[0].field, 'status');
      assert.equal(p.diffs[0].run, 'unrecognised');
      assert.equal(p.diffs[0].chain, chainStatus === '0x1' ? 'success' : 'reverted');
    }
  }
});

test('the HTTP reason is fixed text: a status outside 100..599 or not an integer reads "http error"', async () => {
  const reasonFor = async (status: unknown) => (await verifyRun(INPUT, { fetch: async () => ({ ok: false, status, json: async () => ({}) }) as any })).reason;
  assert.equal(await reasonFor(503), 'http 503');
  assert.equal(await reasonFor(100), 'http 100');
  assert.equal(await reasonFor(599), 'http 599');
  for (const hostile of ['<script>alert(1)</script>', '503', 99, 600, 503.5, NaN, null, undefined]) assert.equal(await reasonFor(hostile), 'http error', String(hostile));
});

test('latestOnly: a job that throws synchronously or rejects never makes check() throw, applies nothing, and a later check still works', async () => {
  const applied: number[] = [];
  const sync = latestOnly<number>(() => { throw new Error('sync'); }, (v) => applied.push(v));
  assert.doesNotThrow(() => sync.check()); await tick();
  const rej = latestOnly<number>(() => Promise.reject(new Error('async')), (v) => applied.push(v));
  assert.doesNotThrow(() => rej.check()); await tick();
  assert.deepEqual(applied, []);
  let fail = true;
  const c = latestOnly<number>(() => { if (fail) throw new Error('first'); return Promise.resolve(7); }, (v) => applied.push(v));
  c.check(); fail = false; c.check(); await tick();
  assert.deepEqual(applied, [7]);
});

test('an id that appears more than once in the answer makes only that item unknown ("duplicate answer")', async () => {
  const dup = TXS[2].hash; const base = chain();
  const calls = buildBatch(INPUT);
  const dupId = calls.find((c) => c.params[0] === dup)!.id;
  const r = await verifyRun(INPUT, { fetch: fakeRpc(base, { extra: [{ jsonrpc: '2.0', id: dupId, result: null }] }).fetch });
  assert.deepEqual([proofFor(r, dup)!.state, proofFor(r, dup)!.reason], ['unknown', 'duplicate answer']);
  assert.deepEqual(r.counts, { total: N, confirmed: N - 2, reverted: 1, mismatch: 0, notFound: 0, unknown: 1 });
  const head = await verifyRun(INPUT, { fetch: fakeRpc(base, { extra: [{ jsonrpc: '2.0', id: 1, result: hex(HEAD) }] }).fetch });
  assert.equal(head.head, null); assert.equal(head.counts.confirmed + head.counts.reverted, N);
  const mand = await verifyRun(INPUT, { fetch: fakeRpc(base, { extra: [{ jsonrpc: '2.0', id: 2 + N, result: word(250000) }] }).fetch });
  assert.equal(mand.mandate!.state, 'unknown');
});

test('numbers above 2^53: head and block never become inexact numbers; mandate values compare exactly as BigInt', async () => {
  const big = hex(1n << 60n);
  const headBig = await verifyRun(INPUT, { fetch: fakeRpc(chain({ head: big })).fetch });
  assert.equal(headBig.head, null); assert.equal(headBig.counts.confirmed + headBig.counts.reverted, N);
  for (const t of headBig.txs) assert.equal(t.confirmations, null);
  const p = judgeReceipt(TXS[0], { ...receiptOf(TXS[0]), blockNumber: big }, HEAD);
  assert.deepEqual([p.state, p.reason], ['unknown', 'bad receipt']);
  const policy = { ...RUN.policy, maxExec: '9007199254740993' };
  const input = { ...INPUT, mandate: { core: CORE, policy } };
  const same = await verifyRun(input, { fetch: fakeRpc(chain({ mandate: { maxExec: word(9007199254740993n) } })).fetch });
  assert.equal(same.mandate!.state, 'same');
  const off = await verifyRun(input, { fetch: fakeRpc(chain({ mandate: { maxExec: word(9007199254740992n) } })).fetch });
  assert.equal(off.mandate!.state, 'changed');
  assert.deepEqual(off.mandate!.fields.find((f) => f.field === 'maxExec'), { field: 'maxExec', run: '9007199254740993', chain: '9007199254740992' });
});

test('an answer that carries both an error and a result is unknown, never trusted', async () => {
  const bad = TXS[1].hash; const base = chain();
  const r = await verifyRun(INPUT, { fetch: fakeRpc((c) => (c.params[0] === bad ? { error: { code: -1, message: 'x' }, result: receiptOf(TXS[1]) } as any : base(c))).fetch });
  assert.deepEqual([proofFor(r, bad)!.state, proofFor(r, bad)!.reason], ['unknown', 'rpc error']);
  const m = await verifyRun(INPUT, { fetch: fakeRpc((c) => (c.method === 'eth_call' ? { error: { code: -1, message: 'x' }, result: word(250000) } as any : base(c))).fetch });
  assert.equal(m.mandate!.state, 'unknown');
});

test('timeout: a fetch that honors the abort signal still reads as timeout, and the timer is cleared on every exit', async () => {
  const r = await verifyRun(INPUT, { timeoutMs: 20, fetch: (_u: string, init: any) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); }) });
  assert.equal(r.reason, 'timeout'); assert.equal(r.counts.unknown, N);
  // the default timer (8 s) must be cleared once a fast answer arrives, or it would hold the page and the process
  const realSet = globalThis.setTimeout; const realClear = globalThis.clearTimeout;
  const made: unknown[] = []; const cleared: unknown[] = [];
  globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => { const h = realSet(...a); if (a[1] === PROOF_TIMEOUT_MS) made.push(h); return h; }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: any) => { cleared.push(h); return realClear(h); }) as typeof clearTimeout;
  try {
    await verifyRun(INPUT, { fetch: fakeRpc(chain()).fetch });
    await verifyRun(INPUT, { fetch: async () => { throw new Error('down'); } });
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
  assert.equal(made.length, 2);
  for (const h of made) assert.ok(cleared.includes(h), 'timer cleared');
});
