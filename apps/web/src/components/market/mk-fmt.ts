// Small shared helpers for the /market terminal (formatting + two tiny hooks). No data logic lives here.
import { useEffect, useState } from 'react';
import { fmtUsdCents } from '../../lib/market-fmt';

/** Integer cents to a dollar string, e.g. 1098 -> $10.98, 129643 -> $1,296.43 (the one /market price format; see lib/market-fmt.ts) */
export const usd = fmtUsdCents;
export const lc = (s: string) => s.toLowerCase();
/** +1.23% / -0.40% from a fraction. */
export const pctStr = (f: number) => (f > 0 ? '+' : f < 0 ? '-' : '') + Math.abs(f * 100).toFixed(2) + '%';
export const dirOf = (f: number): 'up' | 'down' | 'flat' => (f > 0 ? 'up' : f < 0 ? 'down' : 'flat');
const t24 = { hourCycle: 'h23' } as const;
/** Local time HH:MM (24 h) from unix seconds. */
export const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { ...t24, hour: '2-digit', minute: '2-digit' });
/** Local time HH:MM:SS. */
export const hhmmss = (t: number) => new Date(t * 1000).toLocaleTimeString([], { ...t24, hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** Local short date, e.g. Oct 2. */
export const dmon = (t: number) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
export const ago = (t: number, nowSec: number) => { const d = Math.max(0, Math.round(nowSec - t)); return d < 5 ? 'just now' : d < 60 ? `${d}s ago` : d < 3600 ? `${Math.floor(d / 60)}m ago` : d < 86400 ? `${Math.floor(d / 3600)}h ago` : `${Math.floor(d / 86400)}d ago`; };
export const int = (n: number) => n.toLocaleString('en-US');

/** Wall clock in seconds, re-rendering every `ms`. */
export function useNowSec(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

export function useReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const m = window.matchMedia('(prefers-reduced-motion: reduce)'); const f = () => setR(m.matches); f();
    m.addEventListener?.('change', f); return () => m.removeEventListener?.('change', f);
  }, []);
  return r;
}

export const sideName = (s: 0 | 1) => (s === 0 ? 'BUY' : 'SELL');
