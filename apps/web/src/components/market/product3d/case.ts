// Procedural clear phone case + the phone inside it. All units are millimetres. three is passed in (lazy-loaded by the component).
import { CASE_WALL, type CaseSpec, type RR } from './casespec.ts';

type Pt = { x: number; y: number; nx: number; ny: number; side: 'R' | 'T' | 'L' | 'B' | 'C'; s: number };
/** What buildCase hands to the dispatcher in build.ts (which fits and disposes it like every other model). */
export type CaseModel = {
  group: any; extent: { w: number; h: number; d: number };
  /** every geometry, material and texture created (disposeModel frees them) */
  owned: any[];
  /** Blend the accent glow toward a colour (k 0..1). Used for the price-tick pulse. */
  setGlow(color: any, k: number): void;
  /** Cheaper clear plastic (no transmission pass) for software/weak GPUs. */
  setLite(): void;
};

/** Squircle-cornered rounded rectangle, CCW, with outward normals and a side tag for cutouts. */
export function outline(W: number, H: number, r: number, n: number, step = 1): Pt[] {
  const hw = W / 2, hh = H / 2; r = Math.min(r, hw, hh); const pts: Pt[] = [];
  const sgn = (v: number) => (v < 0 ? -1 : 1), pw = 2 / n;
  const corner = (cx: number, cy: number, a0: number) => {
    const segs = Math.max(6, Math.ceil((r * Math.PI) / 2 / step));
    for (let i = 0; i < segs; i++) {
      const a = a0 + (i / segs) * (Math.PI / 2), c = Math.cos(a), s = Math.sin(a);
      const x = r * sgn(c) * Math.abs(c) ** pw, y = r * sgn(s) * Math.abs(s) ** pw;
      let nx = sgn(x) * Math.abs(x / r) ** (n - 1), ny = sgn(y) * Math.abs(y / r) ** (n - 1); const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      pts.push({ x: cx + x, y: cy + y, nx, ny, side: 'C', s: 0 });
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number, side: Pt['side']) => {
    const len = Math.hypot(x1 - x0, y1 - y0); if (len < 1e-6) return; const k = Math.max(1, Math.round(len / step));
    for (let i = 0; i < k; i++) { const t = i / k; const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t; pts.push({ x, y, nx, ny, side, s: side === 'R' || side === 'L' ? y : x }); }
  };
  line(hw, -hh + r, hw, hh - r, 1, 0, 'R'); corner(hw - r, hh - r, 0);
  line(hw - r, hh, -hw + r, hh, 0, 1, 'T'); corner(-hw + r, hh - r, Math.PI / 2);
  line(-hw, hh - r, -hw, -hh + r, -1, 0, 'L'); corner(-hw + r, -hh + r, Math.PI);
  line(-hw + r, -hh, hw - r, -hh, 0, -1, 'B'); corner(hw - r, -hh + r, (3 * Math.PI) / 2);
  return pts;
}

function shapeOf(T: any, W: number, H: number, r: number, n: number, cx = 0, cy = 0, step = 1) {
  const p = outline(W, H, r, n, step); const sh = new T.Shape(p.map((q) => new T.Vector2(q.x + cx, q.y + cy))); return sh;
}
function pathOf(T: any, a: RR, n: number, step = 0.8) { const p = outline(a.w, a.h, a.r, n, step); return new T.Path(p.map((q) => new T.Vector2(q.x + a.cx, q.y + a.cy))); }
const grow = (a: RR, g: number): RR => ({ cx: a.cx, cy: a.cy, w: a.w + 2 * g, h: a.h + 2 * g, r: a.r + g });

/** Round the corners of a polyline [d, z, radius?] with quadratic fillets. */
function fillet(pts: number[][], seg = 5): number[][] {
  const out: number[][] = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [x1, y1, rad = 0] = pts[i], [x0, y0] = pts[i - 1], [x2, y2] = pts[i + 1];
    const l1 = Math.hypot(x0 - x1, y0 - y1), l2 = Math.hypot(x2 - x1, y2 - y1), r = Math.min(rad, l1 * 0.5, l2 * 0.5);
    if (r < 1e-3) { out.push([x1, y1]); continue; }
    const ax = x1 + ((x0 - x1) / l1) * r, ay = y1 + ((y0 - y1) / l1) * r, bx = x1 + ((x2 - x1) / l2) * r, by = y1 + ((y2 - y1) / l2) * r;
    for (let k = 0; k <= seg; k++) { const t = k / seg, u = 1 - t; out.push([u * u * ax + 2 * u * t * x1 + t * t * bx, u * u * ay + 2 * u * t * y1 + t * t * by]); }
  }
  const l = pts[pts.length - 1]; out.push([l[0], l[1]]); return out;
}
function densify(pts: number[][], step: number): number[][] {
  const out: number[][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); for (let j = 1; j <= k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]); }
  return out;
}

