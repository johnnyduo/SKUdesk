import { ringAt, stepValue, restValue, isValueSettled, type ValueState } from './timeline.ts';

type Data = { tiles: { src: string; rank: number }[] };

const idle = () => new Promise<void>((r) => ('requestIdleCallback' in window ? (window as any).requestIdleCallback(() => r(), { timeout: 1000 }) : setTimeout(r, 1)));
/** The ring starts when the visitor engages (scroll, touch, pointer, key) or after a short grace period. Until then the SVG poster is the same picture, so nothing is missing, and the first seconds of the page stay free for text, fonts and input. */
const engaged = (graceMs: number) => new Promise<void>((resolve) => {
  const evs = ['wheel', 'touchstart', 'pointerdown', 'pointermove', 'keydown', 'scroll'];
  let t = 0;
  const done = () => { clearTimeout(t); evs.forEach((e) => removeEventListener(e, done)); resolve(); };
  t = window.setTimeout(done, graceMs);
  evs.forEach((e) => addEventListener(e, done, { passive: true, once: true }));
});
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Reduced motion, short screens, no WebGL, failed load, or fewer than 2 items: no pinning, cards stacked as text. */
function staticMode(root: HTMLElement) { root.classList.add('sc-static'); }

export async function startShowcase(root: HTMLElement, data: Data): Promise<void> {
  const n = data.tiles.length;
  if (n < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(max-height: 700px)').matches) return staticMode(root);
  await engaged(4000);
  await idle();

  // All mutable state is declared before anything async: tile image loads call wake() while mounting.
  let ring: Awaited<ReturnType<typeof import('./ring-scene.ts').mountRing>> | undefined;
  let alive = false, visible = true, lost = false, raf = 0, last = 0, renders = 0, activeIdx = -1, lostTimer = 0;

  const host = root.querySelector<HTMLElement>('.sc-canvas')!;
  const cards = [...root.querySelectorAll<HTMLElement>('.sc-card')];
  const dots = [...root.querySelectorAll<HTMLElement>('.sc-rail i')];
  const compactMq = matchMedia('(max-width: 760px)');
  let compact = compactMq.matches;

  const progress = () => {
    const r = root.getBoundingClientRect();
    const total = r.height - innerHeight;
    return total > 0 ? clamp01(-r.top / total) : 0;
  };
  const isStatic = () => root.classList.contains('sc-static');

  let state: ValueState = restValue(ringAt(progress(), n).position); // first frame lands on the right item

  const setActive = (i: number) => {
    if (i === activeIdx) return;
    activeIdx = i;
    root.dataset.active = String(i);
    cards.forEach((c, k) => c.classList.toggle('is-active', k === i));
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
  };

  const tick = (now: number) => {
    raf = 0;
    if (!ring || isStatic()) return;
    const target = ringAt(progress(), n);
    if (lost) { setActive(target.active); return; }      // context gone: captions keep following the scroll
    const dt = last ? (now - last) / 1000 : 0; last = now;
    state = stepValue(state, target.position, dt);
    setActive(Math.min(n - 1, Math.max(0, Math.round(state.value)))); // caption follows the rendered ring
    ring.setRing(state.value);
    ring.render(); renders++; root.dataset.renders = String(renders); root.dataset.pos = String(state.value); // unrounded: the check compares round(pos) with data-active
    if (!root.classList.contains('sc-ready')) root.classList.add('sc-ready'); // poster fades after the first real frame
    if (visible && !document.hidden && !isValueSettled(state, target.position)) raf = requestAnimationFrame(tick);
    else last = 0;
  };
  function wake() { if (!alive || raf || !visible || document.hidden) return; raf = requestAnimationFrame(tick); }

  try {
    const [scene, tileMod] = await Promise.all([import('./ring-scene.ts'), import('./tile.ts')]);
    await document.fonts?.ready;                          // tiles use the mono font for the rank pill
    const tiles = data.tiles.map((t) => tileMod.createTile(t, () => { ring?.markDirty(); wake(); }, compactMq.matches ? 0.75 : 1));
    await Promise.race([Promise.all(tiles.map((t) => t.ready)), new Promise<void>((r) => setTimeout(r, 1500))]); // textures upload once, with the art on them
    ring = await scene.mountRing(host, { tiles: tiles.map((t) => t.canvas), maxDpr: compactMq.matches ? 1.25 : 2, lite: compactMq.matches });
  } catch {
    return staticMode(root);
  }
  alive = true;

  root.dataset.compact = String(compact);
  setActive(Math.round(state.value));
  wake();

  addEventListener('scroll', wake, { passive: true });
  addEventListener('resize', () => { compact = compactMq.matches; root.dataset.compact = String(compact); ring?.resize(); wake(); });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake(); }, { rootMargin: '10% 0px' }).observe(root);
  document.addEventListener('visibilitychange', wake);

  ring.onContextLost(() => {
    lost = true; root.classList.remove('sc-ready');
    // Not restored within a few seconds: stop pinning and fall back to the stacked layout.
    lostTimer = window.setTimeout(() => { if (lost) staticMode(root); }, 4000);
  });
  ring.onContextRestored(() => { if (isStatic()) return; lost = false; clearTimeout(lostTimer); last = 0; wake(); });
}
