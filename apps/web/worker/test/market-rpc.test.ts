import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError, SCHEDULE_SELECTORS, blockCall, hexInt, hexOf, logsCall, rpcBatch, scheduleCalls } from '../market/rpc.ts';
import { jsonResponse, scriptedFetch } from './helpers/fakes.ts';

test('schedule selectors are the BlindBook getters (pinned against viem)', async () => {
  const { toFunctionSelector } = await import('viem');
  for (const [name, sel] of Object.entries(SCHEDULE_SELECTORS)) assert.equal(sel, toFunctionSelector(`${name}()`));
});

test('rpcBatch: one POST, results matched by id whatever order they come back in', async () => {
  const net = scriptedFetch([() => jsonResponse([{ jsonrpc: '2.0', id: 2, result: 'b' }, { jsonrpc: '2.0', id: 1, result: 'a' }])]);
  assert.deepEqual(await rpcBatch(net.fetch, 'https://rpc.test', [{ method: 'm1', params: [] }, { method: 'm2', params: [1] }]), ['a', 'b']);
  assert.equal(net.calls.length, 1); assert.equal(net.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(net.calls[0].body!).map((c: any) => [c.id, c.method]), [[1, 'm1'], [2, 'm2']]);
});

test('rpcBatch: transport, HTTP, JSON, missing and error results become short RpcError codes', async () => {
  const code = (c: string) => (e: unknown) => e instanceof RpcError && e.code === c && e.message === c;
  await assert.rejects(rpcBatch(async () => { throw new TypeError('connect ECONNREFUSED secret'); }, 'u', [{ method: 'x', params: [] }]), code('RPC_UNREACHABLE'));
  await assert.rejects(rpcBatch(async () => new Response('secret', { status: 429 }), 'u', [{ method: 'x', params: [] }]), code('RPC_HTTP_429'));
  await assert.rejects(rpcBatch(async () => new Response('<html>'), 'u', [{ method: 'x', params: [] }]), code('RPC_BAD_JSON'));
  await assert.rejects(rpcBatch(async () => jsonResponse([]), 'u', [{ method: 'x', params: [] }]), code('RPC_MISSING_RESULT'));
  await assert.rejects(rpcBatch(async () => jsonResponse([{ id: 1, error: { code: -32005, message: 'secret limit' } }]), 'u', [{ method: 'x', params: [] }]), code('RPC_ERROR'));
});

test('hexInt accepts only short hex quantities', () => {
  assert.equal(hexInt('0x7a122ea'), 128000746);
});

const one = [{ method: 'x', params: [] }];
const within = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('did not settle within ' + ms + 'ms')), ms); })]).finally(() => clearTimeout(t));
};
const rpcErr = (code: string) => (e: unknown) => e instanceof RpcError && e.code === code && e.message === code;

test('rpcBatch: passes an AbortSignal that is not yet aborted', async () => {
  let seen: unknown;
  await rpcBatch(async (_u, init) => { seen = init?.signal; return jsonResponse([{ id: 1, result: 'a' }]); }, 'u', one);
  assert.equal(typeof seen, 'object');
  assert.ok(seen !== null);
  assert.equal((seen as AbortSignal).aborted, false);
});

test('rpcBatch: a fetch that never answers is aborted by the timeout -> RPC_UNREACHABLE', async () => {
  const hang: typeof fetch = (_u, init) => new Promise<Response>((_, rej) => {
    init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
  });
  await assert.rejects(within(rpcBatch(hang, 'u', one, 20), 1000), rpcErr('RPC_UNREACHABLE'));
});

test('rpcBatch: a body that stalls until the timeout aborts -> RpcError', async () => {
  const stall: typeof fetch = async (_u, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) { init!.signal!.addEventListener('abort', () => ctrl.error(init!.signal!.reason)); },
    });
    return new Response(body, { status: 200 });
  };
  await assert.rejects(within(rpcBatch(stall, 'u', one, 20), 1000), rpcErr('RPC_BAD_JSON'));
});

test('rpcBatch: a single non-array error object -> RPC_ERROR carrying only the numeric rpcCode', async () => {
  await assert.rejects(rpcBatch(async () => jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'upstream-secret limit' } }), 'u', one), (e: unknown) => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.code, 'RPC_ERROR');
    assert.equal(e.message, 'RPC_ERROR');
    assert.equal(e.rpcCode, -32005);
    return true;
  });
});

test('rpcBatch: a single non-array body without an error member stays RPC_MISSING_RESULT', async () => {
  for (const body of [null, 5, 'str', {}, { id: 7, result: 'a' }, { id: 1, error: null }]) {
    await assert.rejects(rpcBatch(async () => jsonResponse(body), 'u', one), rpcErr('RPC_MISSING_RESULT'), 'body ' + JSON.stringify(body));
  }
});

test('rpcBatch: an item with neither result nor error is missing; result:null is a valid result', async () => {
  await assert.rejects(rpcBatch(async () => jsonResponse([{ jsonrpc: '2.0', id: 1 }]), 'u', one), rpcErr('RPC_MISSING_RESULT'));
  await assert.rejects(rpcBatch(async () => jsonResponse([{ id: 1, error: null }]), 'u', one), rpcErr('RPC_MISSING_RESULT'));
  assert.deepEqual(await rpcBatch(async () => jsonResponse([{ id: 1, result: null }]), 'u', one), [null]);
});

