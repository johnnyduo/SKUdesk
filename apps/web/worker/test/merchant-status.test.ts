import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleFetch } from '../app.ts';
import { missingMerchantSecrets } from '../google/config.ts';
import { baseEnv, fakeExec, jsonResponse, limiter, scriptedFetch, testDeps } from './helpers/fakes.ts';
import { throwawayServiceAccount } from './helpers/keys.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/merchant/' + name, import.meta.url), 'utf8'));
const get = (env: unknown, deps: unknown) => handleFetch(new Request('https://x.test/api/merchant/status'), env as any, fakeExec() as any, deps as any);

test('missingMerchantSecrets lists names only and rejects non-numeric ids', () => {
  assert.deepEqual(missingMerchantSecrets(baseEnv() as any, true), ['GOOGLE_SA_JSON', 'MERCHANT_ACCOUNT_ID', 'MERCHANT_DATA_SOURCE_ID']);
  assert.deepEqual(missingMerchantSecrets(baseEnv({ GOOGLE_SA_JSON: '{}', MERCHANT_ACCOUNT_ID: '123/../x', MERCHANT_DATA_SOURCE_ID: '456' }) as any, true), ['MERCHANT_ACCOUNT_ID']);
  assert.deepEqual(missingMerchantSecrets(baseEnv({ GOOGLE_SA_JSON: '{}', MERCHANT_ACCOUNT_ID: ' 123 ' }) as any, false), []);
});

test('status: no secrets -> 200 MOCK, no network', async () => {
  const res = await get(baseEnv(), testDeps());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { mode: 'MOCK', configured: false, missing: ['GOOGLE_SA_JSON', 'MERCHANT_ACCOUNT_ID'] });
});

const ADMIN = 'a'.repeat(40);
const ACCT = '9876543210';
const asAdmin = (env: unknown, deps: unknown) => handleFetch(new Request('https://x.test/api/merchant/status', { headers: { 'x-admin-token': ADMIN } }), env as any, fakeExec() as any, deps as any);
async function realEnv(over: Record<string, unknown> = {}) {
  const { saJson } = await throwawayServiceAccount();
  return baseEnv({ GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: ACCT, MERCHANT_DATA_SOURCE_ID: '456', ADMIN_TOKEN: ADMIN, ...over });
}
const probeScript = () => [
  () => jsonResponse({ access_token: 'ya29.t', expires_in: 3599 }),
  () => jsonResponse(fx('account-get.json')),
];
// Nothing that identifies the Merchant Center account may appear anywhere in a public body.
function assertNoIdentifiers(text: string) {
  for (const needle of [ACCT, 'Robinize Test Store', 'accounts/', 'dataSources', 'accountId', 'accountName', '"dataSource"']) assert.ok(!text.includes(needle), 'leaked ' + needle + ' in ' + text);
}

test('status: non-admin REAL omits account id, name and data source name (serialized JSON search), then 60 s cache', async () => {
  const env = await realEnv();
  const net = scriptedFetch(probeScript());
  const res = await get(env, testDeps({ fetch: net.fetch }));
  const text = await res.text();
  assertNoIdentifiers(text);
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['checkedAt', 'configured', 'hasDataSource', 'latencyMs', 'mode', 'registered']);
  assert.deepEqual([body.mode, body.configured, body.hasDataSource, body.registered], ['REAL', true, true, true]);
  assert.equal(net.calls[1].url, 'https://merchantapi.googleapis.com/accounts/v1/accounts/' + ACCT);
  assert.equal(net.calls[1].headers.authorization, 'Bearer ya29.t');
  const again = await get(env, testDeps({ fetch: net.fetch }));
  const againText = await again.text();
  assertNoIdentifiers(againText);
  assert.equal(JSON.parse(againText).cached, true);
  assert.equal(net.calls.length, 2);
});

test('status: hasDataSource is false when MERCHANT_DATA_SOURCE_ID is missing', async () => {
  const env = await realEnv({ MERCHANT_DATA_SOURCE_ID: undefined });
  const net = scriptedFetch(probeScript());
  const body = await (await get(env, testDeps({ fetch: net.fetch }))).json() as Record<string, unknown>;
  assert.equal(body.mode, 'REAL');
  assert.equal(body.hasDataSource, false);
});

test('status: admin token reveals accountId, accountName and dataSource', async () => {
  const env = await realEnv();
  const net = scriptedFetch(probeScript());
  const body = await (await asAdmin(env, testDeps({ fetch: net.fetch }))).json() as Record<string, unknown>;
  assert.equal(body.mode, 'REAL');
  assert.equal(body.accountId, ACCT);
  assert.equal(body.accountName, 'Robinize Test Store');
  assert.equal(body.dataSource, 'accounts/' + ACCT + '/dataSources/456');
  assert.equal(body.hasDataSource, true);
});

