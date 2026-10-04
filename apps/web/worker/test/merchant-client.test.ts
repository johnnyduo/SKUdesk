import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HttpError } from '../http.ts';
import { backoffMs, createMerchantClient, mapGoogleError } from '../google/merchantClient.ts';
import { jsonResponse, scriptedFetch } from './helpers/fakes.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/merchant/' + name, import.meta.url), 'utf8'));

function client(script: Parameters<typeof scriptedFetch>[0]) {
  const net = scriptedFetch(script);
  const sleeps: number[] = [];
  const tokenCalls: boolean[] = [];
  const c = createMerchantClient({
    base: 'https://merchantapi.googleapis.com',
    getToken: async (force) => { tokenCalls.push(force); return force ? 'ya29.fresh' : 'ya29.cached'; },
    fetch: net.fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    nowMs: () => 1000,
  });
  return { c, net, sleeps, tokenCalls };
}

test('backoffMs grows exponentially with jitter and caps at 4000 + jitter', () => {
  assert.equal(backoffMs(0, () => 0), 250);
  assert.equal(backoffMs(1, () => 0), 500);
  assert.equal(backoffMs(2, () => 0.999), 1000 + 249);
  assert.equal(backoffMs(9, () => 0), 4000);
});

test('request: sends bearer token, JSON body and query; parses response', async () => {
  const { c, net } = client([() => jsonResponse(fx('insert-ok.json'))]);
  const r = await c.request<{ name: string }>({ method: 'POST', path: '/products/v1/accounts/123/productInputs:insert', query: { dataSource: 'accounts/123/dataSources/456' }, body: { offerId: 'LOT-1842' } });
  assert.equal(r.data.name, 'accounts/123/productInputs/en~US~LOT-1842');
  assert.equal(net.calls[0].url, 'https://merchantapi.googleapis.com/products/v1/accounts/123/productInputs:insert?dataSource=accounts%2F123%2FdataSources%2F456');
  assert.equal(net.calls[0].headers.authorization, 'Bearer ya29.cached');
  assert.equal(net.calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(net.calls[0].body ?? ''), { offerId: 'LOT-1842' });
});

test('request: 401 once -> refresh token and retry; second success', async () => {
  const { c, tokenCalls } = client([() => jsonResponse(fx('error-401.json'), 401), () => jsonResponse({ ok: 1 })]);
  const r = await c.request<{ ok: number }>({ method: 'GET', path: '/accounts/v1/accounts/123' });
  assert.equal(r.data.ok, 1);
  assert.deepEqual(tokenCalls, [false, true]);
});

test('request: not-registered 401 maps to MERCHANT_NOT_REGISTERED without a refresh loop', async () => {
  const { c, tokenCalls } = client([() => jsonResponse(fx('error-not-registered.json'), 401)]);
  await assert.rejects(c.request({ method: 'GET', path: '/accounts/v1/accounts/123' }), (e: unknown) => e instanceof HttpError && e.code === 'MERCHANT_NOT_REGISTERED');
  assert.deepEqual(tokenCalls, [false]);
});

test('request: 429 retried 3 times then MERCHANT_QUOTA; 5xx then success', async () => {
  const q = client([0, 1, 2, 3].map(() => () => jsonResponse(fx('error-429.json'), 429)));
  await assert.rejects(q.c.request({ method: 'GET', path: '/x' }), (e: unknown) => e instanceof HttpError && e.code === 'MERCHANT_QUOTA' && e.status === 503);
  assert.deepEqual(q.sleeps, [375, 625, 1125]);
  const s = client([() => jsonResponse({}, 503), () => jsonResponse({ ok: true })]);
  const r = await s.c.request<{ ok: boolean }>({ method: 'GET', path: '/x' });
  assert.equal(r.attempts, 2);
});

test('request: network failure retried, then 504 MERCHANT_UPSTREAM', async () => {
  const boom = () => { throw new TypeError('network down'); };
  const { c } = client([boom, boom, boom, boom]);
  await assert.rejects(c.request({ method: 'GET', path: '/x' }), (e: unknown) => e instanceof HttpError && e.status === 504 && e.code === 'MERCHANT_UPSTREAM');
});