type Cut = { side: Pt['side']; c: number; len: number; z0: number; z1: number };
/** Sweep a (d, z) profile around the outline. Quads whose centre falls inside a stadium-shaped cutout are skipped, leaving a real hole. */
function loft(T: any, ring: Pt[], prof: number[][], cuts: Cut[], flip: boolean) {
  const N = ring.length, M = prof.length, pos = new Float32Array(N * M * 3), idx: number[] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) { const q = ring[i], o = (i * M + j) * 3; pos[o] = q.x + q.nx * prof[j][0]; pos[o + 1] = q.y + q.ny * prof[j][0]; pos[o + 2] = prof[j][1]; }
  const inCut = (i: number, j: number) => {
    const a = ring[i], b = ring[(i + 1) % N]; if (a.side !== b.side || a.side === 'C') return false;
    const s = (a.s + b.s) / 2, z = (prof[j][1] + prof[j + 1][1]) / 2;
    for (const c of cuts) if (c.side === a.side) {
      const ha = c.len / 2, hb = (c.z1 - c.z0) / 2, zc = (c.z0 + c.z1) / 2, ds = Math.abs(s - c.c) - Math.max(0, ha - hb), dz = Math.abs(z - zc);
      if (Math.hypot(Math.max(0, ds), dz) < hb && (ds <= 0 ? dz < hb : true)) return true;
    }
    return false;
  };
  for (let i = 0; i < N; i++) { const i2 = (i + 1) % N; for (let j = 0; j < M - 1; j++) {
    if (cuts.length && inCut(i, j)) continue;
    const a = i * M + j, b = i2 * M + j, c = i2 * M + j + 1, d = i * M + j + 1;
    if (flip) idx.push(a, d, b, b, d, c); else idx.push(a, b, d, b, c, d);
  } }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}

function ringGeo(T: any, outer: RR, inner: RR, n: number, depth: number, bevel: number) {
  const sh = shapeOf(T, outer.w, outer.h, outer.r, n, outer.cx, outer.cy, 0.6); sh.holes.push(pathOf(T, inner, n, 0.6));
  const g = new T.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 1, steps: 1 }); return g;
}

function screenTexture(T: any, spec: CaseSpec, accent: string) {
  if (typeof document === 'undefined') return null; // Node (unit tests): the lock screen is skipped, a dark screen is used
  const c = document.createElement('canvas'); c.width = 256; c.height = Math.round((256 * spec.H) / spec.W); const g = c.getContext('2d')!;
  if (!g) return null;
  const grad = g.createLinearGradient(0, 0, c.width, c.height); grad.addColorStop(0, '#05070a'); grad.addColorStop(1, '#0b0f14'); g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  const rg = g.createRadialGradient(c.width * 0.3, c.height * 0.72, 4, c.width * 0.3, c.height * 0.72, c.width * 0.95); rg.addColorStop(0, accent + 'cc'); rg.addColorStop(0.5, accent + '33'); rg.addColorStop(1, '#00000000'); g.fillStyle = rg; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000'; const apple = spec.layout === 'tripleSquare' || spec.layout === 'dualPill'; const iw = apple ? c.width * 0.27 : c.width * 0.05, ih = apple ? c.width * 0.075 : c.width * 0.05; g.beginPath(); g.roundRect((c.width - iw) / 2, c.width * 0.045, iw, ih, ih / 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,.92)'; g.textAlign = 'center'; g.font = `600 ${c.width * 0.3}px ui-sans-serif, system-ui, sans-serif`; g.fillText('9:41', c.width / 2, c.height * 0.3);
  g.font = `500 ${c.width * 0.06}px ui-sans-serif, system-ui, sans-serif`; g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText('Thursday, 2 October', c.width / 2, c.height * 0.3 - c.width * 0.3 * 0.78);
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return t;
}

