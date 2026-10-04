// Deterministic test offers for sources without credentials. Same input -> same offers on every machine.
// These offers carry mode 'MOCK' (shown to visitors as TEST DATA), are never persisted, never mixed into a REAL spread.
import { mulberry32 } from '../../../../packages/shared/index.ts';
import type { FeedOffer, FeedQuery } from './types.ts';

export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function testOffers(feedId: string, q: FeedQuery, basePriceCents: number, title: string, nowMs: number): FeedOffer[] {
  const rnd = mulberry32(seedOf(feedId + '|' + (q.gtin ?? '') + '|' + q.query.toLowerCase()));
  const observedAt = new Date(nowMs).toISOString();
  const out: FeedOffer[] = [];
  for (let i = 0; i < 3; i++) {
    const swing = Math.floor((rnd() - 0.5) * 0.3 * basePriceCents);
    out.push({
      source: feedId, sourceProductId: 'TEST-' + feedId + '-' + (i + 1), title, priceCents: Math.max(99, basePriceCents + swing), currency: 'USD',
      shipCents: i === 0 ? 0 : 50 * i, url: '', imageUrl: null, seller: 'Test seller ' + (i + 1), gtin: q.gtin,
      condition: 'NEW', observedAt, gtinMatched: q.gtin !== null,
    });
  }
  return out;
}
