import {
  ACESFilmicToneMapping, CanvasTexture, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial,
  PMREMGenerator, PerspectiveCamera, PointLight, Scene, Shape, ShapeGeometry, SRGBColorSpace, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type RingHandle = {
  canvas: HTMLCanvasElement;
  setRing(position: number): void;
  markDirty(): void;
  render(): void;
  resize(): void;
  dispose(): void;
  onContextLost(cb: () => void): void;
  onContextRestored(cb: () => void): void;
};

const TW = 0.9, TH = 1.1, TR = 0.1, TD = 0.04; // tile size, corner radius, thickness
const RADIUS = 1.6, FOV = 30, RAD = Math.PI / 180;

/** Hand the main thread back so no single step of the boot is a long task. */
const yieldMain = (): Promise<void> => ((globalThis as any).scheduler?.yield ? (globalThis as any).scheduler.yield() : new Promise<void>((r) => setTimeout(r, 0)));

function roundedRect(w: number, h: number, r: number): Shape {
  const s = new Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false); s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false); s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false); s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}
function flat(w: number, h: number, r: number, uv = false) {
  const g = new ShapeGeometry(roundedRect(w, h, r), 20);
  if (uv) {
    const pos = g.attributes.position, t = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) t.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
    t.needsUpdate = true;
  }
  return g;
}

type TileMesh = { group: Group; face: MeshBasicMaterial; glow: MeshBasicMaterial; glowMesh: Mesh; tex: CanvasTexture };

function buildTile(canvas: HTMLCanvasElement, glass: MeshPhysicalMaterial): TileMesh {
  const group = new Group();
  const b = 0.012;
  const body = new Mesh(new ExtrudeGeometry(roundedRect(TW - 2 * b, TH - 2 * b, TR - b), { depth: TD - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 3, curveSegments: 16 }), glass);
  body.geometry.translate(0, 0, -(TD - 2 * b) / 2);
  group.add(body);
  const tex = new CanvasTexture(canvas); tex.colorSpace = SRGBColorSpace; tex.anisotropy = 8;
  const face = new MeshBasicMaterial({ map: tex, toneMapped: false, transparent: true });
  const faceMesh = new Mesh(flat(TW - 0.03, TH - 0.03, TR - 0.015, true), face); faceMesh.position.z = TD / 2 + 0.001; group.add(faceMesh);
  const glow = new MeshBasicMaterial({ color: 0xccff00, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
  const glowMesh = new Mesh(flat(TW + 0.04, TH + 0.04, TR + 0.02), glow); glowMesh.position.z = 0; group.add(glowMesh);
  return { group, face, glow, glowMesh, tex };
}

export async function mountRing(host: HTMLElement, opts: { tiles: HTMLCanvasElement[]; maxDpr: number; lite?: boolean }): Promise<RingHandle> {
  // lite (phones): no multisampling; a multisampled buffer is the single most expensive allocation here on weak or software GPUs.
  const renderer = new WebGLRenderer({ antialias: !opts.lite, alpha: true, powerPreference: 'high-performance' });
  if (!renderer.getContext()) throw new Error('WebGL unavailable');
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  const canvas = renderer.domElement; canvas.setAttribute('aria-hidden', 'true'); canvas.className = 'sc-gl';
  host.append(canvas);
  await yieldMain();

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.6; pmrem.dispose();
  await yieldMain();
  const neon = new PointLight(0xccff00, 14, 0, 2); neon.position.set(-2.4, 1.8, 3); scene.add(neon);
  const teal = new PointLight(0x10e1ff, 14, 0, 2); teal.position.set(2.6, -0.8, 3); scene.add(teal);

  const glass = new MeshPhysicalMaterial({ color: '#0b0d0c', metalness: 0.2, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 });
  const ring = new Group(); scene.add(ring);
  const tiles: TileMesh[] = [];
  for (const c of opts.tiles) { const t = buildTile(c, glass); ring.add(t.group); tiles.push(t); await yieldMain(); } // one tile per task
  const n = tiles.length;

  const camera = new PerspectiveCamera(FOV, 1, 0.1, 50);
  const resize = () => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight), aspect = w / h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxDpr));
    renderer.setSize(w, h, false);
    camera.aspect = aspect;
    const t = Math.tan((FOV * RAD) / 2);
    const zFit = 3.2 / (2 * t);                 // ring height fits
    const zWide = 4.0 / (2 * t * aspect);       // ring width fits on narrow stages
    const z = Math.max(zFit, zWide);
    camera.position.set(0, z * Math.tan(22 * RAD), z); // 22° above the ring plane so the side tiles show their faces
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };
  resize();
  // Compile shaders without blocking (KHR_parallel_shader_compile) and upload the textures one at a time.
  try { await (renderer as any).compileAsync?.(scene, camera); } catch { /* the first render compiles instead */ }
  for (const t of tiles) { renderer.initTexture(t.tex); await yieldMain(); }

  const lost: (() => void)[] = [], restored: (() => void)[] = [];
  let disposed = false;
  canvas.addEventListener('webglcontextlost', (e) => { if (disposed) return; e.preventDefault(); lost.forEach((f) => f()); });
  canvas.addEventListener('webglcontextrestored', () => { if (disposed) return; tiles.forEach((t) => { t.tex.needsUpdate = true; }); restored.forEach((f) => f()); });

  const handle: RingHandle = {
    canvas,
    setRing(position) {
      const step = n > 0 ? (2 * Math.PI) / n : 0;
      tiles.forEach((t, i) => {
        const a = i * step - position * step;          // 0 = front
        t.group.position.set(RADIUS * Math.sin(a), 0, RADIUS * Math.cos(a));
        t.group.rotation.y = 0.4 * Math.sin(a);        // periodic and symmetric: every face stays readable
        const focus = Math.pow(Math.max(0, Math.cos(a)), 6);
        t.group.scale.setScalar(0.8 + 0.45 * focus);
        t.face.opacity = 0.55 + 0.45 * focus;
        t.glow.opacity = 0.8 * Math.pow(focus, 3);     // glow only on the front tile
        t.glowMesh.visible = t.glow.opacity > 0.003;
      });
    },
    markDirty() { tiles.forEach((t) => { t.tex.needsUpdate = true; }); },
    render() { renderer.render(scene, camera); },
    resize() { resize(); handle.render(); },
    dispose() { disposed = true; renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); },
    onContextLost(cb) { lost.push(cb); },
    onContextRestored(cb) { restored.push(cb); },
  };
  handle.setRing(0);
  return handle;
}
