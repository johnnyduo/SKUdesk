// Where the market history comes from on page load: the Worker snapshot, the IndexedDB cache, or (neither) the chain itself.
// chooseBase is the single rule that keeps a stale or partial snapshot from ever being shown as current.
import { validateSnapshot, type MarketSnapshot, type SnapshotIdentity } from './market-snap.ts';

export const SNAPSHOT_URL = '/api/market/snapshot';
export const SNAPSHOT_TIMEOUT_MS = 2500;
/** A server snapshot further than this behind the chain head is not used (~50 min of blocks; the gap would be 4+ log requests). */
export const MAX_SNAPSHOT_GAP = 20_000;
/** The browser's RPC node may trail the Worker's by a few blocks; a cursor this far ahead of our head still counts as caught up. */
export const AHEAD_TOLERANCE = 64;
export const MAX_SNAPSHOT_BYTES = 5_000_000;
/** 'baked' = the history built into the page at build time (src/data/blindbook-history.json via market-baked.ts), the cold fallback. */
export type DataSource = 'snapshot' | 'cache' | 'baked' | 'rpc';
export type Base = { snap: MarketSnapshot; source: 'snapshot' | 'cache' | 'baked' };

/** Reads the body as text but gives up (null) as soon as it exceeds `max` bytes, so an oversized or endless response is never buffered whole. */
async function readBounded(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
  if (!res.body) { const t = await res.text(); return t.length > max ? null : t; }
  const reader = res.body.getReader(); const parts: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    parts.push(value);
  }
  const all = new Uint8Array(total); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * GET the snapshot with a hard timeout (covering the body read too, and enforced even if fetchFn ignores the abort signal).
 * Never throws; null on any failure: offline Worker, static host (404/HTML), 304, timeout, oversize, invalid or another deployment.
 */
export async function fetchSnapshot(fetchFn: typeof fetch, url: string, id: SnapshotIdentity, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<MarketSnapshot | null> {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SNAPSHOT_TIMEOUT_MS;
  const ctl = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => { try { ctl.abort(); } catch { /* ignore */ } resolve(null); }, ms); });
  const work = (async (): Promise<MarketSnapshot | null> => {
    try {
      const res = await fetchFn(url, { signal: ctl.signal, headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
      const text = await readBounded(res, MAX_SNAPSHOT_BYTES);
      if (text === null) return null;
      return validateSnapshot(JSON.parse(text), id);
    } catch { return null; }
  })();
  try { return await Promise.race([work, deadline]); } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * Picks the history base. The server snapshot counts only when it says it is complete and is within MAX_SNAPSHOT_GAP blocks of
 * the head; the cache and the baked build-time history (market-baked.ts) only when complete, at any gap (it loads newest-first). None may
 * claim blocks beyond head + AHEAD_TOLERANCE. The newest acceptable cursor wins; on a tie the order is server snapshot, then cache, then
 * baked (the baked file is the cold fallback: it only wins when it is strictly newer). null means: load from the chain.
 * Candidates are judged by their own cursor/complete, never by when they were saved or fetched. The schedule stays on the returned
 * snapshot: comparing it with the on-chain schedule is the store's job.
 */
export function chooseBase(head: number, server: MarketSnapshot | null, cached: MarketSnapshot | null, baked: MarketSnapshot | null = null): Base | null {
  if (!Number.isSafeInteger(head) || head < 0) return null;
  const fits = (s: MarketSnapshot | null, maxGap: number) => !!s && s.complete && s.cursor <= head + AHEAD_TOLERANCE && head - s.cursor <= maxGap;
  const all: Array<Base | null> = [
    fits(server, MAX_SNAPSHOT_GAP) ? { snap: server!, source: 'snapshot' } : null,
    fits(cached, Number.MAX_SAFE_INTEGER) ? { snap: cached!, source: 'cache' } : null,
    fits(baked, Number.MAX_SAFE_INTEGER) ? { snap: baked!, source: 'baked' } : null,
  ];
  let best: Base | null = null;
  for (const c of all) if (c && (!best || c.snap.cursor > best.snap.cursor)) best = c; // strictly newer only: earlier entries win ties
  return best;
}
