import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleFetch } from '../app.ts';
import { SNAPSHOT_CACHE_CONTROL, SNAPSHOT_RETRY_AFTER_NOT_BUILT_S, SNAPSHOT_RETRY_AFTER_TORN_S } from '../routes/market-snapshot.ts';
import { acquireLease, getMeta } from '../market/repo.ts';
import { validateSnapshot } from '../../src/lib/market-snap.ts';
import { fakeExec, limiter, testDeps } from './helpers/fakes.ts';
import { BOOK, DEPLOY, FX, HEAD, ID, catchUp, harness } from './helpers/market-harness.ts';
import { startFakeRpc } from '../../test/market/helpers/fake-rpc.mjs';

const SITE = 'https://robinize.agent-dong.workers.dev';
const PATH = '/api/market/snapshot';

type H = ReturnType<typeof harness>;
const get = (h: H, nowMs: number, headers: Record<string, string> = {}, extra: { method?: string; query?: string; env?: Record<string, unknown> } = {}) =>
  handleFetch(new Request(SITE + PATH + (extra.query ?? ''), { method: extra.method ?? 'GET', headers }), { ...h.env, ...extra.env } as any, fakeExec() as any, testDeps({ nowMs: () => nowMs }) as any);
const code = async (res: Response) => ((await res.json()) as any).error.code as string;

async function built(fn: (h: H, at: number) => Promise<void>) {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  const h = harness(rpc.url);
  try {
    await catchUp(h);
    const meta = (await getMeta(h.db as any))!;
    h.take();
    await fn(h, meta.updated_at + 1000);
  } finally { await rpc.close(); }
}

// A Workers Cache API double: match/put by URL, records what was stored. Installed on globalThis.caches for one test.
function withFakeCache<T>(fn: (stored: Map<string, Response>, puts: Response[]) => Promise<T>, opts: { failMatch?: boolean; failPut?: boolean } = {}): Promise<T> {
  const stored = new Map<string, Response>(); const puts: Response[] = [];
  const def = {
    async match(req: Request) { if (opts.failMatch) throw new Error('cache down'); const r = stored.get(new URL(req.url).href); return r ? r.clone() : undefined; },
    async put(req: Request, res: Response) { if (opts.failPut) throw new Error('cache down'); puts.push(res.clone()); stored.set(new URL(req.url).href, res.clone()); },
  };
  const g = globalThis as any; const prev = Object.getOwnPropertyDescriptor(g, 'caches');
  Object.defineProperty(g, 'caches', { value: { default: def }, configurable: true, writable: true });
  return fn(stored, puts).finally(() => { if (prev) Object.defineProperty(g, 'caches', prev); else delete g.caches; });
}

test('503 snapshot_unavailable with Retry-After 30 before the ingest ever ran: one statement, never cached', async () => {
  const rpc = await startFakeRpc({ logs: [], head: HEAD }); const h = harness(rpc.url);
  try {
    await withFakeCache(async (_s, puts) => {
      const res = await get(h, h.now());
      assert.equal(res.status, 503);
      assert.equal(await code(res), 'SNAPSHOT_UNAVAILABLE');
      assert.equal(res.headers.get('retry-after'), String(SNAPSHOT_RETRY_AFTER_NOT_BUILT_S));
      assert.equal(SNAPSHOT_RETRY_AFTER_NOT_BUILT_S, 30);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(h.take().statements, 1);
      assert.equal(puts.length, 0);
    });
  } finally { await rpc.close(); }
});

test('a placeholder meta row (lease taken, nothing built) is "not built yet": 503, Retry-After 30', async () => {
  const rpc = await startFakeRpc({ logs: [], head: HEAD }); const h = harness(rpc.url);
  try {
    await acquireLease(h.db as any, { rpc: rpc.url, book: BOOK, chainId: 46630, deployBlock: DEPLOY }, h.now());
    const res = await get(h, h.now());
    assert.equal(res.status, 503); assert.equal(await code(res), 'SNAPSHOT_UNAVAILABLE');
    assert.equal(res.headers.get('retry-after'), '30');
  } finally { await rpc.close(); }
});

