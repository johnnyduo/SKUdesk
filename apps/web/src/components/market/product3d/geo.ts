// Small geometry helpers shared by the model builders. three is passed in (lazy-loaded by the component); nothing here touches the DOM.

/** A rounded rectangle (w x h, corner r) in the XY plane, centred on (cx, cy). */
export function rrShape(T: any, w: number, h: number, r: number, cx = 0, cy = 0) {
  const s = new T.Shape(); const x = cx - w / 2, y = cy - h / 2; r = Math.max(0.01, Math.min(r, w / 2, h / 2));
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** A rounded box w (x) x h (y) x d (z), corner radius r in the XY plane, soft edges of radius bev, centred on the origin. */
export function rbox(T: any, w: number, h: number, d: number, r: number, bev = 0.6) {
  bev = Math.min(bev, d / 2 - 0.01, w / 2 - 0.01, h / 2 - 0.01);
  const g = new T.ExtrudeGeometry(rrShape(T, w - 2 * bev, h - 2 * bev, Math.max(0.05, r - bev)), { depth: d - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 8 });
  g.translate(0, 0, -(d - 2 * bev) / 2); return g;
}

/** A flat rounded plate in the XY plane, thickness t from z = 0 to z = t (no bevel). */
export function plate(T: any, w: number, h: number, r: number, t: number, cx = 0, cy = 0) {
  return new T.ExtrudeGeometry(rrShape(T, w, h, r, cx, cy), { depth: t, bevelEnabled: false, curveSegments: 8 });
}

/** A rounded-rectangle ring (outer w x h, line width lw) in the XY plane, thickness t from z = 0 to z = t. */
export function ring(T: any, w: number, h: number, r: number, lw: number, t: number) {
  const s = rrShape(T, w, h, r); s.holes.push(rrShape(T, w - 2 * lw, h - 2 * lw, Math.max(0.05, r - lw)));
  return new T.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 8 });
}

/** A flat panel in the XY plane facing +z whose vertex colours fade from `bottom` to `top` (a calm screen gradient, no artwork). */
export function gradientPanel(T: any, w: number, h: number, r: number, bottom: any, top: any) {
  const g = new T.ShapeGeometry(rrShape(T, w, h, r), 8), p = g.attributes.position, col = new Float32Array(p.count * 3), c = new T.Color();
  for (let i = 0; i < p.count; i++) { c.copy(bottom).lerp(top, Math.max(0, Math.min(1, (p.getY(i) + h / 2) / h))); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new T.BufferAttribute(col, 3)); return g;
}

/** Many axis-aligned boxes (cx, cy, cz, w, h, d) merged into ONE geometry (keys of a keyboard). */
export function mergeBoxes(T: any, boxes: number[][]) {
  const tpl = new T.BoxGeometry(1, 1, 1), P = tpl.attributes.position, N = tpl.attributes.normal, I = tpl.index!, n = P.count;
  const pos = new Float32Array(n * 3 * boxes.length), nor = new Float32Array(n * 3 * boxes.length), idx = new Uint32Array(I.count * boxes.length);
  boxes.forEach(([cx, cy, cz, w, h, d], b) => {
    for (let i = 0; i < n; i++) { const o = (b * n + i) * 3; pos[o] = P.getX(i) * w + cx; pos[o + 1] = P.getY(i) * h + cy; pos[o + 2] = P.getZ(i) * d + cz; nor[o] = N.getX(i); nor[o + 1] = N.getY(i); nor[o + 2] = N.getZ(i); }
    for (let i = 0; i < I.count; i++) idx[b * I.count + i] = I.getX(i) + b * n;
  });
  tpl.dispose();
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('normal', new T.BufferAttribute(nor, 3)); g.setIndex(new T.BufferAttribute(idx, 1));
  return g;
}

/**
 * A flat band swept along a path: `pts` (array of [x, y, z]) smoothed with a Catmull-Rom curve, `width` along the fixed `side` axis,
 * `thick` along the path normal. Used for straps (watch band, VR head strap).
 */
export function ribbon(T: any, pts: number[][], width: number, thick: number, side: [number, number, number], closed = false, steps = 64) {
  const curve = new T.CatmullRomCurve3(pts.map((p) => new T.Vector3(p[0], p[1], p[2])), closed, 'catmullrom', 0.5);
  const S = new T.Vector3(...side), pos: number[] = [], idx: number[] = [], tan = new T.Vector3(), nrm = new T.Vector3(), a = new T.Vector3();
  const rings: number[][][] = [], count = closed ? steps : steps + 1;
  for (let i = 0; i < count; i++) {
    const u = i / steps, p = curve.getPointAt(Math.min(1, u)); curve.getTangentAt(Math.min(1, u), tan); nrm.crossVectors(S, tan).normalize();
    const w = width / 2, t = thick / 2, corners = [[-w, -t], [w, -t], [w, t], [-w, t]];
    rings.push(corners.map(([sw, tn]) => { a.copy(p).addScaledVector(S, sw).addScaledVector(nrm, tn); return [a.x, a.y, a.z]; }));
  }
  // 4 faces per segment, each with its own vertices so the edges stay crisp
  const segs = closed ? count : count - 1;
  for (let i = 0; i < segs; i++) {
    const A = rings[i], B = rings[(i + 1) % count];
    for (let f = 0; f < 4; f++) {
      const f2 = (f + 1) % 4, base = pos.length / 3;
      pos.push(...A[f], ...A[f2], ...B[f2], ...B[f]); idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/**
 * A thin curved plate: an (nu+1) x (nv+1) grid evaluated by `f(u, v)` (u, v in 0..1 -> [x, y, z]), given thickness `t` along x
 * (outer surface, inner surface and four border walls, one closed solid). Used for the console faceplates.
 */
export function sheet(T: any, nu: number, nv: number, f: (u: number, v: number) => number[], t: number) {
  const pos: number[] = [], idx: number[] = [], n = (nu + 1) * (nv + 1), id = (i: number, j: number) => j * (nu + 1) + i;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) pos.push(...f(i / nu, j / nv));
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) pos.push(pos[id(i, j) * 3] + t, pos[id(i, j) * 3 + 1], pos[id(i, j) * 3 + 2]);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
    idx.push(a, b, c, a, c, d, n + a, n + c, n + b, n + a, n + d, n + c);
  }
  const wall = (a: number, b: number) => idx.push(a, b, n + b, a, n + b, n + a);
  for (let i = 0; i < nu; i++) { wall(id(i, 0), id(i + 1, 0)); wall(id(i + 1, nv), id(i, nv)); }
  for (let j = 0; j < nv; j++) { wall(id(0, j + 1), id(0, j)); wall(id(nu, j), id(nu, j + 1)); }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
