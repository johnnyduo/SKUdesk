import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../http.ts';
import { MERCHANT_SCOPE, base64url, buildJwtClaims, parseServiceAccount, signJwtRS256 } from '../google/jwt.ts';
import { dropGoogleToken, getGoogleAccessToken, tokenCacheKey, tokenTtlSeconds } from '../google/auth.ts';
import { FIXED_NOW_MS, jsonResponse, memKV, scriptedFetch } from './helpers/fakes.ts';
import { b64urlDecode, throwawayServiceAccount } from './helpers/keys.ts';

const dec = new TextDecoder();

test('base64url has no padding or +/ characters', () => {
  assert.equal(base64url('hi?>'), 'aGk_Pg');
  assert.equal(base64url(new Uint8Array([251, 255])), '-_8');
});

test('buildJwtClaims: iss, scope, aud, 1h lifetime', () => {
  const c = buildJwtClaims({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: 'k' }, MERCHANT_SCOPE, 1_790_000_000);
  assert.deepEqual(c, { iss: 'sa@p.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/content', aud: 'https://oauth2.googleapis.com/token', iat: 1_790_000_000, exp: 1_790_003_600 });
});

test('signJwtRS256 round-trip verifies with the public key (throwaway key)', async () => {
  const { saJson, publicKey } = await throwawayServiceAccount();
  const sa = parseServiceAccount(saJson);
  const jwt = await signJwtRS256(buildJwtClaims(sa, MERCHANT_SCOPE, 1000), sa.private_key);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(dec.decode(b64urlDecode(h))), { alg: 'RS256', typ: 'JWT' });
  assert.equal(JSON.parse(dec.decode(b64urlDecode(p))).exp, 4600);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(s), new TextEncoder().encode(h + '.' + p));
  assert.equal(ok, true);
});

test('parseServiceAccount accepts keys with literal \\n escapes and rejects junk', async () => {
  const { pem, publicKey } = await throwawayServiceAccount();
  const escaped = JSON.stringify({ client_email: 'x@y', private_key: pem.replace(/\n/g, '\\n') });
  const sa = parseServiceAccount(escaped);
  assert.ok(sa.private_key.includes('\n'));
  const jwt = await signJwtRS256(buildJwtClaims(sa, MERCHANT_SCOPE, 1), sa.private_key);
  const [h, p, s] = jwt.split('.');
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(s), new TextEncoder().encode(h + '.' + p)), true);
  assert.throws(() => parseServiceAccount(undefined), (e: unknown) => e instanceof HttpError && e.code === 'NOT_CONFIGURED');
  assert.throws(() => parseServiceAccount('{nope'), (e: unknown) => e instanceof HttpError && e.code === 'NOT_CONFIGURED' && !e.message.includes('{nope'));
  assert.throws(() => parseServiceAccount('{"client_email":"a"}'), (e: unknown) => e instanceof HttpError && e.code === 'NOT_CONFIGURED');
});

test('tokenTtlSeconds never goes below the KV minimum of 60', () => {
  assert.equal(tokenTtlSeconds(3599), 3299);
  assert.equal(tokenTtlSeconds(300), 60);
  assert.equal(tokenTtlSeconds(10), 60);
});