test('200: exactly what validateSnapshot accepts for the configured chain/book, public s-maxage, strong ETag, same-origin only, 2 D1 statements', async () => {
  await built(async (h, at) => {
    const res = await get(h, at);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^application\/json/);
    assert.equal(res.headers.get('cache-control'), SNAPSHOT_CACHE_CONTROL);
    assert.match(SNAPSHOT_CACHE_CONTROL, /^public, max-age=0, s-maxage=\d+, stale-while-revalidate=\d+$/);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'same-origin API: no CORS');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('x-request-id'));
    assert.match(res.headers.get('etag')!, /^"mk\d+-\d+-\d+-[ci]"$/, 'strong ETag from meta');
    assert.equal(h.take().statements, 2, 'getMeta + getParts only');
    const text = await res.text();
    const env = h.env;
    const id = { chainId: Number(env.MARKET_CHAIN_ID), book: String(env.MARKET_BOOK), deployBlock: Number(env.MARKET_DEPLOY_BLOCK) };
    assert.deepEqual(id, { chainId: 46630, book: BOOK, deployBlock: DEPLOY }, 'identity comes from the env vars');
    const snap = validateSnapshot(JSON.parse(text), id);
    assert.ok(snap); assert.equal(snap.complete, true); assert.ok(snap.hot.books.length > 0);
    assert.equal(snap.cursor, JSON.parse(text).cursor);
    assert.ok(!/MARKET_RPC|127\.0\.0\.1|localhost/.test(text), 'no RPC url or var name in the body');
  });
});

test('If-None-Match: 304 with no body and one statement; list, weak-prefix and * forms; a different tag gets the body', async () => {
  await built(async (h, at) => {
    const etag = (await get(h, at)).headers.get('etag')!; h.take();
    for (const inm of [etag, `W/${etag}`, `"nope", ${etag}`, '*']) {
      const res = await get(h, at + 500, { 'if-none-match': inm });
      assert.equal(res.status, 304, inm); assert.equal(await res.text(), '');
      assert.equal(res.headers.get('etag'), etag); assert.equal(res.headers.get('cache-control'), SNAPSHOT_CACHE_CONTROL);
      assert.equal(h.take().statements, 1);
    }
    const other = await get(h, at, { 'if-none-match': '"nope"' });
    assert.equal(other.status, 200); assert.ok((await other.text()).length > 1000);
  });
});

test('a snapshot whose cron stopped is flagged incomplete AND gets another ETag, so a 304 can never revalidate a stale "complete"', async () => {
  await built(async (h, at) => {
    const fresh = await get(h, at); const etag = fresh.headers.get('etag')!;
    const late = await get(h, at + 11 * 60_000, { 'if-none-match': etag });
    assert.equal(late.status, 200);
    assert.notEqual(late.headers.get('etag'), etag);
    assert.equal(validateSnapshot(await late.json(), ID)!.complete, false);
  });
});

