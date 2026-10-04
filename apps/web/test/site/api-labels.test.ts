import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCall, createApi } from '../../src/lib/api.ts';
import { flagText, fmtBpsPct, fmtCents, listingPill, modePill } from '../../src/lib/labels.ts';

const jsonRes = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

test('modePill / listingPill map every backend mode to an honest label', () => {
  assert.deepEqual(modePill('REAL'), { cls: 'ok', text: 'REAL' });
  assert.deepEqual(modePill('MOCK'), { cls: 'warn', text: 'TEST DATA' });
  assert.deepEqual(modePill('NOT_CONNECTED'), { cls: 'warn', text: 'NOT CONNECTED' });
  assert.deepEqual(modePill('DRY_RUN'), { cls: 'blue', text: 'DRY RUN · nothing sent' });
  assert.deepEqual(modePill('OFFLINE'), { cls: 'bad', text: 'API NOT CONNECTED' });
  assert.equal(modePill('SOMETHING').cls, 'warn');
  assert.equal(listingPill('APPROVED').cls, 'ok');
  assert.equal(listingPill('DISAPPROVED').cls, 'bad');
  assert.equal(listingPill('SUBMITTED').cls, 'blue');
});

test('fmtCents is integer-exact; fmtBpsPct; flagText', () => {
  assert.equal(fmtCents(1099), '$10.99');
  assert.equal(fmtCents(5), '$0.05');
  assert.equal(fmtCents(-110), '-$1.10');
  assert.equal(fmtCents(null), '—');
  assert.equal(fmtCents(10.5), '—');
  assert.equal(fmtBpsPct(1112), '11.12%');
  assert.equal(flagText('all_mock'), 'all prices are test data (no source has an API key yet)');
  for (const f of ['single_source', 'gtin_unavailable', 'stale_cache', 'quota_exhausted', 'no_canonical', 'all_mock', 'no_locked_offers']) assert.doesNotMatch(flagText(f), /\bmock|\bdemo/i, f);
  assert.equal(flagText('new_flag'), 'new_flag');
});

test('apiCall: success, error envelope, non-JSON (no Worker) and network failure', async () => {
  const ok = await apiCall<{ a: number }>('/api/x', {}, async () => jsonRes({ a: 1 }));
  assert.deepEqual(ok, { ok: true, status: 200, data: { a: 1 } });
  const err = await apiCall('/api/x', {}, async () => jsonRes({ error: { code: 'UNAUTHORIZED', message: 'no', requestId: 'r1' } }, 401));
  assert.deepEqual(err, { ok: false, status: 401, offline: false, error: { code: 'UNAUTHORIZED', message: 'no', requestId: 'r1' } });
  const html = await apiCall('/api/x', {}, async () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
  assert.equal(html.ok, false);
  assert.equal(!html.ok && html.offline, true);
  const down = await apiCall('/api/x', {}, async () => { throw new TypeError('fetch failed'); });
  assert.equal(!down.ok && down.offline && down.error.code, 'OFFLINE');
});

test('createApi: publish sends JSON + token header only when given; compare builds the query string', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const api = createApi(async (url, init) => { seen.push({ url, init }); return jsonRes({ mode: 'DRY_RUN' }); });
  const body = { lotId: 'LOT-1842', title: 't', link: 'https://x/p/a/', imageLink: 'https://x/a.png', priceCents: 1099, dryRun: true };
  await api.publishListing(body);
  await api.publishListing({ ...body, dryRun: false }, 'secret-token');
  const h0 = seen[0].init?.headers as Record<string, string>;
  const h1 = seen[1].init?.headers as Record<string, string>;
  assert.equal(seen[0].url, '/api/merchant/listing');
  assert.equal(seen[0].init?.method, 'POST');
  assert.equal(h0['x-admin-token'], undefined);
  assert.equal(h1['x-admin-token'], 'secret-token');
  assert.deepEqual(JSON.parse(String(seen[1].init?.body)), { ...body, dryRun: false });
  await api.compare({ sku: 'CASE-IP16PRO-CLEAR-MAG-001', gtin: '036000291452' });
  assert.equal(seen[2].url, '/api/prices/compare?sku=CASE-IP16PRO-CLEAR-MAG-001&gtin=036000291452');
  await api.listingStatus('LOT 1');
  assert.equal(seen[3].url, '/api/merchant/listing/LOT%201');
});

