// One-time reveal for blocks that are complete on first paint. The content is never hidden for visitors without JavaScript,
// with reduced motion, without IntersectionObserver, or when the block is already on screen at load (no flash of content
// that disappears). Only a block that starts BELOW the fold is "armed" (visually hidden by CSS) and plays once when it
// scrolls into view. It never repeats.
import { useEffect, useState, type RefObject } from 'react';

export type RevealState = 'off' | 'armed' | 'run' | 'done';

/** Threshold 0 plus a shrunk bottom edge: any visible pixel counts, so a block taller than the viewport still reveals. */
export const REVEAL_THRESHOLD = 0;
export const REVEAL_ROOT_MARGIN = '0px 0px -10% 0px';

/** A block shorter than the shrunk bottom edge, at the very end of a page, can never intersect and would stay hidden. */
export const REVEAL_MIN_HEIGHT = 0.2; // of the viewport: twice the 10% bottom margin

/** Arm only a block that starts at least 1.1 x the viewport down (below the shrunk bottom edge, so it cannot be on screen yet). */
export const REVEAL_MIN_TOP = 1.1;

export function revealPlan(o: { reduced: boolean; hasIO: boolean; top: number; viewport: number; height?: number }): 'skip' | 'arm' {
  if (o.height !== undefined && !(o.height >= o.viewport * REVEAL_MIN_HEIGHT)) return 'skip'; // also 0, negative and NaN
  return o.reduced || !o.hasIO || o.top < o.viewport * REVEAL_MIN_TOP ? 'skip' : 'arm';
}

export type RevealEnv = { innerHeight: number; hasIO: boolean; reducedMotion: () => boolean };

/** The plan for a real element: what the hook feeds to revealPlan (kept separate so it can be tested without a DOM). */
export function elementRevealPlan(el: { getBoundingClientRect(): { top: number; height: number } }, env: RevealEnv): 'skip' | 'arm' {
  const r = el.getBoundingClientRect();
  return revealPlan({ reduced: env.reducedMotion(), hasIO: env.hasIO, top: r.top, viewport: env.innerHeight, height: r.height });
}

export type RevealDeps = {
  plan: () => 'skip' | 'arm';
  ms: number;
  /** Calls `onVisible` when the block scrolls into view; returns the cleanup. */
  observe: (onVisible: () => void) => () => void;
  /** Runs `fn` after `ms`; returns the cancel function. */
  later: (fn: () => void, ms: number) => () => void;
  onChange: (s: RevealState) => void;
};

/** The reveal lifecycle without React or the DOM: start() returns the cleanup. A skipped block is reported as 'off' (visible). */
export function createRevealController(d: RevealDeps): { start(): () => void } {
  return {
    start() {
      if (d.plan() === 'skip') { d.onChange('off'); return () => {}; }
      d.onChange('armed');
      let fired = false;
      let cancel: (() => void) | undefined;
      const unobserve = d.observe(() => {
        if (fired) return;
        fired = true;
        unobserve();
        d.onChange('run');
        cancel = d.later(() => d.onChange('done'), d.ms);
      });
      return () => { unobserve(); cancel?.(); };
    },
  };
}

export function useRevealOnce(ref: RefObject<Element>, ms = 1200): RevealState {
  const [state, setState] = useState<RevealState>('off');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return createRevealController({
      ms,
      onChange: setState,
      plan: () => elementRevealPlan(el, {
        innerHeight: window.innerHeight,
        hasIO: typeof IntersectionObserver === 'function',
        reducedMotion: () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      }),
      observe: (onVisible) => {
        const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) onVisible(); }, { threshold: REVEAL_THRESHOLD, rootMargin: REVEAL_ROOT_MARGIN });
        io.observe(el);
        return () => io.disconnect();
      },
      later: (fn, delay) => { const t = setTimeout(fn, delay); return () => clearTimeout(t); },
    }).start();
  }, [ref, ms]);
  return state;
}