test('torn read (hot part newer than the meta row) or missing hot part: 503 Retry-After 5, fixed code, never a partial 200, not cacheable', async () => {
  await built(async (h, at) => {
    await withFakeCache(async (_s, puts) => {
      const row = h.db.raw.prepare("SELECT body FROM mk_snapshot WHERE part = 'hot'").get() as { body: string };
      const torn = row.body.replace(/^\{"cur":\d+,/, '{"cur":999999999999,');
      assert.notEqual(torn, row.body, 'the hot part carries a cursor to tear');
      h.db.raw.prepare("UPDATE mk_snapshot SET body = ? WHERE part = 'hot'").run(torn);
      for (const setup of [() => {}, () => h.db.raw.exec("DELETE FROM mk_snapshot WHERE part = 'hot'")]) {
        setup();
        const res = await get(h, at);
        assert.equal(res.status, 503);
        const text = await res.text();
        assert.equal(JSON.parse(text).error.code, 'SNAPSHOT_UNAVAILABLE');
        assert.ok(!text.includes('"hot"') && !text.includes('"cursor"'), 'no snapshot fragments in the error');
        assert.equal(res.headers.get('retry-after'), String(SNAPSHOT_RETRY_AFTER_TORN_S));
        assert.equal(SNAPSHOT_RETRY_AFTER_TORN_S, 5);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      }
      assert.equal(puts.length, 0, 'a 503 is never put in the edge cache');
    });
  });
});

test('a meta row of another deployment than the configured MARKET_* vars is not served; missing vars answer NOT_CONFIGURED', async () => {
  await built(async (h, at) => {
    for (const env of [{ MARKET_BOOK: '0x' + '1'.repeat(40) }, { MARKET_CHAIN_ID: '1' }, { MARKET_DEPLOY_BLOCK: String(DEPLOY + 1) }]) {
      const res = await get(h, at, {}, { env });
      assert.equal(res.status, 503, JSON.stringify(env)); assert.equal(await code(res), 'SNAPSHOT_UNAVAILABLE');
      assert.equal(res.headers.get('retry-after'), '30');
    }
    const none = await get(h, at, {}, { env: { MARKET_BOOK: undefined } });
    assert.equal(none.status, 503); assert.equal(await code(none), 'NOT_CONFIGURED');
  });
});

test('Workers Cache: a miss stores the 200 once (s-maxage), a hit costs no D1 statement, query strings share the key, 304 is answered from the cached ETag', async () => {
  await built(async (h, at) => {
    await withFakeCache(async (stored, puts) => {
      const first = await get(h, at);
      assert.equal(first.status, 200); assert.equal(h.take().statements, 2);
      const body = await first.text();
      assert.equal(puts.length, 1);
      assert.equal(puts[0].status, 200); assert.equal(puts[0].headers.get('cache-control'), SNAPSHOT_CACHE_CONTROL);
      assert.equal(puts[0].headers.get('x-request-id'), null, 'no per-request id inside the shared entry');
      assert.deepEqual([...stored.keys()], [SITE + PATH]);

      const hit = await get(h, at + 5000, {}, { query: '?bust=' + Math.random() });
      assert.equal(hit.status, 200); assert.equal(await hit.text(), body);
      assert.equal(h.take().statements, 0, 'served from the edge cache');
      assert.ok(hit.headers.get('x-request-id') && hit.headers.get('x-request-id') !== first.headers.get('x-request-id'));
      assert.equal(hit.headers.get('cache-control'), SNAPSHOT_CACHE_CONTROL);

      const nm = await get(h, at + 6000, { 'if-none-match': first.headers.get('etag')! });
      assert.equal(nm.status, 304); assert.equal(await nm.text(), ''); assert.equal(h.take().statements, 0);
      assert.equal(puts.length, 1, 'neither a hit nor a 304 writes the cache');
    });
  });
});

test('Workers Cache failures (match or put throwing) never fail the request', async () => {
  await built(async (h, at) => {
    for (const opts of [{ failMatch: true }, { failPut: true }]) {
      await withFakeCache(async () => {
        const res = await get(h, at);
        assert.equal(res.status, 200); assert.ok(validateSnapshot(await res.json(), ID));
      }, opts);
    }
  });
});

test('rate limited by RL_READ (also when the edge cache would answer); HEAD and OPTIONS follow the router: 405 with Allow: GET, no CORS', async () => {
  await built(async (h, at) => {
    const rl = limiter(0);
    const res = await get(h, at, {}, { env: { RL_READ: rl } });
    assert.equal(res.status, 429); assert.equal(await code(res), 'RATE_LIMITED');
    assert.ok(rl.keys[0].startsWith('GET /api/market/snapshot:'));
    assert.equal(h.take().statements, 0, 'limited before any D1 read');
    await withFakeCache(async (stored) => {
      await get(h, at); assert.equal(stored.size, 1);
      assert.equal((await get(h, at, {}, { env: { RL_READ: limiter(0) } })).status, 429);
    });
    for (const method of ['HEAD', 'OPTIONS']) {
      const r = await get(h, at, {}, { method });
      assert.equal(r.status, 405, method); assert.equal(r.headers.get('allow'), 'GET');
      assert.equal(r.headers.get('access-control-allow-origin'), null);
    }
  });
});
