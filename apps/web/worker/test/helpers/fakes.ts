// Test doubles for Worker bindings. Plain objects; tests cast them with `as any` where a binding type is expected.
export type FakeKV = {
  store: Map<string, { value: string; expiresAtMs: number | null }>;
  puts: Array<{ key: string; ttl: number | undefined }>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export function memKV(clock: () => number = () => Date.now()): FakeKV {
  const store = new Map<string, { value: string; expiresAtMs: number | null }>();
  const puts: Array<{ key: string; ttl: number | undefined }> = [];
  return {
    store,
    puts,
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAtMs !== null && hit.expiresAtMs <= clock()) { store.delete(key); return null; }
      return hit.value;
    },
    async put(key, value, opts) {
      const ttl = opts?.expirationTtl;
      if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60)) throw new Error('KV expirationTtl must be an integer >= 60');
      puts.push({ key, ttl });
      store.set(key, { value, expiresAtMs: ttl === undefined ? null : clock() + ttl * 1000 });
    },
    async delete(key) { store.delete(key); },
  };
}

export type FakeLimiter = { keys: string[]; limit(opts: { key: string }): Promise<{ success: boolean }> };
export function limiter(allowed = Number.POSITIVE_INFINITY): FakeLimiter {
  const keys: string[] = [];
  return {
    keys,
    async limit(opts) { keys.push(opts.key); return { success: keys.length <= allowed }; },
  };
}

export function fakeExec(): { waits: Promise<unknown>[]; waitUntil(p: Promise<unknown>): void; passThroughOnException(): void } {
  const waits: Promise<unknown>[] = [];
  return { waits, waitUntil(p) { waits.push(p); }, passThroughOnException() {} };
}

export function fakeAssets(files: Record<string, string>): { fetch(req: Request | string): Promise<Response> } {
  return {
    async fetch(req) {
      const url = new URL(typeof req === 'string' ? req : req.url);
      const body = files[url.pathname];
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
    },
  };
}

export const FIXED_NOW_MS = Date.UTC(2026, 9, 2, 12, 0, 0);

export function testDeps(over: Record<string, unknown> = {}) {
  return {
    fetch: async (): Promise<Response> => { throw new Error('unexpected network call'); },
    nowMs: () => FIXED_NOW_MS,
    sleep: async (_ms: number) => {},
    random: () => 0,
    ...over,
  };
}

export function baseEnv(over: Record<string, unknown> = {}) {
  return {
    ASSETS: fakeAssets({ '/index.html': '<h1>home</h1>' }),
    CACHE: memKV(() => FIXED_NOW_MS),
    RL_READ: limiter(),
    RL_WRITE: limiter(),
    RL_COMPARE: limiter(),
    MERCHANT_API_BASE: 'https://merchantapi.googleapis.com',
    MERCHANT_FEED_LABEL: 'US',
    MERCHANT_LANGUAGE: 'en',
    MERCHANT_COUNTRY: 'US',
    MERCHANT_CURRENCY: 'USD',
    PUBLIC_SITE_ORIGIN: 'https://robinize.agent-dong.workers.dev',
    ...over,
  };
}

export type Recorded = { url: string; method: string; headers: Record<string, string>; body: string | null };
export type Scripted = (call: Recorded) => Response | Promise<Response>;

export function scriptedFetch(script: Scripted[]) {
  const calls: Recorded[] = [];
  const queue = [...script];
  const fetchFn = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const rec: Recorded = {
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.text(),
    };
    calls.push(rec);
    const next = queue.shift();
    if (!next) throw new Error('no scripted response for ' + rec.method + ' ' + rec.url);
    return next(rec);
  };
  return { fetch: fetchFn, calls };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
