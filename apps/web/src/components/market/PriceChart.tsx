// Price chart: hand-rolled SVG, no chart library. One point per cleared epoch (line/area) or OHLC candles by time bucket.
// Prices are integer cents; times are unix seconds drawn in the viewer's local time.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMarket, useSelectedMarket, useClock } from '../../lib/market-app';
import type { ClearPoint } from '../../lib/market';
import { splitAtGaps, linePathOf, epochCount, priceRange, carrySegments, gapTipText, CARRY_MIN_GAP, type CarrySegment } from '../../lib/market-chart';
import { usd, hhmm, hhmmss, dmon, lc, int, useReducedMotion } from './mk-fmt';
import BotStatus from './BotStatus';
import Provenance from '../ui/Provenance';
import { dataSource, loadFailed, PRICE_SCOPE } from '../../lib/market-view';

type Mode = 'line' | 'candles';
type TF = 300 | 900 | 3600;
type View = { x0: number; x1: number; y0: number; y1: number };
type Item = { t: number; w: number; x: number; o: number; h: number; l: number; c: number; vol: number; n: number; epoch: number; first: number; last: number; buys: number; sells: number; up: boolean };
const TFS: [string, TF][] = [['5m', 300], ['15m', 900], ['1h', 3600]];
const EPOCH_S = 45;
const M = { l: 6, r: 78, t: 10, b: 24 };
const GAP_EDGE_PX = 12;   // within this many px of a carried stretch's end the hover still snaps to the real point there

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null); const [s, setS] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const f = () => { const r = el.getBoundingClientRect(); setS((o) => (Math.abs(o.w - r.width) < 0.5 && Math.abs(o.h - r.height) < 0.5 ? o : { w: r.width, h: r.height })); };
    f(); const ro = new ResizeObserver(f); ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, s] as const;
}

// Eases the visible window (time and price range) toward its target, so a new epoch slides in instead of jumping.
function useTween(target: View | null, resetKey: string, animate: boolean): View | null {
  const [v, setV] = useState<View | null>(target); const cur = useRef<View | null>(target); const key = useRef(resetKey); const raf = useRef(0);
  const tx0 = target?.x0, tx1 = target?.x1, ty0 = target?.y0, ty1 = target?.y1;
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (!target) { cur.current = null; setV(null); return; }
    if (!cur.current || key.current !== resetKey || !animate) { key.current = resetKey; cur.current = target; setV(target); return; }
    const from = cur.current; const t0 = performance.now(); const D = 520;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / D); const e = 1 - Math.pow(1 - p, 3); const L = (a: number, b: number) => a + (b - a) * e;
      const nv = { x0: L(from.x0, target.x0), x1: L(from.x1, target.x1), y0: L(from.y0, target.y0), y1: L(from.y1, target.y1) };
      cur.current = nv; setV(nv); if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step); return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx0, tx1, ty0, ty1, resetKey, animate]);
  return v ?? target;
}

function niceStep(raw: number, steps: number[]) { return steps.find((s) => s >= raw) ?? steps[steps.length - 1]; }
function priceTicks(y0: number, y1: number, h: number) {
  const n = Math.max(2, Math.floor(h / 48)); const raw = (y1 - y0) / n; const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9)))); const m = raw / pow;
  const step = Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow); const out: number[] = [];
  for (let p = Math.ceil(y0 / step) * step; p <= y1; p += step) out.push(p); return out;
}
function timeTicks(x0: number, x1: number, w: number) {
  const target = Math.max(2, Math.floor(w / 92)); const step = niceStep((x1 - x0) / target, [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]);
  const off = -new Date(x0 * 1000).getTimezoneOffset() * 60; const out: number[] = [];
  for (let t = Math.ceil((x0 + off) / step) * step - off; t <= x1; t += step) out.push(t); return { ticks: out, step };
}

/** The dotted flat stretches that bridge a hole with no trades (drawn behind everything, purely presentational: no markers, not part of the
 *  data points or the stats). Exported for tests. */
