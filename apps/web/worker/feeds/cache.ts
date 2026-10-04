// KV response cache per source+query. Fresh for 10 min; kept until the source's terms-driven max stale age
// so a quota stop or upstream failure can fall back to a labeled STALE copy.
import { sha256Hex } from '../security.ts';
import type { FeedOffer, FeedQuery } from './types.ts';

export const FRESH_MS = 10 * 60 * 1000;
export type CachedFeed = { fetchedAtMs: number; offers: FeedOffer[] };
export type CacheKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

export async function feedCacheKey(feedId: string, q: FeedQuery): Promise<string> {
  const material = (q.gtin ?? '') + '|' + q.query.trim().toLowerCase() + '|' + q.country;
  return 'feed:v1:' + feedId + ':' + (await sha256Hex(material)).slice(0, 32);
}

export async function readFeedCache(kv: CacheKV, key: string): Promise<CachedFeed | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as CachedFeed;
    return typeof v.fetchedAtMs === 'number' && Array.isArray(v.offers) ? v : null;
  } catch {
    return null;
  }
}

export async function writeFeedCache(kv: CacheKV, key: string, value: CachedFeed, maxStaleMs: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.ceil(maxStaleMs / 1000)) });
}