test('status: a wrong or too-short admin token is a non-admin', async () => {
  const env = await realEnv();
  const net = scriptedFetch(probeScript());
  const bad = await handleFetch(new Request('https://x.test/api/merchant/status', { headers: { 'x-admin-token': 'b'.repeat(40) } }), env as any, fakeExec() as any, testDeps({ fetch: net.fetch }) as any);
  assertNoIdentifiers(await bad.text());
  const short = await realEnv({ ADMIN_TOKEN: 'short' });
  const net2 = scriptedFetch(probeScript());
  const r = await handleFetch(new Request('https://x.test/api/merchant/status', { headers: { 'x-admin-token': 'short' } }), short as any, fakeExec() as any, testDeps({ fetch: net2.fetch }) as any);
  assertNoIdentifiers(await r.text());
});

test('status: the cache cannot cross roles (admin first, then public; public first, then admin)', async () => {
  const env = await realEnv();
  const net = scriptedFetch(probeScript());
  const first = await (await asAdmin(env, testDeps({ fetch: net.fetch }))).json() as Record<string, unknown>;
  assert.equal(first.accountId, ACCT);
  const pub = await get(env, testDeps({ fetch: net.fetch }));
  const pubText = await pub.text();
  assertNoIdentifiers(pubText);
  assert.equal(JSON.parse(pubText).cached, true);
  assert.equal(net.calls.length, 2);

  const env2 = await realEnv();
  const net2 = scriptedFetch(probeScript());
  assertNoIdentifiers(await (await get(env2, testDeps({ fetch: net2.fetch }))).text());
  const adm = await (await asAdmin(env2, testDeps({ fetch: net2.fetch }))).json() as Record<string, unknown>;
  assert.equal(adm.accountId, ACCT);
  assert.equal(adm.cached, true);
  assert.equal(net2.calls.length, 2);
});

test('status: an admin-shaped body found in the shared cache entry is never served to a non-admin', async () => {
  const env = await realEnv() as any;
  const adminShaped = JSON.stringify({ mode: 'REAL', configured: true, accountId: ACCT, accountName: 'Robinize Test Store', dataSource: 'accounts/' + ACCT + '/dataSources/456', registered: true, latencyMs: 5, checkedAt: 'x' });
  for (const k of ['mstatus:v1', 'mstatus:v2']) await env.CACHE.put(k, adminShaped, { expirationTtl: 60 });
  const text = await (await get(env, testDeps())).text();
  assertNoIdentifiers(text);
});

test('status: rate-limit key uses the verified admin boolean (a bogus token is keyed by IP)', async () => {
  const rl = limiter();
  const env = await realEnv({ RL_READ: rl });
  await asAdmin(env, testDeps({ fetch: scriptedFetch(probeScript()).fetch }));
  assert.match(rl.keys[0], /^GET \/api\/merchant\/status:adm:/);
  await handleFetch(new Request('https://x.test/api/merchant/status', { headers: { 'x-admin-token': 'z'.repeat(40) } }), env as any, fakeExec() as any, testDeps() as any);
  assert.match(rl.keys[1], /^GET \/api\/merchant\/status:ip:/);
});

test('status: unregistered project -> 200 DEGRADED with hint, never the upstream body', async () => {
  const { saJson } = await throwawayServiceAccount();
  const env = baseEnv({ GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: '123' });
  const net = scriptedFetch([
    () => jsonResponse({ access_token: 'ya29.t', expires_in: 3599 }),
    () => jsonResponse(fx('error-not-registered.json'), 401),
  ]);
  const res = await get(env, testDeps({ fetch: net.fetch }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('000000000000'));
  const body = JSON.parse(text);
  assert.equal(body.mode, 'DEGRADED');
  assert.equal(body.registered, false);
  assert.equal(body.error.code, 'MERCHANT_NOT_REGISTERED');
});

test('status: RL_READ refusal -> 429', async () => {
  const res = await get(baseEnv({ RL_READ: limiter(0) }), testDeps());
  assert.equal(res.status, 429);
});

test('status: a failing KV put (token and status cache) still answers REAL', async () => {
  const { saJson } = await throwawayServiceAccount();
  const env = baseEnv({ GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: '123' }) as any;
  env.CACHE.put = async () => { throw new Error('KV down'); };
  const net = scriptedFetch([
    () => jsonResponse({ access_token: 'ya29.t', expires_in: 3599 }),
    () => jsonResponse(fx('account-get.json')),
  ]);
  const res = await get(env, testDeps({ fetch: net.fetch }));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Record<string, unknown>).mode, 'REAL');
});

test('status: DEGRADED logs code + error name only (no message)', async () => {
  const { saJson } = await throwawayServiceAccount();
  const env = baseEnv({ GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: '123' });
  const net = scriptedFetch([
    () => jsonResponse({ access_token: 'ya29.t', expires_in: 3599 }),
    () => jsonResponse({ error: { message: 'SENTINEL-UPSTREAM' } }, 403),
  ]);
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { await get(env, testDeps({ fetch: net.fetch })); } finally { console.log = orig; }
  const l = lines.map((x) => JSON.parse(x)).find((x) => x.event === 'merchant_status_error');
  assert.deepEqual([l.code, l.name], ['MERCHANT_UNAUTHORIZED', 'HttpError']);
  assert.ok(!lines.join('\n').includes('SENTINEL'));
});
