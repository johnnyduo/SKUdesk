// Renderer, studio environment, camera, drag/zoom controls, shadow and the render loop. three is passed in (lazy-loaded by the component).
import type { Spec } from './specs';
import { buildModel, disposeModel, setModelGlow, setModelLite } from './build';

export type SceneOpts = {
  reduced: boolean;
  padTop: () => number; padBottom: () => number; // pixels of the stage covered by the HTML overlay
  onRotation: (yaw: number) => void; onLost: () => void; onRestored: () => void; onModified: (m: boolean) => void;
};
export type SceneApi = {
  setProduct(spec: Spec, accent: string): void; pulse(dir: 1 | -1): void; resize(): void; reset(): void;
  setReduced(v: boolean): void; dispose(): void; yaw(): number;
  /** live GPU resource counts (renderer.info.memory), for tests and the debug hook */
  stats(): { geometries: number; textures: number };
};

const DEFAULT_YAW = 0.55, DEFAULT_PITCH = 0.0, FOV = 26, ZMIN = 1, ZMAX = 2.6, IDLE_SPEED = 0.38, PAUSE_MS = 2600;
const GREEN = '#3ed598', RED = '#ff7a7a';

function makeEnv(T: any, renderer: any) {
  const s = new T.Scene();
  const room = new T.Mesh(new T.BoxGeometry(80, 60, 80), new T.MeshBasicMaterial({ color: new T.Color(0.1, 0.11, 0.11), side: T.BackSide })); s.add(room);
  const box = (w: number, h: number, x: number, y: number, z: number, i: number, tint = [1, 1, 1]) => {
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(tint[0] * i, tint[1] * i, tint[2] * i), side: T.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); s.add(m);
  };
  box(26, 18, -14, 16, 18, 7);               // key softbox, upper left front
  box(6, 34, 24, 4, 6, 6, [0.85, 0.95, 1.1]); // right strip (cool rim)
  box(5, 30, -26, 2, -4, 4, [1, 0.96, 0.9]);  // left strip
  box(30, 8, 0, 28, 0, 5);                    // overhead
  box(40, 6, 0, -22, 14, 1.1, [1, 0.9, 0.78]); // warm floor bounce
  box(34, 9, 3, 9, 30, 4.5);                  // front glare strip: sweeps across the case as it turns
  box(24, 12, 4, 6, -30, 3.2, [0.9, 1, 1.05]); // back light so the screen side is lit too
  const pm = new T.PMREMGenerator(renderer); const rt = pm.fromScene(s, 0.025); pm.dispose();
  s.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  return rt;
}

function blobTexture(T: any, rgb: string, inner: number) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d')!;
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64); rg.addColorStop(0, `rgba(${rgb},${inner})`); rg.addColorStop(0.45, `rgba(${rgb},${inner * 0.45})`); rg.addColorStop(1, `rgba(${rgb},0)`); g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
}

