// GET /api/market/snapshot: the compact market history the /market page starts from (src/lib/market-snap.ts MarketSnapshot).
// Same-origin API, so no CORS headers. The body is the pre-serialized D1 parts concatenated (assemble.ts snapshotBody, no JSON parse).
//
// Free plan: the only cache is the Workers Cache API (caches.default) with s-maxage, never KV (1000 writes/day). A request is
//   rate limit (RL_READ) -> edge cache hit (0 D1 statements) -> miss: getMeta, then getParts (2 statements max) -> put the 200.
// Only 200s are stored. A 503 is never cached (no-store) and says when to come back (Retry-After).
// CAVEAT: the Workers Cache API is only functional on custom domains; on *.workers.dev cache.match/put may be a no-op. The route then still
// works (2 D1 statements per request, 1 for a 304) and is bounded by RL_READ.
// stale-while-revalidate only matters to downstream proxies: cache.put/match ignore it.
// The ETag is derived from the meta row (schema, cursor, updated_at and the freshness flag), so an If-None-Match costs one statement.
import { getMeta, getParts, type MetaRow } from '../market/repo.ts';
import { isComplete, snapshotBody } from '../market/assemble.ts';
import { HttpError, json, type ErrorCode } from '../http.ts';
import type { AppEnv } from '../env.ts';
import type { Ctx } from '../router.ts';
import { enforceRateLimit, rateKey } from '../security.ts';

export const SNAPSHOT_CACHE_CONTROL = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';
/** Nothing built yet (or another deployment's data): the cron needs a minute or more. */
export const SNAPSHOT_RETRY_AFTER_NOT_BUILT_S = 30;
/** Torn read or body not servable right now: the next cron write or a second request fixes it. */
export const SNAPSHOT_RETRY_AFTER_TORN_S = 5;

const ROUTE = 'GET /api/market/snapshot';
const BASE: Record<string, string> = { 'x-content-type-options': 'nosniff' };

type Identity = { chainId: number; book: string; deployBlock: number };
/** The deployment this Worker serves, from vars only (MARKET_BOOK, MARKET_CHAIN_ID, MARKET_DEPLOY_BLOCK); null when incomplete. */
function marketIdentity(env: AppEnv): Identity | null {
  const book = env.MARKET_BOOK, chainId = Number(env.MARKET_CHAIN_ID), deployBlock = Number(env.MARKET_DEPLOY_BLOCK);
  if (!book || !/^0x[0-9a-fA-F]{40}$/.test(book) || !Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(deployBlock) || deployBlock <= 0) return null;
  return { chainId, book: book.toLowerCase(), deployBlock };
}

function unavailable(c: Ctx, retryAfterS: number, message: string): Response {
  return json({ error: { code: 'SNAPSHOT_UNAVAILABLE' satisfies ErrorCode, message, requestId: c.requestId } }, c.requestId, 503, { 'retry-after': String(retryAfterS) });
}

/** If-None-Match against our tag: list, weak prefix and * all count (weak comparison, RFC 9110 13.1.2). */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => { const v = t.trim(); return v === '*' || v.replace(/^W\//, '') === etag; });
}

function edgeCache(): Cache | null {
  try { return (globalThis as { caches?: CacheStorage }).caches?.default ?? null; } catch { return null; }
}

/** Per-request headers go on a copy: the stored entry is shared by every visitor. */
function serve(c: Ctx, shared: Response): Response {
  const headers = new Headers(shared.headers); headers.set('x-request-id', c.requestId);
  return new Response(shared.status === 304 ? null : shared.body, { status: shared.status, headers });
}
const notModified = (etag: string) => new Response(null, { status: 304, headers: { ...BASE, 'cache-control': SNAPSHOT_CACHE_CONTROL, etag } });

export async function marketSnapshot(c: Ctx): Promise<Response> {
  await enforceRateLimit(c.env.RL_READ, await rateKey(c.req, ROUTE, false));
  const cache = edgeCache();
  // One canonical key: a query string must not bypass the cache and reach D1.
  const key = new Request(c.url.origin + '/api/market/snapshot'); // constant path: '/api/market/snapshot/' and '///' must not create extra entries
  if (cache) {
    let hit: Response | undefined;
    try { hit = await cache.match(key); } catch { hit = undefined; }
    if (hit) {
      c.log.cache = 'hit';
      const etag = hit.headers.get('etag');
      if (etag && etagMatches(c.req.headers.get('if-none-match'), etag)) return serve(c, notModified(etag));
      return serve(c, hit);
    }
  }
  const id = marketIdentity(c.env);
  if (!id) throw new HttpError(503, 'NOT_CONFIGURED', 'the market snapshot is not configured');
  const meta = await getMeta(c.env.DB);
  const nowMs = c.deps.nowMs();
  if (!meta || !meta.schedule_json || meta.head_block === 0 || !sameDeployment(meta, id)) return unavailable(c, SNAPSHOT_RETRY_AFTER_NOT_BUILT_S, 'the market snapshot has not been built yet');
  const etag = `"mk${meta.schema_version}-${meta.next_block - 1}-${meta.updated_at}-${isComplete(meta, nowMs) ? 'c' : 'i'}"`;
  if (etagMatches(c.req.headers.get('if-none-match'), etag)) return serve(c, notModified(etag));
  const body = snapshotBody(meta, await getParts(c.env.DB), nowMs);
  if (body === null) return unavailable(c, SNAPSHOT_RETRY_AFTER_TORN_S, 'the market snapshot is being updated, try again shortly');
  c.log.snapshotBytes = body.length;
  const shared = new Response(body, { status: 200, headers: { ...BASE, 'content-type': 'application/json; charset=utf-8', 'cache-control': SNAPSHOT_CACHE_CONTROL, etag } });
  if (cache) c.exec.waitUntil(cache.put(key, shared.clone()).catch(() => {}));
  return serve(c, shared);
}

function sameDeployment(meta: MetaRow, id: Identity): boolean {
  return meta.chain_id === id.chainId && meta.book.toLowerCase() === id.book && meta.deploy_block === id.deployBlock;
}
