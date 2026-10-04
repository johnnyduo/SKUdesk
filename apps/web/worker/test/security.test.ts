import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../http.ts';
import { checkOrigin, enforceRateLimit, isAdmin, rateKey, readJsonBody, resetLimiterWarning, sha256Hex, timingSafeEqualStr } from '../security.ts';
import { limiter } from './helpers/fakes.ts';

const TOKEN = 'a'.repeat(40);
const SITE = 'https://robinize.agent-dong.workers.dev';

test('timingSafeEqualStr compares by value', async () => {
  assert.equal(await timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(await timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(await timingSafeEqualStr('abc', 'abcd'), false);
});

test('isAdmin: correct token passes, wrong/missing fails', async () => {
  const ok = new Request('https://x.test/', { headers: { 'x-admin-token': TOKEN } });
  const bad = new Request('https://x.test/', { headers: { 'x-admin-token': TOKEN + 'x' } });
  assert.equal(await isAdmin(ok, TOKEN), true);
  assert.equal(await isAdmin(bad, TOKEN), false);
  assert.equal(await isAdmin(new Request('https://x.test/'), TOKEN), false);
});

test('isAdmin: unset, empty or short ADMIN_TOKEN never authorizes (even an empty header)', async () => {
  const empty = new Request('https://x.test/', { headers: { 'x-admin-token': '' } });
  const short = new Request('https://x.test/', { headers: { 'x-admin-token': 'short' } });
  assert.equal(await isAdmin(empty, undefined), false);
  assert.equal(await isAdmin(empty, ''), false);
  assert.equal(await isAdmin(short, 'short'), false);
});

test('checkOrigin: GET always allowed; POST needs same origin or no browser origin', () => {
  const mk = (method: string, headers: Record<string, string>) => new Request('https://robinize.agent-dong.workers.dev/api/x', { method, headers });
  assert.equal(checkOrigin(mk('GET', { origin: 'https://evil.test' }), SITE), true);
  assert.equal(checkOrigin(mk('POST', { origin: SITE }), SITE), true);
  assert.equal(checkOrigin(mk('POST', { origin: 'https://evil.test' }), SITE), false);
  assert.equal(checkOrigin(mk('POST', { origin: 'null' }), SITE), false);
  assert.equal(checkOrigin(mk('DELETE', { 'sec-fetch-site': 'cross-site' }), SITE), false);
  assert.equal(checkOrigin(mk('POST', {}), SITE), true);
  const local = new Request('http://localhost:8787/api/x', { method: 'POST', headers: { origin: 'http://localhost:8787' } });
  assert.equal(checkOrigin(local, SITE), true);
});

test('rateKey: admin keyed by token hash prefix, public by IP; never contains the token', async () => {
  const req = new Request('https://x.test/', { headers: { 'x-admin-token': TOKEN, 'cf-connecting-ip': '203.0.113.9' } });
  const adm = await rateKey(req, 'POST /api/merchant/listing', true);
  assert.equal(adm, 'POST /api/merchant/listing:adm:' + (await sha256Hex(TOKEN)).slice(0, 16));
  assert.ok(!adm.includes(TOKEN));
  assert.equal(await rateKey(req, 'GET /api/prices/compare', false), 'GET /api/prices/compare:ip:203.0.113.9');
});

test('enforceRateLimit throws 429 when the binding refuses', async () => {
  const l = limiter(1);
  await enforceRateLimit(l, 'k');
  await assert.rejects(enforceRateLimit(l, 'k'), (e: unknown) => e instanceof HttpError && e.status === 429 && e.code === 'RATE_LIMITED');
  await enforceRateLimit(undefined, 'k');
});

test('readJsonBody: content-type, size cap, invalid JSON', async () => {
  const ok = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"a":1}' });
  assert.deepEqual(await readJsonBody(ok), { a: 1 });
  const form = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"a":1}' });
  await assert.rejects(readJsonBody(form), (e: unknown) => e instanceof HttpError && e.status === 415);
  const big = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ s: 'x'.repeat(17000) }) });
  await assert.rejects(readJsonBody(big), (e: unknown) => e instanceof HttpError && e.status === 413);
  const broken = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":' });
  await assert.rejects(readJsonBody(broken), (e: unknown) => e instanceof HttpError && e.status === 400 && !e.message.includes('{"a":'));
});

function chunked(totalBytes: number, chunk = 1024) {
  let sent = 0;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent >= totalBytes) { ctrl.close(); return; }
      const n = Math.min(chunk, totalBytes - sent);
      ctrl.enqueue(new Uint8Array(n).fill(0x20));
      sent += n;
    },
    cancel() { state.cancelled = true; },
  });
  return { stream, state };
}

test('readJsonBody: chunked body without Content-Length is cut off at the cap and the stream is cancelled', async () => {
  const { stream, state } = chunked(1024 * 1024);
  const req = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
  await assert.rejects(readJsonBody(req), (e: unknown) => e instanceof HttpError && e.status === 413);
  assert.equal(state.cancelled, true);
});

test('readJsonBody: non-numeric Content-Length -> 400', async () => {
  for (const cl of ['abc', '-5', '1e3', '12 ', '0x10', '']) {
    const req = { headers: new Headers({ 'content-type': 'application/json', 'content-length': cl }), body: null, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Request;
    await assert.rejects(readJsonBody(req), (e: unknown) => e instanceof HttpError && e.status === 400, 'content-length=' + JSON.stringify(cl));
  }
});

test('readJsonBody: understated Content-Length vs real size -> 413; exactly 16384 bytes is accepted', async () => {
  const big = '{"s":"' + 'x'.repeat(20000) + '"}';
  const lie = { headers: new Headers({ 'content-type': 'application/json', 'content-length': '10' }), body: new Response(big).body } as unknown as Request;
  await assert.rejects(readJsonBody(lie), (e: unknown) => e instanceof HttpError && e.status === 413);
  const head = '{"s":"';
  const tail = '"}';
  const exact = head + 'x'.repeat(16384 - head.length - tail.length) + tail;
  assert.equal(new TextEncoder().encode(exact).length, 16384);
  const ok = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact });
  assert.equal(((await readJsonBody(ok)) as { s: string }).s.length, 16384 - 8);
  const over = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact + ' ' });
  await assert.rejects(readJsonBody(over), (e: unknown) => e instanceof HttpError && e.status === 413);
});

test('readJsonBody: content-type must be exactly application/json (jsonx refused)', async () => {
  for (const ct of ['application/jsonx', 'application/json-patch+json', 'text/application/json']) {
    const req = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': ct }, body: '{}' });
    await assert.rejects(readJsonBody(req), (e: unknown) => e instanceof HttpError && e.status === 415, ct);
  }
  const ok = new Request('https://x.test/', { method: 'POST', headers: { 'content-type': ' Application/JSON ; charset=utf-8' }, body: '{}' });
  assert.deepEqual(await readJsonBody(ok), {});
});

test('checkOrigin: lookalike and empty Origin are refused', () => {
  const mk = (origin: string) => new Request('https://robinize.agent-dong.workers.dev/api/x', { method: 'POST', headers: { origin } });
  assert.equal(checkOrigin(mk(SITE + '.evil.test'), SITE), false);
  assert.equal(checkOrigin(mk(''), SITE), false);
});

test('enforceRateLimit: a missing binding fails open but warns once', async () => {
  resetLimiterWarning();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    await enforceRateLimit(undefined, 'k1');
    await enforceRateLimit(undefined, 'k2');
  } finally { console.log = orig; }
  const warns = lines.filter((l) => l.includes('rate_limiter_missing'));
  assert.equal(warns.length, 1);
});
