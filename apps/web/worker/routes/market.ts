// On-demand market bots. The BlindBook keeper runs on the developer's machine and costs testnet ETH for every epoch it trades.
// Instead of running on a schedule it asks this route whether anyone is looking at /market:
//   POST /api/market/ping   the /market page calls it on load (and about every 2 minutes while it stays open)
//   GET  /api/market/active { active, ageSeconds }: true while the last ping is younger than ACTIVE_WINDOW_S
// Only a timestamp is stored. No visitor data is kept, and no secret or key is involved.
import type { Ctx } from '../router.ts';
import { HttpError, json } from '../http.ts';
import { assertOrigin, enforceRateLimit, rateKey } from '../security.ts';

export const SEEN_KEY = 'market:last-seen';
export const ACTIVE_WINDOW_S = 600;   // bots keep trading for 10 minutes after the last visitor ping
const KV_TTL_SECONDS = 3600;          // KV needs expirationTtl >= 60
const REFRESH_MS = 300_000;           // at most one KV write per 5 minutes (the active window is 10, so a page that stays open never lapses): <= 288 writes a day
const FUTURE_SLACK_MS = 60_000;       // a timestamp from the future is not a visit

export async function marketPing(c: Ctx): Promise<Response> {
  assertOrigin(c.req, c.env.PUBLIC_SITE_ORIGIN);
  // a browser always sends Origin on a POST; a script that leaves it out must not be able to keep the bots (and their ETH spend) alive
  if (!c.req.headers.get('origin')) throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'origin required');
  await enforceRateLimit(c.env.RL_WRITE, await rateKey(c.req, 'POST /api/market/ping', false));
  const now = c.deps.nowMs();
  // KV allows ~1,000 writes a day on the free plan and the namespace is shared with the price cache: write at most once a minute
  try {
    const prev = Number(await c.env.CACHE.get(SEEN_KEY));
    if (!Number.isFinite(prev) || now - prev >= REFRESH_MS || prev > now) await c.env.CACHE.put(SEEN_KEY, String(now), { expirationTtl: KV_TTL_SECONDS });
  } catch { /* a storage hiccup must not fail the page: the next ping retries */ }
  return json({ ok: true, activeForSeconds: ACTIVE_WINDOW_S }, c.requestId);
}

export async function marketActive(c: Ctx): Promise<Response> {
  await enforceRateLimit(c.env.RL_READ, await rateKey(c.req, 'GET /api/market/active', false));
  const raw = await c.env.CACHE.get(SEEN_KEY);
  const seen = raw === null ? NaN : Number(raw);
  const nowMs = c.deps.nowMs();
  const ageSeconds = Number.isFinite(seen) && seen <= nowMs + FUTURE_SLACK_MS ? Math.max(0, Math.round((nowMs - seen) / 1000)) : null;
  return json({ active: ageSeconds !== null && ageSeconds <= ACTIVE_WINDOW_S, ageSeconds, windowSeconds: ACTIVE_WINDOW_S }, c.requestId);
}
