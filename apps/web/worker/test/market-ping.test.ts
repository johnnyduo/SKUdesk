import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleFetch } from '../app.ts';
import { ACTIVE_WINDOW_S, SEEN_KEY } from '../routes/market.ts';
import { FIXED_NOW_MS, baseEnv, fakeExec, limiter, memKV, testDeps } from './helpers/fakes.ts';

const ORIGIN = 'https://robinize.agent-dong.workers.dev';
const call = (env: any, deps: any, path: string, method: string, headers: Record<string, string> = {}) =>
  handleFetch(new Request(ORIGIN + path, { method, headers }), env, fakeExec() as any, deps);

test('nobody has looked yet: the bots are not active', async () => {
  const res = await call(baseEnv(), testDeps(), '/api/market/active', 'GET');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { active: false, ageSeconds: null, windowSeconds: ACTIVE_WINDOW_S });
});

test('a page ping makes the bots active for the window, then they go idle again', async () => {
  const kv = memKV(() => FIXED_NOW_MS); const env = baseEnv({ CACHE: kv });
  const ping = await call(env, testDeps(), '/api/market/ping', 'POST', { origin: ORIGIN });
  assert.equal(ping.status, 200);
  assert.equal(kv.puts[0].key, SEEN_KEY);
  assert.equal(await kv.get(SEEN_KEY), String(FIXED_NOW_MS));
  const soon = await (await call(env, testDeps({ nowMs: () => FIXED_NOW_MS + 30_000 }), '/api/market/active', 'GET')).json();
  assert.equal(soon.active, true); assert.equal(soon.ageSeconds, 30);
  const edge = await (await call(env, testDeps({ nowMs: () => FIXED_NOW_MS + ACTIVE_WINDOW_S * 1000 }), '/api/market/active', 'GET')).json();
  assert.equal(edge.active, true);
  const late = await (await call(env, testDeps({ nowMs: () => FIXED_NOW_MS + (ACTIVE_WINDOW_S + 1) * 1000 }), '/api/market/active', 'GET')).json();
  assert.equal(late.active, false);
});

test('a ping from another website is refused and stores nothing', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const res = await call(baseEnv({ CACHE: kv }), testDeps(), '/api/market/ping', 'POST', { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(kv.puts.length, 0);
});

test('pings are rate limited', async () => {
  const kv = memKV(() => FIXED_NOW_MS); const env = baseEnv({ CACHE: kv, RL_WRITE: limiter(1) });
  assert.equal((await call(env, testDeps(), '/api/market/ping', 'POST', { origin: ORIGIN })).status, 200);
  assert.equal((await call(env, testDeps(), '/api/market/ping', 'POST', { origin: ORIGIN })).status, 429);
});

test('a ping without an Origin header is refused (scripts cannot keep the bots alive)', async () => {
  const kv = memKV(() => FIXED_NOW_MS);
  const res = await call(baseEnv({ CACHE: kv }), testDeps(), '/api/market/ping', 'POST');
  assert.equal(res.status, 403); assert.equal(kv.puts.length, 0);
});

test('pings within 5 minutes do not write again (KV write budget)', async () => {
  const kv = memKV(() => FIXED_NOW_MS); const env = baseEnv({ CACHE: kv });
  await call(env, testDeps(), '/api/market/ping', 'POST', { origin: ORIGIN });
  await call(env, testDeps({ nowMs: () => FIXED_NOW_MS + 240_000 }), '/api/market/ping', 'POST', { origin: ORIGIN });
  assert.equal(kv.puts.length, 1);
  await call(env, testDeps({ nowMs: () => FIXED_NOW_MS + 301_000 }), '/api/market/ping', 'POST', { origin: ORIGIN });
  assert.equal(kv.puts.length, 2);
  assert.equal(kv.puts[0].ttl, 3600);
});

test('a malformed or future timestamp never counts as a visit', async () => {
  for (const bad of ['garbage', String(FIXED_NOW_MS + 3_600_000)]) {
    const kv = memKV(() => FIXED_NOW_MS); await kv.put(SEEN_KEY, bad, { expirationTtl: 3600 });
    const body = await (await call(baseEnv({ CACHE: kv }), testDeps(), '/api/market/active', 'GET')).json();
    assert.equal(body.active, false, bad);
  }
});

test('a storage failure does not fail the ping', async () => {
  const broken = { async get() { throw new Error('kv down'); }, async put() { throw new Error('kv down'); } };
  const res = await call(baseEnv({ CACHE: broken }), testDeps(), '/api/market/ping', 'POST', { origin: ORIGIN });
  assert.equal(res.status, 200);
});

test('reads are rate limited too', async () => {
  const env = baseEnv({ RL_READ: limiter(1) });
  assert.equal((await call(env, testDeps(), '/api/market/active', 'GET')).status, 200);
  assert.equal((await call(env, testDeps(), '/api/market/active', 'GET')).status, 429);
});