export function createScene(T: any, host: HTMLElement, opts: SceneOpts): SceneApi {
  // create the context ourselves first so "no WebGL" is a clean exception (three would log an error) and no throwaway context is made
  const el = document.createElement('canvas'); let gl: any = null;
  try { gl = el.getContext('webgl2', { antialias: true, alpha: true, powerPreference: 'default' }); } catch { gl = null; }
  if (!gl) throw new Error('WebGL unavailable');
  const renderer = new T.WebGLRenderer({ canvas: el, context: gl, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0); renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  if ('transmissionResolutionScale' in renderer) renderer.transmissionResolutionScale = 0.75;
  const canvas: HTMLCanvasElement = renderer.domElement; canvas.setAttribute('data-testid', 'product-3d-canvas');
  canvas.setAttribute('role', 'img'); canvas.tabIndex = 0; canvas.className = 'p3d-canvas'; canvas.dataset.quality = 'full';
  host.append(canvas);

  const scene = new T.Scene(); let envRT = makeEnv(T, renderer); scene.environment = envRT.texture; scene.environmentIntensity = 1;
  const camera = new T.PerspectiveCamera(FOV, 1, 20, 3000);
  const pivot = new T.Group(); pivot.rotation.order = 'YXZ'; scene.add(pivot);
  const mount = new T.Group(); pivot.add(mount); // scaled during product swaps

  // floor shadow + accent glow on the floor
  const shadowTex = blobTexture(T, '0,0,0', 0.62), glowTex = blobTexture(T, '255,255,255', 0.55);
  const shadowMat = new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false });
  const glowMat = new T.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false, color: '#ccff00', opacity: 0.35 });
  const planeGeo = new T.PlaneGeometry(1, 1); planeGeo.rotateX(-Math.PI / 2);
  const shadow = new T.Mesh(planeGeo, shadowMat), glow = new T.Mesh(planeGeo, glowMat); shadow.renderOrder = -2; glow.renderOrder = -3; scene.add(glow, shadow);

  let model: any = null, spec: Spec | null = null, accent = '#ccff00', pending: { spec: Spec; accent: string } | null = null;
  let reduced = opts.reduced, W = 1, Hh = 1, zoom = 1, yaw = DEFAULT_YAW, pitch = DEFAULT_PITCH, yawVel = 0, spin = 0, lastInteract = -1e9, dragging = false;
  let resetting = false, resetYaw = 0, modified = false, engaged = false, scaleS = 1, phase: 'idle' | 'out' | 'in' = 'idle', phaseT = 0, pulseT0 = -1e9, pulseDir: 1 | -1 = 1, lost = false, disposed = false;
  let outFrom = 1, visible = true, raf = 0, lastT = 0, lastRot = -1, lastReport = 0, floorY = -80, baseDist = 400;
  const glowColor = new T.Color(accent), tint = new T.Color(), cGreen = new T.Color(GREEN), cRed = new T.Color(RED);
  const now = () => performance.now();

  let lite = false, frames = 0; const times: number[] = [];
  function goLite() { lite = true; if (model) setModelLite(model); renderer.setPixelRatio(1); renderer.setSize(W, Hh, false); canvas.dataset.quality = 'lite'; }
  function swapIn() {
    if (!pending) return; const p = pending; pending = null;
    if (model) { mount.remove(model); disposeModel(model); model = null; }
    spec = p.spec; accent = p.accent; model = buildModel(T, spec, accent); if (lite) setModelLite(model); mount.add(model); glowColor.set(accent); glowMat.color.set(accent);
    layout();
  }

  function layout() {
    if (!spec) return;
    const t = Math.tan((FOV * Math.PI) / 360), aspect = W / Hh;
    const pt = opts.padTop(), pb = opts.padBottom(), safeH = Math.max(Hh * 0.45, Hh - pt - pb);
    const ex = model?.userData.extent ?? { w: 150, h: 150, d: 150 }, elev = spec.elev;
    const mh = ex.h * Math.cos(elev) + Math.hypot(ex.w, ex.d) * Math.sin(elev) + 8, mw = Math.hypot(ex.w, ex.d) * 0.9 + 10; // spinning footprint, between the longest side and the diagonal
    baseDist = Math.max((mh * Hh) / (safeH * 2 * t), (mw * 1.12) / (2 * t * aspect));
    const dist = baseDist / zoom, vh = 2 * dist * t;
    camera.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist); camera.lookAt(0, 0, 0);
    camera.aspect = aspect; camera.near = Math.max(5, dist - 200); camera.far = dist + 600; camera.updateProjectionMatrix();
    pivot.position.y = ((pb - pt) / 2) * (vh / Hh) * 1; // keep the model in the part of the stage the overlay leaves free
    floorY = pivot.position.y - ex.h / 2 - 3;
    shadow.position.y = floorY; glow.position.y = floorY - 0.5;
  }

  function resize() {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(lite ? 1 : Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(w, h, false); W = w; Hh = h; layout(); wake();
  }

  // controls
  const ptrs = new Map<number, { x: number; y: number }>(); let pinch0 = 0, zoom0 = 1, lastMove = 0;
  const touch = () => { lastInteract = now(); if (!modified) { modified = true; opts.onModified(true); } };
  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); engaged = true; resetting = false;
    if (ptrs.size === 1) { dragging = true; yawVel = 0; lastMove = now(); canvas.classList.add('grab'); }
    else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y) || 1; zoom0 = zoom; }
    lastInteract = now(); wake();
  };
  const onMove = (e: PointerEvent) => {
    const p = ptrs.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size >= 2) { const [a, b] = [...ptrs.values()]; zoom = Math.min(ZMAX, Math.max(ZMIN, (zoom0 * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pinch0)); touch(); layout(); wake(); return; }
    const k = (Math.PI * 1.1) / Math.max(240, W), t = now(), dt = Math.max(1, t - lastMove) / 1000; lastMove = t;
    yaw += dx * k; pitch = Math.max(-0.55, Math.min(0.55, pitch + dy * k * 0.7)); const v = (dx * k) / dt; yawVel = yawVel * 0.5 + Math.max(-9, Math.min(9, v)) * 0.5; touch(); wake();
  };
  const onUp = (e: PointerEvent) => {
    if (!ptrs.delete(e.pointerId)) return; try { canvas.releasePointerCapture?.(e.pointerId); } catch {}
    if (ptrs.size === 0) { dragging = false; canvas.classList.remove('grab'); if (now() - lastMove > 90 || reduced) yawVel = 0; lastInteract = now(); }
    else if (ptrs.size === 1) { pinch0 = 0; }
    wake();
  };
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey || engaged)) return; // never trap page scrolling unless the user opted in (pinch, or has clicked the model)
    e.preventDefault(); const z = Math.min(ZMAX, Math.max(ZMIN, zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)))); if (z !== zoom) { zoom = z; touch(); layout(); wake(); }
  };
  const reset = () => {
    resetting = true; resetYaw = DEFAULT_YAW + Math.PI * 2 * Math.round((yaw - DEFAULT_YAW) / (Math.PI * 2)); yawVel = 0; lastInteract = now(); modified = false; opts.onModified(false); wake();
  };
  const onKey = (e: KeyboardEvent) => {
    const step = 0.18; let used = true;
    if (e.key === 'ArrowLeft') yaw -= step; else if (e.key === 'ArrowRight') yaw += step; else if (e.key === 'ArrowUp') pitch = Math.max(-0.55, pitch - step * 0.7); else if (e.key === 'ArrowDown') pitch = Math.min(0.55, pitch + step * 0.7);
    else if (e.key === '+' || e.key === '=') { zoom = Math.min(ZMAX, zoom * 1.12); layout(); } else if (e.key === '-') { zoom = Math.max(ZMIN, zoom / 1.12); layout(); }
    else if (e.key === '0' || e.key === 'Home') { reset(); return; } else used = false;
    if (used) { e.preventDefault(); resetting = false; touch(); wake(); }
  };
  const onLeave = () => { if (!dragging) engaged = false; };
  const onCtx = (e: Event) => { e.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; opts.onLost(); };
  const onRestore = () => {
    lost = false; envRT.dispose(); envRT = makeEnv(T, renderer); scene.environment = envRT.texture; shadowTex.needsUpdate = true; glowTex.needsUpdate = true;
    model?.traverse((o: any) => { const m = o.material; if (m) { m.needsUpdate = true; if (m.map) m.map.needsUpdate = true; } }); opts.onRestored(); wake();
  };
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('dblclick', reset); canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerleave', onLeave); canvas.addEventListener('blur', () => { engaged = false; });
  canvas.addEventListener('webglcontextlost', onCtx); canvas.addEventListener('webglcontextrestored', onRestore);

  // loop (runs only while something moves and the panel is visible)
  const ease = (t: number) => 1 - Math.pow(1 - t, 3), back = (t: number) => { const c = 1.5, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
  function frame(t: number) {
    raf = 0; if (disposed || lost || !visible || document.hidden) return;
    const dt = Math.min(0.05, Math.max(0.001, (t - (lastT || t - 16)) / 1000)); lastT = t;
    // product swap: shrink out, rebuild, grow in
    if (pending && phase !== 'out') { if (reduced || !model) { swapIn(); scaleS = 1; phase = 'idle'; } else { phase = 'out'; phaseT = 0; outFrom = scaleS; } }
    if (phase === 'out') { phaseT += dt / 0.2; scaleS = outFrom - (outFrom - 0.55) * ease(Math.min(1, phaseT)); yaw += dt * 2.5; if (phaseT >= 1) { swapIn(); phase = 'in'; phaseT = 0; scaleS = 0.55; } }
    else if (phase === 'in') { phaseT += dt / 0.42; scaleS = 0.55 + 0.45 * back(Math.min(1, phaseT)); if (phaseT >= 1) { phase = 'idle'; scaleS = 1; } }
    mount.scale.setScalar(Math.max(0.01, scaleS));

    // rotation
    const idle = !reduced && !dragging && !resetting && t - lastInteract > PAUSE_MS;
    if (resetting) { const k = 1 - Math.exp(-dt * 7); yaw += (resetYaw - yaw) * k; pitch += (DEFAULT_PITCH - pitch) * k; zoom += (1 - zoom) * k; layout(); if (Math.abs(resetYaw - yaw) < 0.002 && Math.abs(zoom - 1) < 0.002) { yaw = resetYaw; zoom = 1; pitch = DEFAULT_PITCH; resetting = false; layout(); } }
    else if (!dragging) {
      if (!reduced) { yaw += yawVel * dt; yawVel *= Math.exp(-dt * 3.2); if (Math.abs(yawVel) < 0.01) yawVel = 0; }
      const target = idle ? IDLE_SPEED : 0; spin += (target - spin) * (1 - Math.exp(-dt * (idle ? 1.2 : 6))); if (Math.abs(spin) < 1e-4 && !idle) spin = 0; yaw += spin * dt;
      if (idle && !reduced) pitch += (DEFAULT_PITCH - pitch) * (1 - Math.exp(-dt * 0.8));
    } else spin += (0 - spin) * (1 - Math.exp(-dt * 10));
    pivot.rotation.y = yaw; pivot.rotation.x = pitch;

    // price pulse
    const pk = reduced ? 0 : Math.max(0, 1 - (t - pulseT0) / 1100), pe = pk * pk * (3 - 2 * pk);
    if (model) { tint.copy(pulseDir > 0 ? cGreen : cRed); setModelGlow(model, tint, pe); }
    glowMat.color.copy(glowColor).lerp(pulseDir > 0 ? cGreen : cRed, pe); glowMat.opacity = 0.3 + 0.55 * pe;

    // floor shadow follows the product's footprint
    if (model) { const ex = model.userData.extent, c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw)); const fw = ex.w * c + ex.d * s, fd = ex.w * s + ex.d * c; const k = scaleS;
      shadow.scale.set((fw * 1.5 + 22) * k, 1, (fd * 1.5 + 22) * k); glow.scale.set((fw * 2.2 + 70) * k, 1, (fd * 2.2 + 70) * k); }

    const r0 = performance.now(); renderer.render(scene, camera); const rd = performance.now() - r0;
    if (!lite) { frames++; if (frames > 3) { times.push(rd); if (times.length >= 20) { const med = times.slice().sort((a, b) => a - b)[10]; times.length = 0; if (med > 65) goLite(); } } }
    if (Math.abs(yaw - lastRot) > 0.004 && t - lastReport > 60) { lastRot = yaw; lastReport = t; opts.onRotation(yaw); }
    if (!reduced || dragging || resetting || phase !== 'idle' || pending) raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && !disposed && !lost && visible && !document.hidden) { lastT = 0; raf = requestAnimationFrame(frame); } }

  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake(); else if (raf) { cancelAnimationFrame(raf); raf = 0; } }, { rootMargin: '10% 0px' }); io.observe(host);
  const onVis = () => { if (!document.hidden) wake(); else if (raf) { cancelAnimationFrame(raf); raf = 0; } }; document.addEventListener('visibilitychange', onVis);
  const ro = new ResizeObserver(() => resize()); ro.observe(host);
  resize();

  return {
    setProduct(s, a) { pending = { spec: s, accent: a }; wake(); },
    pulse(dir) { if (reduced) return; pulseDir = dir; pulseT0 = now(); wake(); },
    resize, reset: () => reset(),
    setReduced(v) { reduced = v; if (v) { yawVel = 0; spin = 0; } wake(); },
    yaw: () => yaw,
    stats: () => ({ geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }),
    dispose() {
      disposed = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('dblclick', reset); canvas.removeEventListener('keydown', onKey); canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('webglcontextlost', onCtx); canvas.removeEventListener('webglcontextrestored', onRestore);
      if (model) { disposeModel(model); model = null; } planeGeo.dispose(); shadowMat.dispose(); glowMat.dispose(); shadowTex.dispose(); glowTex.dispose(); envRT.dispose();
      renderer.dispose(); try { renderer.forceContextLoss(); } catch {} canvas.remove();
    },
  };
}