test('getGoogleAccessToken exchanges once, then serves from KV; forceRefresh re-exchanges', async () => {
  const { saJson } = await throwawayServiceAccount();
  const kv = memKV(() => FIXED_NOW_MS);
  const net = scriptedFetch([
    () => jsonResponse({ access_token: 'ya29.first', expires_in: 3599, token_type: 'Bearer' }),
    () => jsonResponse({ access_token: 'ya29.second', expires_in: 120, token_type: 'Bearer' }),
  ]);
  const t1 = await getGoogleAccessToken({ saJson, kv, fetch: net.fetch, nowMs: FIXED_NOW_MS });
  const t2 = await getGoogleAccessToken({ saJson, kv, fetch: net.fetch, nowMs: FIXED_NOW_MS });
  assert.equal(t1, 'ya29.first');
  assert.equal(t2, 'ya29.first');
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(net.calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(net.calls[0].body ?? '');
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(form.get('assertion')?.split('.').length, 3);
  assert.equal(kv.puts[0].ttl, 3299);
  const t3 = await getGoogleAccessToken({ saJson, kv, fetch: net.fetch, nowMs: FIXED_NOW_MS, forceRefresh: true });
  assert.equal(t3, 'ya29.second');
  assert.equal(kv.puts[1].ttl, 60);
  const key = await tokenCacheKey('robinize-test@example-project.iam.gserviceaccount.com');
  assert.ok(!key.includes('robinize-test'));
  await dropGoogleToken(kv, saJson);
  assert.equal(await kv.get(key), null);
});

test('getGoogleAccessToken: upstream failure -> MERCHANT_UNAUTHORIZED without echoing the body', async () => {
  const { saJson } = await throwawayServiceAccount();
  const net = scriptedFetch([() => jsonResponse({ error: 'invalid_grant', error_description: 'secret-detail' }, 400)]);
  await assert.rejects(
    getGoogleAccessToken({ saJson, kv: memKV(), fetch: net.fetch, nowMs: FIXED_NOW_MS }),
    (e: unknown) => e instanceof HttpError && e.code === 'MERCHANT_UNAUTHORIZED' && !e.message.includes('secret-detail'),
  );
});

const pubBlock = (label: string, b64: string) => '-----BEGIN ' + label + '-----\n' + b64 + '\n-----END ' + label + '-----\n';

test('malformed SA material -> static 503 NOT_CONFIGURED without key material in the message', async () => {
  const { pem } = await throwawayServiceAccount();
  const body = pem.split('\n').slice(1, -2).join('');
  const sentinelKey = 'SENTINELKEYMATERIAL' + 'A'.repeat(40);
  const keys = [
    pubBlock('RSA PRIVATE KEY', body),
    pubBlock('PRIVATE KEY', '!!!not base64!!!' + sentinelKey),
    pubBlock('PRIVATE KEY', 'QUJDREVGR0g='), // valid base64, not a key
    pubBlock('PRIVATE KEY', body.slice(0, 120)), // truncated key
  ];
  for (const private_key of keys) {
    const saJson = JSON.stringify({ client_email: 'x@y', private_key });
    await assert.rejects(
      getGoogleAccessToken({ saJson, kv: memKV(), fetch: scriptedFetch([]).fetch, nowMs: FIXED_NOW_MS }),
      (e: unknown) => e instanceof HttpError && e.status === 503 && e.code === 'NOT_CONFIGURED' && !e.message.includes('SENTINEL') && !e.message.includes(body.slice(0, 30)),
    );
  }
  for (const raw of ['null', '"str"', '[]', '42']) {
    assert.throws(() => parseServiceAccount(raw), (e: unknown) => e instanceof HttpError && e.code === 'NOT_CONFIGURED', raw);
  }
});

test('token endpoint: fetch error / non-JSON 200 -> static 502 MERCHANT_UPSTREAM', async () => {
  const { saJson } = await throwawayServiceAccount();
  const boom = scriptedFetch([() => { throw new TypeError('connect ECONNREFUSED secret-host'); }]);
  await assert.rejects(
    getGoogleAccessToken({ saJson, kv: memKV(), fetch: boom.fetch, nowMs: FIXED_NOW_MS }),
    (e: unknown) => e instanceof HttpError && e.status === 502 && e.code === 'MERCHANT_UPSTREAM' && !e.message.includes('secret-host'),
  );
  const html = scriptedFetch([() => new Response('<html>SENTINEL-HTML</html>', { status: 200 })]);
  await assert.rejects(
    getGoogleAccessToken({ saJson, kv: memKV(), fetch: html.fetch, nowMs: FIXED_NOW_MS }),
    (e: unknown) => e instanceof HttpError && e.status === 502 && e.code === 'MERCHANT_UPSTREAM' && !e.message.includes('SENTINEL'),
  );
  const nul = scriptedFetch([() => new Response('null', { status: 200 })]);
  await assert.rejects(
    getGoogleAccessToken({ saJson, kv: memKV(), fetch: nul.fetch, nowMs: FIXED_NOW_MS }),
    (e: unknown) => e instanceof HttpError && e.status === 502,
  );
});

test('getGoogleAccessToken: a failing KV put still returns the freshly exchanged token', async () => {
  const { saJson } = await throwawayServiceAccount();
  const kv = memKV(() => FIXED_NOW_MS);
  kv.put = async () => { throw new Error('KV down'); };
  const net = scriptedFetch([() => jsonResponse({ access_token: 'ya29.ok', expires_in: 3599 })]);
  assert.equal(await getGoogleAccessToken({ saJson, kv, fetch: net.fetch, nowMs: FIXED_NOW_MS }), 'ya29.ok');
});