export function CarryLines({ segs, X, Y }: { segs: CarrySegment[]; X: (t: number) => number; Y: (p: number) => number }) {
  return <g className="mk-carry" aria-hidden="true">{segs.map((g) => <line key={g.fromEpoch} className="mk-gap" data-testid="chart-gap" data-from={g.fromEpoch} data-to={g.toNow ? 'now' : g.toEpoch} x1={X(g.t0)} x2={X(g.t1)} y1={Y(g.price)} y2={Y(g.price)} />)}</g>;
}

/** Exported for tests. Aggregated (hourly) points keep their n, high and low in lines and candles. */
export function toItems(trades: ClearPoint[], mode: Mode, tf: TF): Item[] {
  if (mode === 'line') {
    return trades.map((p, i) => ({ t: p.time, w: 0, x: p.time, o: p.price, h: p.high ?? p.price, l: p.low ?? p.price, c: p.price, vol: p.volume, n: p.n ?? 1, epoch: p.epoch, first: p.epoch, last: p.epoch, buys: p.buys, sells: p.sells, up: i === 0 || p.price >= trades[i - 1].price }));
  }
  // An hourly aggregate (n>1) stands for the epochs of its whole hour: it keeps the one-hour bucket in every timeframe (w = its real span),
  // so its tooltip never reads "12:00-12:05 - 60 epochs" with the hour's high and low. Plain points use the chosen timeframe.
  const by = new Map<string, { t: number; w: number; ps: ClearPoint[] }>();
  for (const p of trades) {
    const w = (p.n ?? 1) > 1 ? 3600 : tf; const b = Math.floor(p.time / w) * w; const k = `${w}:${b}`;
    (by.get(k) ?? by.set(k, { t: b, w, ps: [] }).get(k)!).ps.push(p);
  }
  return [...by.values()].sort((a, b) => a.t - b.t || a.w - b.w).map(({ t, w, ps }) => {
    const prices = ps.map((p) => p.price); const o = prices[0], c = prices[prices.length - 1];
    return { t, w, x: t + w / 2, o, h: Math.max(...ps.map((p) => p.high ?? p.price)), l: Math.min(...ps.map((p) => p.low ?? p.price)), c, vol: ps.reduce((s, p) => s + p.volume, 0), n: ps.reduce((s, p) => s + (p.n ?? 1), 0), epoch: ps[ps.length - 1].epoch, first: ps[0].epoch, last: ps[ps.length - 1].epoch, buys: ps.reduce((s, p) => s + p.buys, 0), sells: ps.reduce((s, p) => s + p.sells, 0), up: c >= o };
  });
}

function computeView(all: ClearPoint[], items: Item[], mode: Mode, tf: TF, ref: number, carryEnd = 0): View | null {
  if (!all.length || !items.length) return null;
  let x0 = all[0].time, x1 = Math.max(all[all.length - 1].time, carryEnd);   // a trailing carried stretch runs to "now", so the window must reach it
  if (mode === 'candles') { x0 = Math.min(Math.floor(x0 / tf) * tf, items[0].t); x1 = Math.max(Math.floor(x1 / tf) * tf + tf, ...items.map((i) => i.t + i.w)); }
  else if (x1 - x0 < 240) { const c = (x0 + x1) / 2; x0 = c - 120; x1 = c + 120; }
  else { const s = x1 - x0; x0 -= s * 0.015; x1 += s * 0.03; }
  let lo = Infinity, hi = -Infinity; for (const it of items) { lo = Math.min(lo, it.l); hi = Math.max(hi, it.h); }
  ({ lo, hi } = priceRange(lo, hi, ref));   // the catalog reference joins the range only when it is within data +-30%
  const span = Math.max(hi - lo, 4, hi * 0.02); const mid = (hi + lo) / 2;
  return { x0, x1, y0: Math.max(0, mid - span * 0.62), y1: mid + span * 0.62 };
}

