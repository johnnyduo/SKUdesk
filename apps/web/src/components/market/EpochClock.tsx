// Epoch clock: a ring that shows where we are in the 45 s BlindBook epoch (commit, reveal, clear), aligned to the chain clock.
// Reads everything from useClock(). The arc is driven by requestAnimationFrame from the last clock reading (smooth, not 4 Hz steps);
// with prefers-reduced-motion it steps once per second instead. Size comes from the container (container query units).
import { useEffect, useRef, useState } from 'react';
import { useClock } from '../../lib/market-app';
import './book.css';

type Phase = 'commit' | 'reveal' | 'clear';
const LABEL: Record<Phase, string> = { commit: 'COMMIT', reveal: 'REVEAL', clear: 'CLEAR' };
const GAP = 1.4; // gap between phase segments, in percent of the circle

export function usePrefersReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const m = window.matchMedia('(prefers-reduced-motion: reduce)'); const f = () => setR(m.matches); f();
    m.addEventListener?.('change', f); return () => m.removeEventListener?.('change', f);
  }, []);
  return r;
}

export default function EpochClock() {
  const clock = useClock();
  const reduced = usePrefersReducedMotion();
  // anchor: chain-clock seconds since t0 at a given wall-clock moment; rAF extrapolates from it
  const anchor = useRef<{ chain: number; wall: number } | null>(null);
  const sched = clock?.schedule;
  if (clock && sched) anchor.current = { chain: clock.epoch * sched.epochLen + clock.offset, wall: Date.now() };

  const [disp, setDisp] = useState<{ epoch: number; phase: Phase; left: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const headRef = useRef<SVGGElement>(null);
  const segRefs = useRef<(SVGCircleElement | null)[]>([]);
  const lastKey = useRef(''); const lastPhase = useRef<Phase | null>(null);

  const segs = sched ? [
    { phase: 'commit' as Phase, from: 0, to: sched.commitEnd },
    { phase: 'reveal' as Phase, from: sched.commitEnd, to: sched.revealEnd },
    { phase: 'clear' as Phase, from: sched.revealEnd, to: sched.epochLen },
  ] : [];

  useEffect(() => {
    if (!sched) return;
    let raf = 0; let timer: any; let stopped = false;
    const frame = () => {
      if (stopped) return; const a = anchor.current; if (!a) return;
      const chain = a.chain + (Date.now() - a.wall) / 1000;
      const epoch = Math.floor(chain / sched.epochLen); const off = Math.min(sched.epochLen, Math.max(0, chain - epoch * sched.epochLen));
      const phase: Phase = off < sched.commitEnd ? 'commit' : off < sched.revealEnd ? 'reveal' : 'clear';
      const end = phase === 'commit' ? sched.commitEnd : phase === 'reveal' ? sched.revealEnd : sched.epochLen;
      const left = Math.max(0, Math.ceil(end - off - 1e-6));
      // arc
      const C = 100;
      segs.forEach((s, i) => {
        const el = segRefs.current[i]; if (!el) return;
        const full = ((s.to - s.from) / sched.epochLen) * C - GAP; const frac = Math.min(1, Math.max(0, (off - s.from) / (s.to - s.from)));
        el.style.strokeDasharray = `${Math.max(0, full * frac)} ${C}`; el.style.opacity = frac > 0 ? '1' : '0';
      });
      if (headRef.current) headRef.current.style.transform = `rotate(${(off / sched.epochLen) * 360}deg)`;
      const key = `${epoch}|${phase}|${left}`;
      if (key !== lastKey.current) { lastKey.current = key; setDisp({ epoch, phase, left }); }
      if (phase !== lastPhase.current) { if (lastPhase.current) setAnnounce(`${LABEL[phase].toLowerCase()} phase, epoch ${epoch}`); lastPhase.current = phase; }
      if (reduced) timer = setTimeout(frame, 1000); else raf = requestAnimationFrame(frame);
    };
    frame();
    return () => { stopped = true; cancelAnimationFrame(raf); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sched?.t0, sched?.epochLen, sched?.commitEnd, sched?.revealEnd, reduced]);

  const phase: Phase | 'loading' = disp?.phase ?? 'loading';
  const view = disp ?? null;
  const R = 44; // circle radius in a 100 x 100 viewBox
  return (
    <div className="ec" data-testid="epoch-clock" data-phase={phase} data-epoch={view?.epoch ?? ''} role="group"
      aria-label={view ? `Epoch ${view.epoch}, ${LABEL[view.phase].toLowerCase()} phase, ${view.left} seconds left in this phase` : 'Epoch clock loading'}>
      <svg className="ec-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        {!sched && <circle className="ec-track ec-idle" cx="50" cy="50" r={R} />}
        {segs.map((s, i) => {
          const full = ((s.to - s.from) / (sched as any).epochLen) * 100 - GAP; const start = (s.from / (sched as any).epochLen) * 100 + GAP / 2;
          const on = view?.phase === s.phase;
          return (
            <g key={s.phase} className={'ec-seg ph-' + s.phase + (on ? ' on' : '')} style={{ transform: 'rotate(-90deg)', transformOrigin: '50px 50px' }}>
              <circle className="ec-track" cx="50" cy="50" r={R} pathLength={100} style={{ strokeDasharray: `${full} 100`, strokeDashoffset: -start }} />
              <circle className="ec-fill" cx="50" cy="50" r={R} pathLength={100} ref={(el) => { segRefs.current[i] = el; }} style={{ strokeDashoffset: -start, strokeDasharray: '0 100' }} />
            </g>
          );
        })}
        <g ref={headRef} className="ec-head" style={{ transformOrigin: '50px 50px' }}>
          <circle cx="50" cy={50 - R} r="3.1" />
        </g>
      </svg>
      <div className="ec-in">
        <span className="ec-ph mono">{view ? LABEL[view.phase] : 'LOADING'}</span>
        <span className="ec-n mono" data-testid="epoch-countdown">{view ? view.left : ''}</span>
        <span className="ec-s mono">{view ? 'sec left' : 'reading chain'}</span>
        <span className="ec-ep mono">{view ? `epoch ${view.epoch}` : ''}</span>
      </div>
      <span className="sr-only" aria-live="polite">{announce}</span>
    </div>
  );
}
