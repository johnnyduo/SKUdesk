// Pure helpers for the /market terminal (no React): where the price line must break, per-metric stats, and the "bots paused" test.
import type { ClearPoint, Schedule } from './market.ts';
import { rangeStats } from './market-core.ts';
import { fmtUsdCents } from './market-fmt.ts';

/** Split an epoch-ordered series into runs of consecutive epochs. An epoch with no trade in between means nothing was priced there, so the line must not cross it. */
export function splitAtGaps<T extends { epoch: number }>(items: T[]): T[][] {
  const runs: T[][] = [];
  for (const it of items) {
    const run = runs[runs.length - 1];
    if (run && it.epoch - run[run.length - 1].epoch === 1) run.push(it); else runs.push([it]);
  }
  return runs;
}

/** A stretch with no trade that the chart bridges with a dotted flat line at the last cleared price. Pure presentation: nothing here is data,
 *  and it never feeds a stat. `fromEpoch`..`toEpoch` are the epochs with no trade in between (inclusive), `missing` how many; `t0`/`t1` are unix
 *  seconds (the last real point, and the next real point or "now"); `toNow` marks the trailing stretch after the newest trade. */
export type CarrySegment = { fromEpoch: number; toEpoch: number; missing: number; t0: number; t1: number; price: number; toNow: boolean };
/** A hole is bridged only when MORE than this many epochs (3 x 45 s = 2 min 15 s) lie between two trades. Shorter holes stay a plain break in the line. */
export const CARRY_MIN_GAP = 3;
const EPOCH_SEC = 45;
const HOUR_SEC = 3600;   // = market-snap BUCKET_SEC: an aggregated point stands for the hour its time falls in

/** Gaps between consecutive trades (and from the newest trade to `nowEpoch`, the live epoch, when given) longer than `minGap` epochs.
 *  Only epochs that traded (volume > 0) count as real points. An hourly aggregate (n > 1) spans its whole hour: a carry INTO it ends where
 *  the hour starts (so the line never overlaps the aggregate), a carry OUT of it starts at its last epoch; consecutive aggregates have no gap. */
export function carrySegments(points: ClearPoint[], nowEpoch: number | undefined, minGap: number): CarrySegment[] {
  const real = points.filter((p) => p.volume > 0);
  const out: CarrySegment[] = [];
  const startOf = (p: ClearPoint) => (p.n ?? 1) > 1 ? Math.min(p.time, Math.floor(p.time / HOUR_SEC) * HOUR_SEC) : p.time;
  const firstEpoch = (p: ClearPoint) => (p.n ?? 1) > 1 ? p.epoch - Math.round((p.time - startOf(p)) / EPOCH_SEC) : p.epoch;
  for (let i = 1; i < real.length; i++) {
    const a = real[i - 1], b = real[i]; const missing = firstEpoch(b) - a.epoch - 1; const t1 = startOf(b);
    if (missing > minGap && t1 > a.time) out.push({ fromEpoch: a.epoch + 1, toEpoch: firstEpoch(b) - 1, missing, t0: a.time, t1, price: a.price, toNow: false });
  }
  const z = real[real.length - 1];
  if (z && nowEpoch !== undefined && nowEpoch - z.epoch - 1 > minGap) out.push({ fromEpoch: z.epoch + 1, toEpoch: nowEpoch - 1, missing: nowEpoch - z.epoch - 1, t0: z.time, t1: z.time + (nowEpoch - z.epoch) * EPOCH_SEC, price: z.price, toNow: true });
  return out;
}
/** "14 min", "3.5 h", "12 h": the length of `missing` epochs, rounded (it is "about"). */
export function gapDuration(missing: number): string {
  const min = (missing * EPOCH_SEC) / 60;
  if (min < 120) return `${Math.max(1, Math.round(min))} min`;
  const h = min / 60; return h < 10 ? `${(Math.round(h * 10) / 10).toFixed(1)} h` : `${Math.round(h)} h`;
}
/** The hover text inside a carried stretch. The price goes through the one shared dollar formatter. */
export const gapTipText = (g: CarrySegment): string =>
  `No trades from epoch ${g.fromEpoch} to ${g.toNow ? 'now' : g.toEpoch} (about ${gapDuration(g.missing)}). Last price ${fmtUsdCents(g.price)} carried.`;