test('rpcBatch: empty calls return [] without touching the network', async () => {
  let n = 0;
  assert.deepEqual(await rpcBatch(async () => { n++; return jsonResponse([]); }, 'u', []), []);
  assert.equal(n, 0);
});

test('rpcBatch: non-2xx cancels the body before throwing', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } });
  await assert.rejects(rpcBatch(async () => new Response(body, { status: 503 }), 'u', one), rpcErr('RPC_HTTP_503'));
  assert.equal(cancelled, true);
});

test('rpcBatch: non-2xx with an already-locked or unreadable body still throws the HTTP code', async () => {
  const res = new Response('x', { status: 500 });
  res.body!.getReader();
  await assert.rejects(rpcBatch(async () => res, 'u', one), rpcErr('RPC_HTTP_500'));
});

test('rpcBatch: a declared content-length above 4 MB is RPC_TOO_BIG; missing or small is fine', async () => {
  const ok = JSON.stringify([{ id: 1, result: 'a' }]);
  await assert.rejects(rpcBatch(async () => new Response(ok, { headers: { 'content-length': '4000001' } }), 'u', one), rpcErr('RPC_TOO_BIG'));
  assert.deepEqual(await rpcBatch(async () => new Response(ok, { headers: { 'content-length': '4000000' } }), 'u', one), ['a']);
  assert.deepEqual(await rpcBatch(async () => new Response(ok), 'u', one), ['a']);
  assert.deepEqual(await rpcBatch(async () => new Response(ok, { headers: { 'content-length': '5' } }), 'u', one), ['a']);
});

test('rpcBatch: per-item error exposes rpcCode and never copies the upstream message', async () => {
  await assert.rejects(rpcBatch(async () => jsonResponse([{ id: 1, error: { code: -32005, message: 'upstream-secret limit' } }]), 'u', one), (e: unknown) => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.code, 'RPC_ERROR');
    assert.equal(e.message, 'RPC_ERROR');
    assert.equal(e.rpcCode, -32005);
    for (const [k, v] of Object.entries(e)) if (k !== 'rpcCode') assert.ok(!String(v).includes('upstream-secret'), 'property ' + k + ' leaks the upstream message');
    return true;
  });
  for (const error of [{ message: 'upstream-secret' }, { code: '-32005', message: 'm' }, { code: 1.5 }, 'boom']) {
    await assert.rejects(rpcBatch(async () => jsonResponse([{ id: 1, error }]), 'u', one), (e: unknown) => e instanceof RpcError && e.code === 'RPC_ERROR' && e.rpcCode === undefined, JSON.stringify(error));
  }
});

test('rpcBatch: duplicate ids are RPC_BAD_JSON; string ids are not matched', async () => {
  await assert.rejects(rpcBatch(async () => jsonResponse([{ id: 1, result: 'a' }, { id: 1, result: 'b' }]), 'u', one), rpcErr('RPC_BAD_JSON'));
  await assert.rejects(rpcBatch(async () => jsonResponse([{ id: '1', result: 'a' }]), 'u', one), rpcErr('RPC_MISSING_RESULT'));
});

test('hexOf: encodes safe non-negative integers and throws RangeError otherwise', () => {
  assert.equal(hexOf(0), '0x0');
  assert.equal(hexOf(255), '0xff');
  assert.equal(hexOf(Number.MAX_SAFE_INTEGER), '0x1fffffffffffff');
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 53]) assert.throws(() => hexOf(bad), RangeError, String(bad));
});

test('hexInt accepts', () => {
  assert.equal(hexInt('0x0'), 0);
  assert.equal(hexInt('0x0001'), 1);
  assert.equal(hexInt('0x' + 'f'.repeat(13)), 2 ** 52 - 1);
  assert.equal(hexInt('0xAB'), 171);
});

test('hexInt rejects (each case on its own)', () => {
  const rejected: Array<[string, unknown]> = [
    ['empty digits', '0x'], ['no prefix', 'abc'], ['negative', '-0x1'], ['upper-case prefix', '0X1f'], ['leading space', ' 0x1'],
    ['trailing newline', '0x1\n'], ['14 digits', '0x' + 'f'.repeat(14)], ['64-digit word', '0x' + '0'.repeat(63) + '1'],
    ['JSON number', 5], ['undefined', undefined],
  ];
  for (const [why, v] of rejected) assert.ok(Number.isNaN(hexInt(v)), why);
});

test('scheduleCalls: five eth_call getters in the order t0, epochLen, commitEnd, revealEnd, bond', () => {
  const calls = scheduleCalls('0xBook');
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map((c) => c.method), Array(5).fill('eth_call'));
  assert.deepEqual(calls.map((c) => c.params), ['t0', 'epochLen', 'commitEnd', 'revealEnd', 'bond'].map((k) => [{ to: '0xBook', data: SCHEDULE_SELECTORS[k as keyof typeof SCHEDULE_SELECTORS] }, 'latest']));
});

test('blockCall and logsCall build the expected params', () => {
  assert.deepEqual(blockCall('latest'), { method: 'eth_getBlockByNumber', params: ['latest', false] });
  assert.deepEqual(blockCall(255), { method: 'eth_getBlockByNumber', params: ['0xff', false] });
  assert.deepEqual(logsCall('0xAddr', 16, 255, ['0x1', '0x2']), { method: 'eth_getLogs', params: [{ address: '0xAddr', fromBlock: '0x10', toBlock: '0xff', topics: [['0x1', '0x2']] }] });
});
