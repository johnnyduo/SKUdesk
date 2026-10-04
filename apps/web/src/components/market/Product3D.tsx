// Rotatable 3D product viewer for one market (keyed on its symbol). three.js is loaded lazily; without WebGL it falls back to an SVG illustration.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMarket, useSelectedMarket } from '../../lib/market-app';
import { specForSymbol } from './product3d/specs';
import DeviceArt from './product3d/DeviceArt';
import { usd } from './mk-fmt';
import { browserEnv, createStartGate } from './product3d/start-gate';
import './product3d.css';

type Mode = 'loading' | 'webgl' | 'fallback';

export default function Product3D({ marketId }: { marketId: string }) {
  const state = useMarket();
  const sel = useSelectedMarket();
  const m = state.markets.find((x) => String(x.marketId).toLowerCase() === String(marketId).toLowerCase()) ?? sel.info;
  const spec = useMemo(() => specForSymbol(m.symbol), [m.symbol]);
  const sub = m.subtitle; // the catalog's second line ("Apple smartphone", "Clear MagSafe case for iPhone 16 Pro")
  const hint = 'Drag or use arrow keys to rotate, plus and minus to zoom, 0 to reset.';
  const accent = m.accent || '#ccff00';
  const last = m.last; // cents of the last clearing price; 0 means no trade yet

  const [mode, setMode] = useState<Mode>('loading');
  const [modified, setModified] = useState(false);
  const [pulse, setPulse] = useState<{ dir: 'up' | 'down'; n: number } | null>(null);
  const root = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), top = useRef<HTMLDivElement>(null), bot = useRef<HTMLDivElement>(null);
  const gate = useRef<ReturnType<typeof createStartGate> | null>(null), ready = useRef(state.ready); ready.current = state.ready;
  const shown = useRef<{ spec: unknown; accent: string } | null>(null), api = useRef<any>(null), want = useRef({ spec, accent, name: m.name }); want.current = { spec, accent, name: m.name };
  const prev = useRef<{ id: string; last: number } | null>(null);

  // create the scene once; three is imported lazily so the first paint never waits for it. The gate (start-gate.ts) holds the creation back until the market
  // store is ready (or 2.5 s), then a browser idle moment, so the price is on screen before the main thread spends its time on WebGL setup.
  useEffect(() => {
    let dead = false, started = false, io: IntersectionObserver | undefined;
    const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const onMq = () => api.current?.setReduced(reduced()); mq?.addEventListener?.('change', onMq);
    async function start() {
      if (started || dead) return; started = true;
      try {
        const [T, sc] = await Promise.all([import('three'), import('./product3d/scene')]);
        if (dead || !stage.current) return;
        const a = sc.createScene(T, stage.current, {
          reduced: reduced(),
          padTop: () => (top.current?.offsetHeight ?? 0) + 6, padBottom: () => (bot.current?.offsetHeight ?? 0) + 4,
          onRotation: (y: number) => root.current?.setAttribute('data-rotation', y.toFixed(3)),
          onLost: () => setMode('fallback'), onRestored: () => setMode('webgl'), onModified: setModified,
        });
        if (dead) { a.dispose(); return; }
        api.current = a; a.setProduct(want.current.spec, want.current.accent); shown.current = { spec: want.current.spec, accent: want.current.accent };
        const c = stage.current.querySelector('canvas'); c?.setAttribute('aria-label', `Rotatable 3D model of ${want.current.name}. ${hint}`);
        setMode('webgl');
      } catch { if (!dead) setMode('fallback'); }
    }
    const g = createStartGate(browserEnv(), start); gate.current = g; g.setReady(ready.current);
    // only spend the download and a GL context once the panel is (nearly) on screen
    if (typeof IntersectionObserver === 'function' && root.current) { io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { io?.disconnect(); g.setVisible(true); } }, { rootMargin: '300px' }); io.observe(root.current); }
    else g.setVisible(true);
    return () => { dead = true; io?.disconnect(); g.dispose(); gate.current = null; mq?.removeEventListener?.('change', onMq); api.current?.dispose(); api.current = null; shown.current = null; };
  }, []);

  useEffect(() => { gate.current?.setReady(state.ready); }, [state.ready]);

  // morph to the newly selected product
  useEffect(() => {
    // the scene was just created with this very product: a second setProduct would rebuild the model and play the swap animation for nothing
    if (api.current && !(shown.current && shown.current.spec === spec && shown.current.accent === accent)) { api.current.setProduct(spec, accent); shown.current = { spec, accent }; }
    const c = stage.current?.querySelector('canvas'); c?.setAttribute('aria-label', `Rotatable 3D model of ${m.name}. ${hint}`);
    setModified(false);
  }, [spec, accent, mode, m.name]);

  // price tick: pulse the accent glow green (up) or red (down); never on first sight of a price
  useEffect(() => {
    const p = prev.current; prev.current = { id: String(m.marketId), last };
    if (p && p.id === String(m.marketId) && p.last > 0 && last > 0 && last !== p.last) {
      const dir = last > p.last ? 1 : -1; setPulse((q) => ({ dir: dir > 0 ? 'up' : 'down', n: (q?.n ?? 0) + 1 })); api.current?.pulse(dir);
    }
  }, [m.marketId, last]);

  const hasTrade = last > 0;
  const ch = m.change, chTxt = `${ch > 0 ? '+' : ''}${(ch * 100).toFixed(2)}%`, dir = ch > 0.00005 ? 'up' : ch < -0.00005 ? 'down' : 'flat';

  return (
    <div ref={root} className="p3d" role="group" aria-label={`${m.name}: 3D product viewer`}
      data-testid="product-3d" data-mode={mode} data-market={m.symbol} data-model={m.symbol} data-kind={spec.kind} data-rotation="0" data-last-price={hasTrade ? last : ''}
      data-pulse={pulse?.dir ?? ''} data-pulse-n={pulse?.n ?? 0} style={{ ['--acc' as any]: accent }}>
      <div className="p3d-glow" aria-hidden="true" key={'g' + (pulse?.n ?? 0)} />
      <div ref={stage} className={'p3d-stage' + (modified ? ' modified' : '')}>
        {mode !== 'webgl' && <div className={'p3d-art' + (mode === 'loading' ? ' loading' : '')}><DeviceArt kind={spec.kind} symbol={spec.symbol} accent={accent} label={`${m.name}, ${spec.noun}`} skeleton={mode === 'loading'} /></div>}
      </div>
      <div ref={top} className="p3d-top">
        <div className="p3d-id"><span className="p3d-dot" aria-hidden="true" /><span className="p3d-sym mono">{m.symbol}</span></div>
        <div className="p3d-name" title={m.name}>{m.name}</div>
        {sub && <div className="p3d-compat">{sub}</div>}
        {spec.kind === 'case' && <div className="p3d-chip" aria-hidden="true">Accessory · shown with a phone inside</div>}
      </div>
      <button type="button" className="p3d-reset" aria-label="Reset view" title="Reset view" hidden={!(modified && mode === 'webgl')} onClick={() => { api.current?.reset(); setModified(false); }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
      </button>
      <div ref={bot} key={String(m.marketId)} className="p3d-bot" aria-live="polite">
        <div className="p3d-pricebox">
          {hasTrade
            ? <div className={'p3d-price mono ' + (pulse ? 'tick-' + pulse.dir : '')} key={'p' + (pulse?.n ?? 0)} data-testid="product-price" title="Last clearing price of test units on BlindBook. Not a retail price.">{usd(last)}</div>
            : <div className="p3d-price none mono" data-testid="product-price">No trade yet</div>}
          <div className="p3d-sub mono">
            {hasTrade
              ? <><span className={'p3d-chg ' + dir}><svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">{dir === 'down' ? <path d="M1 2h8L5 8z" fill="currentColor" /> : dir === 'up' ? <path d="M1 8h8L5 2z" fill="currentColor" /> : <path d="M1 4.2h8v1.6H1z" fill="currentColor" />}</svg>{chTxt}</span><span className="p3d-ep">epoch {m.lastEpoch}</span></>
              : <span className="p3d-ref">reference {usd(m.referenceCents)}, not traded</span>}
          </div>
        </div>
        {mode === 'webgl' && <div className="p3d-hint" aria-hidden="true">drag to rotate</div>}
      </div>
    </div>
  );
}