/** SVG path for a run of points: one M then L segments. Single-point runs return '' (they are drawn as dots). */
export function linePathOf(run: { x: number; y: number }[]): string {
  return run.length < 2 ? '' : run.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
}

/** How far outside the traded range (as a fraction of the low/high) the catalog reference may sit and still be drawn inside the y-range. */
export const REF_SPAN = 0.3;
/** The chart's price range: the traded low/high, widened to include the catalog reference only when it lies within data +-30%
 *  (integer maths: a far-away reference would flatten small moves, so it is then left off the scale). Prices are integer cents. */
export function priceRange(lo: number, hi: number, ref: number): { lo: number; hi: number } {
  if (!(ref > 0) || ref * 10 < lo * 7 || ref * 10 > hi * 13) return { lo, hi };
  return { lo: Math.min(lo, ref), hi: Math.max(hi, ref) };
}

/** highN / lowN: set only when the extreme lies inside an aggregated (hourly) point, = the number of epochs that point stands for. */
export type TradeStats = { n: number; high: number; highEpoch: number; low: number; lowEpoch: number; volume: number; highN?: number; lowN?: number };
/** High, low, volume and count over the epochs that traded (volume > 0). Each metric carries its own value. The values come from
 *  market-core rangeStats, so an aggregated (hourly) point counts by its n and its own high and low; its epoch is the last one it covers. */
export function tradeStats(clears: ClearPoint[]): TradeStats {
  const r = rangeStats(clears);
  const s: TradeStats = { n: r.trades, high: r.high, highEpoch: -1, low: r.low, lowEpoch: -1, volume: r.volume };
  for (const c of clears) {
    if (c.volume <= 0) continue; const k = c.n ?? 1;
    if (s.highEpoch < 0 && (c.high ?? c.price) === r.high) { s.highEpoch = c.epoch; if (k > 1) s.highN = k; }
    if (s.lowEpoch < 0 && (c.low ?? c.price) === r.low) { s.lowEpoch = c.epoch; if (k > 1) s.lowN = k; }
  }
  return s;
}
/** How many epochs a list of clearing points stands for (an aggregated hourly point counts its n). */
export const epochCount = (points: ClearPoint[]) => points.reduce((a, c) => a + (c.n ?? 1), 0);

/** Epochs between the newest cleared epoch (any market) and the live one before we call the bots paused (8 x 45 s = 6 minutes). */
export const PAUSED_AFTER_EPOCHS = 8;
export type BotStatus = { paused: boolean; lastClearEpoch: number; lastTradeEpoch: number; clearAgeSec: number; tradeAgeSec: number; epochsBehind: number };
/** `chainNow` is unix seconds on the chain clock. Returns undefined until there is a schedule and at least one cleared epoch. */
export function botStatus(clears: Record<string, ClearPoint[]>, sched: Schedule | undefined, liveEpoch: number | undefined, chainNow: number): BotStatus | undefined {
  if (!sched || liveEpoch === undefined) return undefined;
  let lastClear = -1, lastTrade = -1;
  for (const list of Object.values(clears)) for (const c of list) { if (c.epoch > lastClear) lastClear = c.epoch; if (c.volume > 0 && c.epoch > lastTrade) lastTrade = c.epoch; }
  if (lastClear < 0) return undefined;
  const at = (e: number) => sched.t0 + e * sched.epochLen + sched.revealEnd;
  const age = (e: number) => (e < 0 ? 0 : Math.max(0, Math.round(chainNow - at(e))));
  const epochsBehind = liveEpoch - lastClear;
  return { paused: epochsBehind >= PAUSED_AFTER_EPOCHS, lastClearEpoch: lastClear, lastTradeEpoch: lastTrade, clearAgeSec: age(lastClear), tradeAgeSec: age(lastTrade), epochsBehind };
}

/** "3 minutes", "1 minute", "2 hours", "5 days"; under a minute gives seconds. */
export function agoText(sec: number): string {
  const n = (v: number, u: string) => `${v} ${u}${v === 1 ? '' : 's'}`;
  if (sec < 60) return n(Math.max(0, Math.round(sec)), 'second');
  if (sec < 3600) return n(Math.floor(sec / 60), 'minute');
  if (sec < 86400) return n(Math.floor(sec / 3600), 'hour');
  return n(Math.floor(sec / 86400), 'day');
}