test('modePill DEGRADED; listingPill DELETED / ERROR / unknown', () => {
  assert.deepEqual(modePill('DEGRADED'), { cls: 'warn', text: 'DEGRADED' });
  assert.deepEqual(listingPill('DELETED'), { cls: 'warn', text: 'DELETED' });
  assert.deepEqual(listingPill('ERROR'), { cls: 'bad', text: 'ERROR' });
  assert.deepEqual(listingPill('PENDING'), { cls: 'blue', text: 'PENDING' });
});

test('fmtCents / fmtBpsPct never print NaN, undefined or unsafe numbers', () => {
  assert.equal(fmtCents(undefined), '—');
  assert.equal(fmtCents(Number.NaN), '—');
  assert.equal(fmtCents(Number.MAX_SAFE_INTEGER + 2), '—');
  assert.equal(fmtCents(Infinity), '—');
  assert.equal(fmtBpsPct(null), '—');
  assert.equal(fmtBpsPct(undefined), '—');
  assert.equal(fmtBpsPct(Number.NaN), '—');
  assert.equal(fmtBpsPct(0), '0.00%');
});

test('apiCall: a 2xx with an unparseable or null JSON body is BAD_RESPONSE, not ok', async () => {
  const bad = await apiCall('/api/x', {}, async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.deepEqual(bad, { ok: false, status: 200, offline: false, error: { code: 'BAD_RESPONSE', message: 'API returned an unreadable response', requestId: null } });
  const nul = await apiCall('/api/x', {}, async () => jsonRes(null));
  assert.equal(nul.ok, false);
  assert.equal(!nul.ok && nul.error.code, 'BAD_RESPONSE');
  assert.equal(!nul.ok && nul.offline, false);
});

test('apiCall: path must start with /api/ (no fetch otherwise)', async () => {
  let called = 0;
  for (const p of ['https://evil.example/api/x', '//evil.example/api/x', '/other', 'api/x']) {
    const r = await apiCall(p, {}, async () => { called++; return jsonRes({}); });
    assert.equal(r.ok, false, p);
    assert.equal(!r.ok && r.offline, false, p);
    assert.equal(!r.ok && r.error.code, 'BAD_REQUEST', p);
  }
  assert.equal(called, 0);
});

test('apiCall: a caller signal is honoured together with the timeout', async () => {
  const ac = new AbortController();
  let seen: AbortSignal | null | undefined;
  await apiCall('/api/x', { signal: ac.signal }, async (_u, init) => { seen = init?.signal; return jsonRes({ a: 1 }); });
  assert.ok(seen);
  assert.equal(seen.aborted, false);
  ac.abort();
  assert.equal(seen.aborted, true);
  const pre = new AbortController();
  pre.abort();
  const r = await apiCall('/api/x', { signal: pre.signal }, async (_u, init) => { if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError'); return jsonRes({}); });
  assert.equal(!r.ok && r.offline, true);
});

test('apiCall path guard: ".." is refused in the path portion only, never in the query string', async () => {
  const seen: string[] = [];
  const f = async (url: string) => { seen.push(url); return jsonRes({ ok: 1 }); };
  for (const bad of ['/api/../x', '/api/a/../b', '/api/..', '/api/%2e%2e/x', '/api/%2E./x', '/api/x..y/../z?q=1']) {
    const r = await apiCall(bad, {}, f);
    assert.equal(r.ok, false, bad);
    assert.equal(!r.ok && r.error.code, 'BAD_REQUEST', bad);
  }
  assert.deepEqual(seen, []);
  const other = await apiCall('/x/api/y', {}, f);
  assert.equal(!other.ok && other.error.code, 'BAD_REQUEST');
  const api = createApi(f);
  const r = await api.compare({ q: 'a..b' });
  assert.deepEqual(r, { ok: true, status: 200, data: { ok: 1 } });
  assert.equal(seen[0], '/api/prices/compare?q=a..b');
  const r2 = await apiCall('/api/prices/compare?q=..%2F..', {}, f);
  assert.equal(r2.ok, true);
  assert.equal(seen[1], '/api/prices/compare?q=..%2F..');
});