export default function PriceChart() {
  const s = useMarket(); const sel = useSelectedMarket(); const reduced = useReducedMotion();
  const [mode, setMode] = useState<Mode>('line'); const [tf, setTf] = useState<TF>(900);
  const [hover, setHover] = useState<number | null>(null); const [kb, setKb] = useState<number | null>(null);
  const [gapHov, setGapHov] = useState<{ i: number; px: number } | null>(null);   // pointer inside a carried (no-trade) stretch: index and x within the wrapper
  const clock = useClock();
  const [wrap, { w, h }] = useSize<HTMLDivElement>();
  const touchTimer = useRef<any>(0);
  const mid = lc(sel.marketId);
  const all = (s.clears[mid] ?? []) as ClearPoint[];
  const trades = useMemo(() => all.filter((p) => p.volume > 0), [all]);
  const empties = useMemo(() => all.filter((p) => p.volume === 0), [all]);
  // an aggregated (hourly) point stands for n epochs: counts and copy use epochs, not points
  const tradedEpochs = epochCount(trades); const noTrade = epochCount(empties); const hourly = all.some((p) => (p.n ?? 1) > 1);
  const items = useMemo(() => toItems(trades, mode, tf), [trades, mode, tf]);
  const ref = sel.info.referenceCents;
  // holes with no trade, bridged by a dotted flat line at the last price (presentation only; `trades`, `items` and every stat stay real points)
  const liveEpoch = s.ready ? clock?.epoch : undefined;
  const carry = useMemo(() => carrySegments(trades, liveEpoch, CARRY_MIN_GAP), [trades, liveEpoch]);
  const carryEnd = carry.length ? carry[carry.length - 1].t1 : 0;
  const target = useMemo(() => computeView(all, items, mode, tf, ref, carryEnd), [all, items, mode, tf, ref, carryEnd]);
  const v = useTween(target, `${mid}|${mode}|${tf}`, !reduced);
  useEffect(() => { setHover(null); setKb(null); setGapHov(null); }, [mid, mode, tf]);
  useEffect(() => () => clearTimeout(touchTimer.current), []);

  const sym = sel.info.symbol; const src = dataSource(s);
  const ready = s.ready && !loadFailed(s); const plotW = Math.max(0, w - M.l - M.r);
  const axisH = M.b, markH = 12, gap = 8; const volH = Math.max(34, Math.min(64, Math.round(h * 0.15)));
  const priceB = h - axisH - markH - volH - gap * 2; const priceT = M.t; const priceH = Math.max(40, priceB - priceT);
  const volB = priceB + gap + volH; const markY = volB + 4 + markH / 2;
  const drawable = ready && !!v && trades.length > 0 && w > 80 && h > 120;

  const X = (t: number) => v ? M.l + ((t - v.x0) / (v.x1 - v.x0)) * plotW : 0;
  const Y = (p: number) => v ? priceT + (1 - (p - v.y0) / (v.y1 - v.y0)) * priceH : 0;
  const pxPerSec = v ? plotW / (v.x1 - v.x0) : 0;
  const bwOf = (it: Item) => (mode === 'candles' ? Math.max(3, Math.min(26, it.w * pxPerSec * 0.7)) : Math.max(2, Math.min(8, EPOCH_S * pxPerSec * 0.6)));
  const maxVol = Math.max(1, ...items.map((i) => i.vol));
  const active = kb ?? hover; const ai = active !== null ? items[Math.min(active, items.length - 1)] : undefined;
  const last = items[items.length - 1]; const lastUp = last ? (mode === 'line' ? last.up : last.c >= (items[items.length - 2]?.c ?? last.o)) : true;
  const lastPrice = trades.length ? trades[trades.length - 1].price : 0;
  const lastPrev = trades.length > 1 ? trades[trades.length - 2].price : lastPrice; const tagUp = lastPrice >= lastPrev;

  const nearest = (clientX: number) => {
    if (!items.length || !wrap.current) return null; const rect = wrap.current.getBoundingClientRect(); const px = clientX - rect.left;
    if (px < M.l - 4 || px > M.l + plotW + 4) return null; let bi = 0, bd = Infinity;
    items.forEach((it, i) => { const d = Math.abs(X(it.x) - px); if (d < bd) { bd = d; bi = i; } });
    // well inside a carried stretch (not hugging a real point): the tooltip says nothing traded there, instead of snapping to the far point
    const gi = carry.findIndex((g) => px > X(g.t0) + GAP_EDGE_PX && px < X(g.t1) - GAP_EDGE_PX);
    return { bi, gap: gi >= 0 ? { i: gi, px } : null };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawable) return; if (e.pointerType === 'touch') clearTimeout(touchTimer.current); setKb(null);
    const n = nearest(e.clientX); setGapHov(n?.gap ?? null); setHover(n && !n.gap ? n.bi : null);
  };
  const clearHover = () => { setHover(null); setGapHov(null); };
  const onLeave = (e: React.PointerEvent) => { if (e.pointerType === 'touch') { touchTimer.current = setTimeout(clearHover, 4500); } else clearHover(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (!items.length) return; const cur = kb ?? hover ?? items.length;
    if (e.key === 'ArrowLeft') { setKb(Math.max(0, Math.min(items.length - 1, cur - 1))); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setKb(Math.max(0, Math.min(items.length - 1, cur + 1))); e.preventDefault(); }
    else if (e.key === 'Home') { setKb(0); e.preventDefault(); } else if (e.key === 'End') { setKb(items.length - 1); e.preventDefault(); }
    else if (e.key === 'Escape') { setKb(null); clearHover(); }
  };

  const plotted = items.length;
  const pickMode = (m: Mode) => setMode(m);
  const aria = trades.length ? `${sym}: ${tradedEpochs} cleared epochs with trades. Last ${usd(lastPrice)}. ${mode === 'line' ? 'Line chart' : `Candles, ${TFS.find((t) => t[1] === tf)![0]} buckets`}. Use the left and right arrow keys to inspect points; the epochs table below lists the same data. Dotted line: catalog reference ${usd(ref)}.` : `${sym}: no trade yet. Dotted line: catalog reference ${usd(ref)}.`;

  // paths
  // The line breaks across epochs with no trade: each run of consecutive traded epochs gets its own path; a lone point is drawn as a dot.
  const runs = drawable && mode === 'line' ? splitAtGaps(items).map((run) => run.map((it) => ({ it, x: X(it.x), y: Y(it.c) }))) : [];
  const segs = runs.map((r) => { const d = linePathOf(r); return { d, area: d ? `${d}L${r[r.length - 1].x.toFixed(1)},${priceB}L${r[0].x.toFixed(1)},${priceB}Z` : '' }; });
  const pt = v ? priceTicks(v.y0, v.y1, priceH) : []; const tt = v ? timeTicks(v.x0, v.x1, plotW) : { ticks: [] as number[], step: 60 };
  const spanS = v ? v.x1 - v.x0 : 0;
  const tlabel = (t: number) => tt.step < 60 ? hhmmss(t) : spanS > 20 * 3600 ? `${dmon(t)} ${hhmm(t)}` : hhmm(t);

  // catalog reference: a dotted line when it lies inside the visible range, else a small pinned note at the nearer edge
  const refY = v ? Y(ref) : 0; const refIn = !!v && refY >= priceT + 2 && refY <= priceB - 2;
  const refUp = !!v && ref > v.y1; const refLabel = `reference ${usd(ref)}`;
  const refTy = refIn ? (refY - priceT < 14 ? refY + 13 : refY - 5) : refUp ? priceT + 11 : priceB - 5;

  const tipLeft = ai ? X(ai.x) : 0; const flip = tipLeft + 190 > w - M.r;
  const tipTop = ai ? Math.min(Math.max(Y(ai.c) - 20, priceT), priceB - 100) : 0;

  return (
    <section className="mk-panel mk-chartp" data-panel="chart" aria-label={`Price chart, ${sym}`}>
      <div className="mk-scope" data-testid="price-scope">
        <h2>Clearing price</h2>
        {src && <Provenance kind={src.kind} note={src.note} />}
        <p>{PRICE_SCOPE}</p>
        {src?.history && <small>{src.history}</small>}
      </div>
      <div className="mk-ph mk-ctl">
        <div className="mk-seg" role="group" aria-label="Chart type">
          <button type="button" data-testid="chart-mode-line" aria-pressed={mode === 'line'} onClick={() => pickMode('line')}>Line</button>
          <button type="button" data-testid="chart-mode-candles" aria-pressed={mode === 'candles'} onClick={() => pickMode('candles')}>Candles</button>
        </div>
        <div className="mk-seg" role="group" aria-label="Candle timeframe (choosing one switches to candles)">
          {TFS.map(([l, sec]) => (
            <button key={l} type="button" data-testid={`tf-${l}`} aria-pressed={mode === 'candles' && tf === sec} className={mode === 'line' ? 'idle' : ''} onClick={() => { setTf(sec); setMode('candles'); }}>{l}</button>
          ))}
        </div>
        <span className="mk-ctl-sp" /><span className="mk-uni">Each epoch settles at one uniform price</span>
        <span className="mk-legends">
          <span className="mk-legend" title="An epoch that cleared with no trade: no overlapping bids and asks, so no price was set.">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1 9 5 5 9 1 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
            no-trade epoch{noTrade === 1 ? '' : 's'}: {noTrade}
          </span>
          {carry.length > 0 && drawable && (
            <span className="mk-legend" data-testid="chart-gap-legend" title="A stretch of more than a few epochs with no trade at all. The dotted line carries the last cleared price across it; it is not data and is not counted in the stats.">
              <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true"><line className="mk-gap" x1="1" x2="17" y1="5" y2="5" /></svg>
              dotted: no trades, last price carried
            </span>
          )}
        </span>
      </div>

      <BotStatus />
      <div className="mk-chart" data-testid="price-chart" data-points={drawable ? plotted : 0} data-segments={runs.length} data-gap-count={drawable ? carry.length : 0} data-mode={mode} ref={wrap}>
        {!ready && <div className="mk-sk mk-sk-fill" aria-label="Loading chart" role="status" />}
        {ready && trades.length === 0 && w > 80 && (
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="mk-svg mk-svg-ref" role="img" aria-label={aria} data-testid="ref-line-untraded">
            <line className="mk-ref" x1={M.l} x2={w - 6} y1={30} y2={30} />
            <text className="mk-ref-t" x={M.l + 4} y={24} aria-hidden="true">{refLabel}</text>
          </svg>
        )}
        {ready && trades.length === 0 && (
          <div className="mk-empty mk-empty-ref" role="status">
            <b>No trade yet</b>
            <span>{all.length ? `${noTrade} epoch${noTrade === 1 ? '' : 's'} cleared with no trade for ${sym}.` : `No epoch has cleared for ${sym} in the loaded history.`} Every epoch settles at one uniform price, so a market with no overlapping bids and asks simply has no price yet.</span>
          </div>
        )}
        {drawable && v && (
          <>
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="mk-svg" aria-hidden="true"
              onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={onLeave}>
              <defs>
                <linearGradient id="mk-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#CCFF00" stopOpacity=".20" /><stop offset="1" stopColor="#CCFF00" stopOpacity="0" /></linearGradient>
                <clipPath id="mk-clip"><rect x={M.l} y={0} width={plotW} height={h} /></clipPath>
              </defs>
              {pt.map((p) => Math.abs(Y(p) - Y(lastPrice)) < 13 || (ai && Math.abs(Y(p) - Y(ai.c)) < 13) ? null : <g key={p}><line className="mk-grid" x1={M.l} x2={M.l + plotW} y1={Y(p)} y2={Y(p)} /><text className="mk-ax" x={M.l + plotW + 8} y={Y(p) + 4}>{usd(p)}</text></g>)}
              <g clipPath="url(#mk-clip)">
                <CarryLines segs={carry} X={X} Y={Y} />
                {mode === 'line' && segs.map((g, i) => g.d ? <g key={i}><path d={g.area} fill="url(#mk-area)" /><path d={g.d} className="mk-line" fill="none" /></g> : null)}
                {mode === 'line' && runs.map((r) => (r.length === 1 || items.length <= 70) ? r.map(({ it, x, y }) => it === last ? null : <circle key={it.epoch} cx={x} cy={y} r={r.length === 1 ? 2.6 : 1.8} className="mk-dot" />) : null)}
                {mode === 'candles' && items.map((it) => {
                  const x = X(it.x); const bw = bwOf(it); const col = it.up ? 'mk-up' : 'mk-dn'; const top = Y(Math.max(it.o, it.c)), bot = Y(Math.min(it.o, it.c));
                  return <g key={`${it.t}:${it.w}`} className={col}><line x1={x} x2={x} y1={Y(it.h)} y2={Y(it.l)} className="mk-wick" /><rect x={x - bw / 2} width={bw} y={top} height={Math.max(1.5, bot - top)} className="mk-body" /></g>;
                })}
                {items.map((it) => { const bh = Math.max(1.5, (it.vol / maxVol) * volH); const bw = bwOf(it); return <rect key={`v${it.t}:${it.w}`} x={X(it.x) - bw / 2} y={volB - bh} width={bw} height={bh} className={it.up ? 'mk-vol mk-vup' : 'mk-vol mk-vdn'} />; })}
                {empties.map((e) => <path key={e.epoch} d={`M${X(e.time)},${markY - 4} ${X(e.time) + 4},${markY} ${X(e.time)},${markY + 4} ${X(e.time) - 4},${markY}Z`} className="mk-nt"><title>{`Epoch ${e.epoch}: cleared with no trade`}</title></path>)}
              </g>
              <line className="mk-vbase" x1={M.l} x2={M.l + plotW} y1={volB} y2={volB} />
              <text className="mk-ax mk-ax-s" x={M.l + 2} y={volB - volH + 10}>VOL (units)</text>
              {tt.ticks.map((t) => { const x = X(t); if (x < M.l + 14 || x > M.l + plotW - 14) return null; return <g key={t}><line className="mk-tick" x1={x} x2={x} y1={h - axisH} y2={h - axisH + 4} /><text className="mk-ax" textAnchor="middle" x={x} y={h - 6}>{tlabel(t)}</text></g>; })}
              {/* last price line and tag */}
              {(() => { const y = Y(lastPrice); const ok = y >= priceT - 2 && y <= priceB + 2; return ok ? (
                <g>
                  <line className="mk-lastline" x1={M.l} x2={M.l + plotW} y1={y} y2={y} />
                  <rect className={tagUp ? 'mk-tag mk-tag-up' : 'mk-tag mk-tag-dn'} x={M.l + plotW + 2} y={y - 9} width={M.r - 6} height={18} rx="3" />
                  <text className="mk-tagt" x={M.l + plotW + 2 + (M.r - 6) / 2} y={y + 4} textAnchor="middle">{usd(lastPrice)}</text>
                </g>) : null; })()}
              {refIn && <line className="mk-ref" x1={M.l} x2={M.l + plotW} y1={refY} y2={refY} data-testid="ref-line" />}
              <text className="mk-ref-t" x={M.l + 4} y={refTy} aria-hidden="true" data-testid="ref-label">{refLabel}{refIn ? '' : refUp ? ' (above range)' : ' (below range)'}</text>
              {last && mode === 'line' && <g clipPath="url(#mk-clip)"><circle className="mk-pulse" cx={X(last.x)} cy={Y(last.c)} r="4" /><circle className={lastUp ? 'mk-lastdot mk-lastdot-up' : 'mk-lastdot'} cx={X(last.x)} cy={Y(last.c)} r="3.4" /></g>}
              {gapHov && carry[gapHov.i] && <line className="mk-xh" x1={gapHov.px} x2={gapHov.px} y1={priceT} y2={markY + 6} />}
              {ai && <g>
                <line className="mk-xh" x1={X(ai.x)} x2={X(ai.x)} y1={priceT} y2={markY + 6} />
                <line className="mk-xh" x1={M.l} x2={M.l + plotW} y1={Y(ai.c)} y2={Y(ai.c)} />
                <circle className="mk-xdot" cx={X(ai.x)} cy={Y(ai.c)} r="4" />
                <rect className="mk-xtag" x={M.l + plotW + 2} y={Y(ai.c) - 9} width={M.r - 6} height={18} rx="3" />
                <text className="mk-xtagt" x={M.l + plotW + 2 + (M.r - 6) / 2} y={Y(ai.c) + 4} textAnchor="middle">{usd(ai.c)}</text>
              </g>}
            </svg>
            {gapHov && carry[gapHov.i] && !ai && (() => { const g = carry[gapHov.i]; const gf = gapHov.px + 190 > w - M.r; return (
              <div className="mk-tip mk-tip-gap" data-testid="chart-gap-tip" style={{ left: gapHov.px + (gf ? -14 : 14), top: Math.min(Math.max(Y(g.price) - 20, priceT), priceB - 100), transform: gf ? 'translateX(-100%)' : undefined }} role="status" aria-live="polite">
                {gapTipText(g)}
              </div>); })()}
            {ai && (
              <div className="mk-tip" style={{ left: tipLeft + (flip ? -14 : 14), top: tipTop, transform: flip ? 'translateX(-100%)' : undefined }} role="status" aria-live="polite">
                <div className="mk-tip-h">{mode === 'line' ? <>{ai.n > 1 ? `${ai.n} epochs to ${ai.epoch}` : `Epoch ${ai.epoch}`} <i>·</i> {hhmmss(ai.t)}</> : <>{hhmm(ai.t)}–{hhmm(ai.t + ai.w)} <i>·</i> {ai.n} epoch{ai.n === 1 ? '' : 's'}</>}</div>
                {mode === 'line' && ai.n > 1 ? <><div className="mk-tip-r"><span>Last</span><b>{usd(ai.c)}</b></div><div className="mk-tip-r"><span>High</span><b>{usd(ai.h)}</b></div><div className="mk-tip-r"><span>Low</span><b>{usd(ai.l)}</b></div></>
                  : mode === 'line' ? <div className="mk-tip-r"><span>Price</span><b>{usd(ai.c)}</b></div> : (
                  <>
                    <div className="mk-tip-r"><span>Open</span><b>{usd(ai.o)}</b></div><div className="mk-tip-r"><span>High</span><b>{usd(ai.h)}</b></div>
                    <div className="mk-tip-r"><span>Low</span><b>{usd(ai.l)}</b></div><div className="mk-tip-r"><span>Close</span><b>{usd(ai.c)}</b></div>
                  </>)}
                <div className="mk-tip-r"><span>Volume</span><b>{int(ai.vol)} units</b></div>
                <div className="mk-tip-r"><span>Bids / asks</span><b>{ai.buys} / {ai.sells}</b></div>
                {mode === 'candles' && <div className="mk-tip-n">epochs {ai.first}{ai.last !== ai.first ? `–${ai.last}` : ''}</div>}
              </div>
            )}
            <div className="mk-kbd" tabIndex={0} role="group" aria-label={aria} onKeyDown={onKey} onBlur={() => setKb(null)} />
            {trades.length === 1 && <div className="mk-wait" role="status">waiting for more epochs</div>}
          </>
        )}
      </div>
      <p className="mk-cap">Each point is the uniform price one epoch's sealed-bid auction cleared at, in USD. Times are local. Candles bucket those cleared prices by time (open = first, close = last).{hourly ? ' Older history is one point per hour: its last price, with the hour\'s high and low.' : ''}</p>
    </section>
  );
}
