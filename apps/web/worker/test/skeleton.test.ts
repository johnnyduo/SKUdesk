import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, errorResponse, json } from '../http.ts';
import { logLine } from '../log.ts';
import { matchPattern, matchRoute } from '../router.ts';
import type { Route } from '../router.ts';
import { handleFetch } from '../app.ts';
import { ROUTES } from '../routes.ts';
import { baseEnv, fakeExec, testDeps } from './helpers/fakes.ts';

test('json() sets no-store, nosniff and x-request-id', async () => {
  const res = json({ a: 1 }, 'rid-1', 201);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('x-request-id'), 'rid-1');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await res.json(), { a: 1 });
});

test('errorResponse maps HttpError to the envelope and hides unknown errors', async () => {
  const known = errorResponse(new HttpError(429, 'RATE_LIMITED', 'slow down'), 'r1');
  assert.equal(known.status, 429);
  assert.equal(known.headers.get('retry-after'), '60');
  assert.deepEqual(await known.json(), { error: { code: 'RATE_LIMITED', message: 'slow down', requestId: 'r1' } });
  const unknown = errorResponse(new Error('db password=hunter2 leaked'), 'r2');
  assert.equal(unknown.status, 500);
  const body = await unknown.text();
  assert.ok(!body.includes('hunter2'));
  assert.deepEqual(JSON.parse(body), { error: { code: 'INTERNAL', message: 'internal error', requestId: 'r2' } });
});

test('logLine redacts sensitive keys and token-looking values, truncates long values', () => {
  const line = JSON.parse(logLine({ route: '/api/x', adminToken: 'abc', apiKey: 'k', hint: 'Bearer xyz', g: 'ya29.secret', long: 'x'.repeat(500), n: 3, skip: undefined }, 0));
  assert.equal(line.ts, '1970-01-01T00:00:00.000Z');
  assert.equal(line.route, '/api/x');
  assert.equal(line.adminToken, '[redacted]');
  assert.equal(line.apiKey, '[redacted]');
  assert.equal(line.hint, '[redacted]');
  assert.equal(line.g, '[redacted]');
  assert.equal(line.long.length, 203);
  assert.equal(line.n, 3);
  assert.equal('skip' in line, false);
});

test('matchPattern extracts params and ignores trailing slash', () => {
  assert.deepEqual(matchPattern('/api/health', '/api/health/'), {});
  assert.deepEqual(matchPattern('/api/merchant/listing/:offerId', '/api/merchant/listing/LOT-1842'), { offerId: 'LOT-1842' });
  assert.equal(matchPattern('/api/merchant/listing/:offerId', '/api/merchant/listing'), null);
  assert.equal(matchPattern('/api/merchant/listing/:offerId', '/api/merchant/listing/%E0%A4%A'), null);
});

test('matchRoute reports 405 candidates', () => {
  const h = async () => new Response('');
  const routes: Route[] = [{ method: 'GET', pattern: '/api/a', handler: h }, { method: 'POST', pattern: '/api/b', handler: h }];
  assert.equal(matchRoute(routes, 'GET', '/api/a').kind, 'match');
  assert.deepEqual(matchRoute(routes, 'GET', '/api/b'), { kind: 'method_not_allowed', allow: ['POST'] });
  assert.deepEqual(matchRoute(routes, 'GET', '/api/zzz'), { kind: 'not_found' });
});

test('handleFetch: non-api paths fall through to ASSETS', async () => {
  const res = await handleFetch(new Request('https://x.test/index.html'), baseEnv() as any, fakeExec() as any, testDeps() as any);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>home</h1>');
});

test('handleFetch: /api/health returns ok with request id', async () => {
  const res = await handleFetch(new Request('https://x.test/api/health'), baseEnv() as any, fakeExec() as any, testDeps() as any);
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; requestId: string; time: string };
  assert.equal(body.ok, true);
  assert.equal(body.requestId, res.headers.get('x-request-id'));
  assert.equal(body.time, '2026-10-02T12:00:00.000Z');
});

test('handleFetch: unknown api route -> 404 envelope; wrong method -> 405', async () => {
  const nf = await handleFetch(new Request('https://x.test/api/nope'), baseEnv() as any, fakeExec() as any, testDeps() as any);
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as any).error.code, 'NOT_FOUND');
  const na = await handleFetch(new Request('https://x.test/api/health', { method: 'POST' }), baseEnv() as any, fakeExec() as any, testDeps() as any);
  assert.equal(na.status, 405);
  assert.equal(na.headers.get('allow'), 'GET');
});

function captureLogs() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.log = orig; } };
}

test('handleFetch: handler log fields cannot overwrite core request fields', async () => {
  const route: Route = { method: 'GET', pattern: '/api/__spoof', handler: async (c) => { c.log.status = 999; c.log.route = 'spoofed'; c.log.requestId = 'spoofed'; c.log.mode = 'X'; return json({ ok: 1 }, c.requestId); } };
  ROUTES.push(route);
  const cap = captureLogs();
  let res: Response;
  try { res = await handleFetch(new Request('https://x.test/api/__spoof'), baseEnv() as any, fakeExec() as any, testDeps() as any); } finally { cap.restore(); ROUTES.splice(ROUTES.indexOf(route), 1); }
  const l = JSON.parse(cap.lines.find((x) => x.includes('"route"'))!);
  assert.deepEqual([l.status, l.route, l.requestId, l.mode], [200, '/api/__spoof', res.headers.get('x-request-id'), 'X']);
});

test('handleFetch: the 405 branch logs code METHOD_NOT_ALLOWED', async () => {
  const cap = captureLogs();
  try { await handleFetch(new Request('https://x.test/api/health', { method: 'POST' }), baseEnv() as any, fakeExec() as any, testDeps() as any); } finally { cap.restore(); }
  const l = JSON.parse(cap.lines.find((x) => x.includes('"route"'))!);
  assert.deepEqual([l.status, l.code], [405, 'METHOD_NOT_ALLOWED']);
});
