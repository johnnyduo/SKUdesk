// One entry point for the viewer: buildModel(T, spec, accent) returns a THREE.Group holding the product for that spec, scaled and
// centred by fitOf so that every product fills the stage the same way. three is passed in (lazy-loaded by the component).
// Everything is procedural (no canvas textures, no DOM), so the factories also run in Node for the unit tests.
import { accentOnDark, fitOf, type Spec } from './specs.ts';
import { buildPhone } from './phone.ts';
import { DEVICES } from './devices.ts';
import { buildCase } from './case.ts';
import { caseSpecForSymbol } from './casespec.ts';

/** What the builders get: the group to fill, the owned resources and the shared materials. */
export type Ctx = {
  T: any; root: any; spec: Spec;
  /** register a geometry or material for disposal and return it */
  keep: <X>(x: X) => X;
  /** add a mesh (geometry is registered for disposal) */
  add: (geo: any, mat: any, x?: number, y?: number, z?: number, parent?: any) => any;
  m: Mats;
};
export type Mats = { metal: (c: string, rough?: number) => any; paint: (c: string, rough?: number) => any; soft: (c: string) => any; glass: any; dark: any; screen: any; accent: any };

export type ModelInfo = { symbol: string; kind: string; extent: { w: number; h: number; d: number }; owned: any[]; accentBase: any; accentMat: any };

function makeCtx(T: any, spec: Spec, accentHex: string): Ctx {
  const root = new T.Group(), owned: any[] = [];
  const keep = <X,>(x: X): X => { owned.push(x); return x; };
  const cache = new Map<string, any>();
  const cached = (k: string, f: () => any) => { let v = cache.get(k); if (!v) { v = keep(f()); cache.set(k, v); } return v; };
  const m: Mats = {
    metal: (c, rough = 0.34) => cached('m' + c + rough, () => new T.MeshStandardMaterial({ color: c, metalness: 0.88, roughness: rough })),
    paint: (c, rough = 0.42) => cached('p' + c + rough, () => new T.MeshStandardMaterial({ color: c, metalness: 0.08, roughness: rough })),
    soft: (c) => cached('s' + c, () => new T.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.92, side: T.DoubleSide })),
    glass: cached('glass', () => new T.MeshPhysicalMaterial({ color: '#05070a', roughness: 0.1, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 })),
    dark: cached('dark', () => new T.MeshStandardMaterial({ color: '#111317', metalness: 0.3, roughness: 0.5 })),
    screen: cached('screen', () => new T.MeshBasicMaterial({ vertexColors: true })),
    accent: cached('accent', () => new T.MeshBasicMaterial({ color: accentOnDark(accentHex), toneMapped: false })),
  };
  const add = (geo: any, mat: any, x = 0, y = 0, z = 0, parent: any = root) => { const o = new T.Mesh(keep(geo), mat); o.position.set(x, y, z); parent.add(o); return o; };
  root.userData.owned = owned;
  return { T, root, spec, keep, add, m };
}

/** The product for one spec, centred on the origin with its longest side = FIT. userData: { symbol, kind, extent: { w, h, d }, ... }. */
export function buildModel(T: any, spec: Spec, accentHex: string): any {
  if (spec.kind === 'case') return fitted(T, spec, buildCase(T, caseSpecForSymbol(spec.symbol), accentHex));
  const ctx = makeCtx(T, spec, accentHex), inner = ctx.root;
  if (spec.kind === 'phone') buildPhone(ctx); else DEVICES[spec.kind](ctx);
  return fitted(T, spec, { group: inner, owned: inner.userData.owned, accentMat: ctx.m.accent });
}

/** Centre and scale a built product and attach what the scene needs. A case has no single accent material: it brings its own setGlow / setLite. */
function fitted(T: any, spec: Spec, built: { group: any; owned: any[]; accentMat?: any; setGlow?: (c: any, k: number) => void; setLite?: () => void }): any {
  const inner = built.group;
  inner.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(inner, true), f = fitOf(box.min.toArray(), box.max.toArray());
  const group = new T.Group(); group.add(inner); inner.scale.setScalar(f.scale); inner.position.set(...f.offset);
  // accents get a name so the glow pulse (and tests) can find them
  const accentMat = built.accentMat;
  if (accentMat) inner.traverse((o: any) => { if (o.material === accentMat && !group.userData.named) { o.name = 'accent'; group.userData.named = true; } });
  Object.assign(group.userData, { symbol: spec.symbol, kind: spec.kind, extent: { w: f.size[0], h: f.size[1], d: f.size[2] }, owned: built.owned, accentMat: accentMat ?? null, accentBase: accentMat ? accentMat.color.clone() : null });
  if (built.setGlow) group.userData.setGlow = built.setGlow;
  if (built.setLite) group.userData.setLite = built.setLite;
  group.name = 'model:' + spec.symbol;
  return group;
}

/** Tint the accent toward `color` by k (0..1) for the price-tick pulse. No allocation. */
export function setModelGlow(group: any, color: any, k: number) {
  const u = group.userData; if (u.setGlow) u.setGlow(color, k); else if (u.accentMat) u.accentMat.color.copy(u.accentBase).lerp(color, k);
}

/** Free every geometry and material the model owns and empty the group. Safe to call twice. */
export function disposeModel(group: any) {
  const owned: any[] = group.userData.owned || [];
  group.traverse((o: any) => { if (o.geometry && !owned.includes(o.geometry)) owned.push(o.geometry); const m = o.material; if (m) for (const x of Array.isArray(m) ? m : [m]) if (!owned.includes(x)) owned.push(x); });
  for (const x of owned) { x.map?.dispose?.(); x.dispose?.(); }
  group.userData.owned = []; group.userData.accentMat = null; group.userData.setGlow = group.userData.setLite = null; group.clear();
}

/** Counts for the tests and the debug hook. */
export function statsOf(group: any) {
  let meshes = 0; const g = new Set(), m = new Set();
  group.traverse((o: any) => { if (o.isMesh) { meshes++; g.add(o.geometry); m.add(o.material); } });
  return { meshes, geometries: g.size, materials: m.size };
}

/** Cheaper clear plastic (no transmission pass) for software GPUs. Only the case has transmissive plastic; for every other kind this does nothing. */
export function setModelLite(group: any) { group.userData.setLite?.(); }