export function buildCase(T: any, spec: CaseSpec, accentHex: string, lite = false): CaseModel {
  const group = new T.Group(); const disposables: any[] = []; const keep = <X,>(x: X) => { disposables.push(x); return x; };
  const { W, H, T: TH, r, sq } = spec, h = TH / 2, wall = CASE_WALL;
  const addMesh = (parent: any, g: any, m: any, x = 0, y = 0, z = 0) => { const o = new T.Mesh(keep(g), m); o.position.set(x, y, z); parent.add(o); return o; };

  // materials
  const frameMat = keep(new T.MeshStandardMaterial({ color: spec.frame, metalness: 0.92, roughness: 0.3 }));
  const glassMat = keep(new T.MeshPhysicalMaterial({ color: spec.glass, roughness: 0.52, metalness: 0.04, clearcoat: 0.25, clearcoatRoughness: 0.5 }));
  const plateauMat = keep(new T.MeshPhysicalMaterial({ color: spec.plateauCol, roughness: 0.16, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08 }));
  const lensMetal = keep(new T.MeshStandardMaterial({ color: '#c9ccd0', metalness: 1, roughness: 0.22, side: T.DoubleSide }));
  const lensDark = keep(new T.MeshPhysicalMaterial({ color: '#04050a', roughness: 0.03, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }));
  const lensIris = keep(new T.MeshStandardMaterial({ color: '#10163a', emissive: '#2a3a9a', emissiveIntensity: 0.55, roughness: 0.1, metalness: 0.4 }));
  const flashMat = keep(new T.MeshStandardMaterial({ color: '#f4ead2', emissive: '#f4e3b0', emissiveIntensity: 0.25, roughness: 0.3 }));
  const clear = keep(new T.MeshPhysicalMaterial({ color: '#ffffff', transmission: 1, thickness: 1.4, roughness: 0.07, ior: 1.46, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, attenuationColor: new T.Color('#e8f1ff'), attenuationDistance: 60, specularIntensity: 1, envMapIntensity: 1.25 }));
  const rimMat = keep(clear.clone()); rimMat.thickness = 2.2; rimMat.sheen = 1; rimMat.sheenColor = new T.Color(accentHex); rimMat.sheenRoughness = 0.35; rimMat.emissive = new T.Color(accentHex); rimMat.emissiveIntensity = 0.06;
  const toLite = (m: any) => { m.transmission = 0; m.transparent = true; m.opacity = 0.17; m.depthWrite = false; m.needsUpdate = true; };
  if (lite) { toLite(clear); toLite(rimMat); rimMat.opacity = 0.3; }
  const stripMat = keep(new T.MeshBasicMaterial({ color: accentHex, toneMapped: false }));
  const decalMat = keep(new T.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const magnetMat = keep(new T.MeshStandardMaterial({ color: '#d8dade', metalness: 1, roughness: 0.28 }));

  // the phone inside
  const phone = new T.Group(); group.add(phone);
  const b = 0.95;
  { const sh = shapeOf(T, W - 2 * b, H - 2 * b, r - b, sq, 0, 0, 1); const g = new T.ExtrudeGeometry(sh, { depth: TH - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 6, curveSegments: 1 }); g.translate(0, 0, -(TH - 2 * b) / 2); addMesh(phone, g, frameMat); }
  { const g = new T.ShapeGeometry(shapeOf(T, W - 1.5, H - 1.5, r - 0.75, sq, 0, 0, 1.2)); addMesh(phone, g, glassMat, 0, 0, h + 0.02); }
  const tex = screenTexture(T, spec, accentHex); if (tex) keep(tex);
  { const screenMat = keep(new T.MeshPhysicalMaterial({ color: tex ? '#ffffff' : '#07090c', map: tex ?? null, emissive: '#ffffff', emissiveMap: tex ?? null, emissiveIntensity: tex ? 0.62 : 0, roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 }));
    const sh = shapeOf(T, W - 1.7, H - 1.7, r - 0.85, sq, 0, 0, 1.2); const g = new T.ShapeGeometry(sh);
    // map UVs onto the face
    const p = g.attributes.position, uv = new Float32Array(p.count * 2); for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) + (W - 1.7) / 2) / (W - 1.7); uv[i * 2 + 1] = (p.getY(i) + (H - 1.7) / 2) / (H - 1.7); } g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    const m = addMesh(phone, g, screenMat, 0, 0, -h - 0.02); m.rotation.y = Math.PI; m.rotation.z = 0; }

  // side buttons (metal capsules)
  for (const bt of spec.buttons) {
    const g = new T.CapsuleGeometry(1.15, Math.max(1, bt.len - 2.3), 4, 10); const m = addMesh(phone, g, frameMat, (bt.side === 'R' ? 1 : -1) * (W / 2 + 0.05), bt.y, h * 0.18); m.scale.set(0.5, 1, 1.35);
  }

  // camera block
  const topZ = h + 0.02;
  if (spec.plateau) {
    const a = spec.plateau, depth = 0.85, bev = 0.25;
    const sh = shapeOf(T, a.w - 2 * bev, a.h - 2 * bev, a.r - bev, spec.layout === 'pixelBar' ? 2.4 : 3, a.cx, a.cy, 0.8);
    const g = new T.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 4, curveSegments: 1 }); g.translate(0, 0, topZ + bev); addMesh(phone, g, plateauMat);
  }
  const addLens = (x: number, y: number, R: number, z0: number) => {
    const lg = new T.Group(); lg.position.set(x, y, z0); phone.add(lg);
    const prof = [[R, 0], [R, 0.85], [R - 0.3, 1.15], [R - 0.85, 1.15], [R - 1.1, 0.9], [R - 1.1, 0.25]].map((p) => new T.Vector2(p[0], p[1]));
    const ringG = keep(new T.LatheGeometry(prof, 48)); ringG.rotateX(Math.PI / 2); lg.add(new T.Mesh(ringG, lensMetal));
    const disc = (rad: number, z: number, m: any) => { const g = keep(new T.CircleGeometry(rad, 40)); const o = new T.Mesh(g, m); o.position.z = z; lg.add(o); return o; };
    disc(R - 1.1, 0.5, lensDark); const iris = keep(new T.RingGeometry((R - 1.1) * 0.5, (R - 1.1) * 0.62, 40)); const io = new T.Mesh(iris, lensIris); io.position.z = 0.54; lg.add(io);
    disc((R - 1.1) * 0.34, 0.56, lensDark); const glint = keep(new T.CircleGeometry(R * 0.09, 12)); const go = new T.Mesh(glint, keep(new T.MeshBasicMaterial({ color: '#cfd6ff', transparent: true, opacity: 0.8 }))); go.position.set(-R * 0.3, R * 0.3, 0.6); lg.add(go);
  };
  if (spec.pill) { const a = spec.pill, bev = 0.2; const sh = shapeOf(T, a.w - 2 * bev, a.h - 2 * bev, a.r - bev, 2.2, a.cx, a.cy, 0.8); const g = new T.ExtrudeGeometry(sh, { depth: 0.2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 1 }); g.translate(0, 0, topZ + 1.0); addMesh(phone, g, lensDark); }
  const lensZ = spec.layout === 's25' ? topZ : topZ + (spec.layout === 'pixelBar' ? 1.2 : 1.25);
  for (const l of spec.lenses) addLens(l.x, l.y, l.r, lensZ);
  for (const f of spec.flash) { const g = new T.CylinderGeometry(f.r, f.r, 0.4, 24); g.rotateX(Math.PI / 2); addMesh(phone, g, flashMat, f.x, f.y, lensZ + 0.1); }
  if (spec.lidar) { const l = spec.lidar; const g = new T.CylinderGeometry(l.r, l.r, 0.4, 24); g.rotateX(Math.PI / 2); addMesh(phone, g, lensDark, l.x, l.y, lensZ + 0.1); const rg = new T.RingGeometry(l.r * 0.6, l.r * 0.78, 24); addMesh(phone, rg, lensIris, l.x, l.y, lensZ + 0.32); }
  if (spec.magsafe) { // the phone's own magnet ring, seen through the case
    const rg = new T.RingGeometry(27.6, 28.4, 96); addMesh(phone, rg, magnetMat, 0, -4, h + 0.06);
  }

  // the case
  const cs = new T.Group(); group.add(cs);
  const plateTopZ = h + 1.3, rimTopZ = h + 2.1;
  // back plate with camera holes
  { const sh = shapeOf(T, W + 0.6, H + 0.6, r + 0.3, sq, 0, 0, 1);
    for (const c of spec.cutouts) sh.holes.push(pathOf(T, c, c.w === c.h && c.r >= c.w / 2 - 0.01 ? 2 : spec.layout === 'pixelBar' ? 2.4 : 3));
    const g = new T.ExtrudeGeometry(sh, { depth: plateTopZ - (h + 0.25), bevelEnabled: false, curveSegments: 1 }); g.translate(0, 0, h + 0.25); addMesh(cs, g, clear); }
  // guard rings around each camera hole
  for (const c of spec.cutouts) { const circle = c.w === c.h && c.r >= c.w / 2 - 0.01; const n = circle ? 2 : spec.layout === 'pixelBar' ? 2.4 : 3;
    const g = ringGeo(T, grow(c, 1.15), grow(c, 0.0), n, 1.75 - 0.4, 0.2); g.translate(0, 0, h + 0.25 + 0.2); addMesh(cs, g, rimMat); }
  // bumper rim: swept profile with real cut-outs for buttons and the USB-C port
  const lip = 1.4;
  const prof = densify(fillet([[-1.0, plateTopZ], [-1.0, rimTopZ, 0.45], [wall, rimTopZ, 1.0], [wall, -h - 1.3, 1.1], [-lip, -h - 1.3, 0.45], [-lip, -h - 0.05, 0.25], [0, -h - 0.05, 0.1], [0, plateTopZ]]), 0.55);
  const ring = outline(W, H, r, sq, 0.9);
  const cuts: Cut[] = spec.buttons.map((bt) => ({ side: (bt.side === 'R' ? 'R' : 'L') as Pt['side'], c: bt.y, len: bt.len + 3.2, z0: -2.7, z1: h * 0.18 + 2.7 }));
  if (spec.usbc) cuts.push({ side: 'B', c: 0, len: 19, z0: -2.5, z1: 2.5 });
  const rimG = loft(T, ring, prof, cuts, true); addMesh(cs, rimG, rimMat);
  // accent LED line down the outside of the bumper
  const stripZ = (rimTopZ - h - 1.3) / 2 + 0.2 - 0.3;
  const stripG = loft(T, ring, [[wall + 0.04, stripZ - 0.28], [wall + 0.04, stripZ + 0.28]], cuts, false); const strip = addMesh(cs, stripG, stripMat); void strip;

  // MagSafe ring printed on the case
  if (spec.magsafe) {
    const outer = new T.RingGeometry(27.5, 28.5, 128); addMesh(cs, outer, decalMat, 0, -4, plateTopZ + 0.02);
    const dots = new T.RingGeometry(24.2, 24.5, 128); addMesh(cs, dots, decalMat, 0, -4, plateTopZ + 0.02);
  }

  const base = new T.Color(accentHex), tmp = new T.Color();
  return {
    group, owned: disposables, extent: { w: W + 2 * wall, h: H + 2 * wall, d: TH + 5 },
    setLite() { toLite(clear); toLite(rimMat); rimMat.opacity = 0.3; },
    setGlow(color: any, k: number) {
      tmp.copy(base).lerp(color, k); rimMat.emissive.copy(tmp); rimMat.emissiveIntensity = 0.06 + 0.7 * k; rimMat.sheenColor.copy(tmp);
      stripMat.color.copy(tmp).multiplyScalar(0.45 + 0.9 * k);
    },
  };
}