test('mapGoogleError: 400 is static (never echoes Google text), field paths only from fieldViolations; 404/403 map to stable codes', () => {
  const bad = mapGoogleError(400, fx('error-400.json'));
  assert.equal(bad.code, 'MERCHANT_INVALID_PRODUCT');
  assert.equal(bad.status, 422);
  assert.equal(bad.message, 'Merchant API rejected the request');
  assert.ok(!bad.message.includes('Invalid price'));
  const withFields = mapGoogleError(400, { error: { message: 'SENTINEL-TEXT', details: [{ fieldViolations: [{ field: 'productAttributes.price', description: 'SENTINEL-DESC' }, { field: 'bad field <script>', description: 'x' }, { field: 'a'.repeat(81) }] }] } });
  assert.equal(withFields.message, 'Merchant API rejected the request (fields: productAttributes.price)');
  assert.ok(!withFields.message.includes('SENTINEL'));
  assert.equal(mapGoogleError(404, {}).code, 'MERCHANT_NOT_FOUND');
  assert.equal(mapGoogleError(403, { error: { message: 'The caller does not have permission' } }).code, 'MERCHANT_UNAUTHORIZED');
  assert.equal(mapGoogleError(500, 'not json').code, 'MERCHANT_UPSTREAM');
});

test('request: forceRefresh applies only to the first call after a 401; two consecutive 401 -> one refresh then MERCHANT_UNAUTHORIZED', async () => {
  const { c, tokenCalls, net } = client([() => jsonResponse(fx('error-401.json'), 401), () => jsonResponse(fx('error-401.json'), 401)]);
  await assert.rejects(c.request({ method: 'GET', path: '/x' }), (e: unknown) => e instanceof HttpError && e.code === 'MERCHANT_UNAUTHORIZED');
  assert.deepEqual(tokenCalls, [false, true]);
  assert.equal(net.calls.length, 2);
});

test('request: refresh after 401 does not force-refresh later 5xx retries', async () => {
  const { c, tokenCalls } = client([() => jsonResponse(fx('error-401.json'), 401), () => jsonResponse({}, 503), () => jsonResponse({ ok: 1 })]);
  await c.request({ method: 'GET', path: '/x' });
  assert.deepEqual(tokenCalls, [false, true, false]);
});

test('request: 400 and 404 are not retried', async () => {
  for (const status of [400, 404]) {
    const { c, net, sleeps } = client([() => jsonResponse({ error: { message: 'x' } }, status), () => jsonResponse({ ok: 1 })]);
    await assert.rejects(c.request({ method: 'GET', path: '/x' }), (e: unknown) => e instanceof HttpError);
    assert.equal(net.calls.length, 1);
    assert.equal(sleeps.length, 0);
  }
});

test('request: a 2xx whose body is not JSON throws the static MERCHANT_UPSTREAM error (no upstream text), not retried, never becomes {}', async () => {
  for (const [method, text] of [['GET', '<html>SENTINEL-UPSTREAM maintenance</html>'], ['POST', 'SENTINEL-UPSTREAM {not json'], ['GET', ''], ['GET', 'null'], ['PATCH', '"just a string"']] as const) {
    const { c, net, sleeps } = client([() => new Response(text, { status: 200, headers: { 'content-type': 'text/html' } })]);
    await assert.rejects(c.request({ method, path: '/accounts/v1/accounts/123' }), (e: unknown) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.status, 502);
      assert.equal(e.code, 'MERCHANT_UPSTREAM');
      assert.equal(e.message, 'Merchant API returned an unreadable response (HTTP 200)');
      assert.ok(!e.message.includes('SENTINEL'));
      return true;
    }, method + ' ' + JSON.stringify(text));
    assert.equal(net.calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test('request: DELETE keeps working with an empty, {} or non-JSON 2xx body (callers ignore it); 204 is {} for any method', async () => {
  for (const mk of [() => new Response('', { status: 200 }), () => new Response('{}', { status: 200 }), () => new Response(null, { status: 204 }), () => new Response('<html>ok</html>', { status: 200 })]) {
    const { c } = client([mk]);
    const r = await c.request({ method: 'DELETE', path: '/products/v1/accounts/123/productInputs/x' });
    assert.deepEqual(r.data, {});
  }
  const { c } = client([() => new Response(null, { status: 204 })]);
  assert.deepEqual((await c.request({ method: 'POST', path: '/x' })).data, {});
});

test('request: a 2xx whose body stream fails mid-read is also the static MERCHANT_UPSTREAM error', async () => {
  const broken = () => ({ ok: true, status: 200, text: async () => { throw new TypeError('terminated'); } }) as unknown as Response;
  const { c } = client([broken]);
  await assert.rejects(c.request({ method: 'GET', path: '/x' }), (e: unknown) => e instanceof HttpError && e.code === 'MERCHANT_UPSTREAM' && !e.message.includes('terminated'));
});
