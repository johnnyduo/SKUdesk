// node --test test/market/product3d-case.test.ts   (from apps/web)
// The six clear phone-case markets (category Accessories): the original clear-case model with a lit phone inside, keyed by symbol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ALL_SYMBOLS, CASE_SYMBOLS, SYMBOLS, FIT, KINDS, specForSymbol } from '../../src/components/market/product3d/specs.ts';
import { caseSpecForSymbol, specFor, CASE_WALL } from '../../src/components/market/product3d/casespec.ts';
import { buildModel, disposeModel, setModelGlow, setModelLite, statsOf } from '../../src/components/market/product3d/build.ts';

const SIX = ['IP16P-CLR', 'IP16PM-CLR', 'IP15P-CLR', 'IP16-CLR', 'S25-CLR', 'PX9-CLR'];
const rd = (f: string) => readFileSync(new URL('../../src/' + f, import.meta.url), 'utf8');

test('all 18 symbols resolve to a kind: 6 case + 12 device; the case symbols are exactly the six', () => {
  assert.deepEqual([...CASE_SYMBOLS], SIX);
  assert.equal(ALL_SYMBOLS.length, 18); assert.equal(new Set(ALL_SYMBOLS).size, 18);
  assert.ok(KINDS.includes('case'));
  for (const s of SIX) { const sp = specForSymbol(s); assert.equal(sp.kind, 'case', s); assert.equal(sp.symbol, s); assert.match(sp.noun, /phone case/); assert.match(sp.noun, /phone inside/); }
  for (const s of SYMBOLS) assert.notEqual(specForSymbol(s).kind, 'case', s + ' stays a device');
  assert.equal(specForSymbol(' px9-clr ').symbol, 'PX9-CLR');
  assert.equal(specForSymbol('PX9').kind, 'generic', 'unknown symbols are still the neutral generic device');
});

test('every symbol in the catalog resolves to its own model (not the generic device)', () => {
  const cat = JSON.parse(rd('data/catalog.json')) as { markets: { symbol: string; category?: string }[] };
  assert.ok(cat.markets.length >= 12);
  for (const m of cat.markets) { const sp = specForSymbol(m.symbol); assert.notEqual(sp.kind, 'generic', m.symbol); assert.ok(ALL_SYMBOLS.includes(m.symbol), m.symbol);
    if (m.category === 'Accessories') assert.equal(sp.kind, 'case', m.symbol + ' is an Accessories case'); else assert.notEqual(sp.kind, 'case', m.symbol); }
});

test('each symbol keeps the body size and camera layout it had before the cases were replaced', () => {
  const EXPECT: Record<string, [string, number, number]> = { // layout, W, H (mm)
    'IP16P-CLR': ['tripleSquare', 71.5, 149.6], 'IP16PM-CLR': ['tripleSquare', 77.6, 163], 'IP15P-CLR': ['tripleSquare', 70.6, 146.6],
    'IP16-CLR': ['dualPill', 71.6, 147.6], 'S25-CLR': ['s25', 70.5, 146.9], 'PX9-CLR': ['pixelBar', 72, 152.8],
  };
  for (const [sym, [layout, W, H]] of Object.entries(EXPECT)) { const c = caseSpecForSymbol(sym); assert.equal(c.layout, layout, sym); assert.equal(c.W, W, sym); assert.equal(c.H, H, sym); }
  assert.equal(caseSpecForSymbol('IP16P-CLR').magsafe, true); assert.equal(caseSpecForSymbol('IP16-CLR').magsafe, true);
  assert.equal(caseSpecForSymbol('S25-CLR').magsafe, false); assert.equal(caseSpecForSymbol('PX9-CLR').magsafe, false);
  assert.equal(caseSpecForSymbol('IP16P-CLR').key, 'ip16p'); assert.equal(caseSpecForSymbol('IP16PM-CLR').key, 'ip16pm'); assert.equal(caseSpecForSymbol('IP15P-CLR').key, 'ip15p');
  assert.deepEqual(caseSpecForSymbol('S25-CLR'), specFor('Galaxy S25', 'Galaxy S25 Clear Case'));
  assert.equal(CASE_WALL, 1.6);
});

test('case models: finite box, centred, longest side = FIT within 2%, small mesh count, glow and lite hooks, no accent-material dependency', () => {
  for (const sym of SIX) {
    const g = buildModel(THREE, specForSymbol(sym), '#5ec8ff');
    const box = new THREE.Box3().setFromObject(g, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    for (const v of [size.x, size.y, size.z, c.x, c.y, c.z]) assert.ok(Number.isFinite(v), sym + ' finite');
    assert.ok(size.x > 40 && size.y > 100 && size.z > 5, sym + ' phone-case proportions ' + size.toArray());
    assert.ok(Math.abs(c.x) < 1e-3 && Math.abs(c.y) < 1e-3 && Math.abs(c.z) < 1e-3, `${sym} centred ${c.toArray()}`);
    assert.ok(Math.abs(Math.max(size.x, size.y, size.z) - FIT) / FIT < 0.02, sym + ' fit');
    const ex = g.userData.extent; assert.ok(Math.abs(ex.w - size.x) < 1e-3 && Math.abs(ex.h - size.y) < 1e-3 && Math.abs(ex.d - size.z) < 1e-3, sym + ' extent matches');
    const st = statsOf(g); assert.ok(st.meshes >= 15 && st.meshes <= 40, `${sym} meshes ${st.meshes}`);
    assert.equal(g.userData.kind, 'case'); assert.equal(g.userData.symbol, sym); assert.equal(g.name, 'model:' + sym);
    assert.equal(typeof g.userData.setGlow, 'function'); assert.equal(typeof g.userData.setLite, 'function');
    disposeModel(g);
  }
});

test('the case glow tints the rim and the LED line; lite swaps the transmissive plastic for plain transparency; both are safe on a disposed model', () => {
  const g = buildModel(THREE, specForSymbol('IP16P-CLR'), '#ccff00');
  const mats = new Set<any>(); g.traverse((o: any) => { if (o.material) mats.add(o.material); });
  const trans = () => [...mats].filter((m: any) => m.transmission > 0).length, rim = [...mats].find((m: any) => m.sheen === 1) as any;
  assert.ok(trans() >= 2, 'clear plastic is transmissive'); const e0 = rim.emissive.getHexString();
  setModelGlow(g, new THREE.Color('#3ed598'), 1); assert.notEqual(rim.emissive.getHexString(), e0); setModelGlow(g, new THREE.Color('#3ed598'), 0); assert.equal(rim.emissive.getHexString(), e0);
  setModelLite(g); assert.equal(trans(), 0, 'lite: no transmission pass');
  disposeModel(g); setModelGlow(g, new THREE.Color('#fff'), 0.5); setModelLite(g);
  const d = buildModel(THREE, specForSymbol('XM6'), '#fff'); setModelLite(d); assert.ok(d.getObjectByName('accent'), 'lite is a no-op on a device'); disposeModel(d);
});

/** three with every Geometry / Material / Texture class wrapped so each instance is recorded when created and when disposed. */
function counting() {
  const created = new Set<any>(), disposed = new Set<any>(), T: any = { ...THREE };
  for (const [k, V] of Object.entries(THREE) as [string, any][]) {
    if (typeof V === 'function' && /(Geometry|Material|Texture)$/.test(k) && k !== 'BufferGeometry' && k !== 'Material' && k !== 'Texture') {
      T[k] = class extends V { constructor(...a: any[]) { super(...a); created.add(this); const d = this.dispose.bind(this); this.dispose = () => { disposed.add(this); d(); }; } };
    }
  }
  return { T, created, disposed };
}
/** A minimal DOM canvas so the case builds its lock-screen texture (and disposal of it is tested) without a browser. */
function withFakeCanvas<R>(f: () => R): R {
  const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
  const g = globalThis as any, had = 'document' in g, old = g.document;
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  try { return f(); } finally { if (had) g.document = old; else delete g.document; }
}

test('disposing a case frees every geometry, material and texture it created, including the lock-screen texture (counting fake)', () => {
  for (const withDom of [false, true]) for (const sym of SIX) {
    const { T, created, disposed } = counting();
    const g = withDom ? withFakeCanvas(() => buildModel(T, specForSymbol(sym), '#ffb454')) : buildModel(T, specForSymbol(sym), '#ffb454');
    assert.ok(created.size > 20, sym + ' created resources');
    if (withDom) assert.ok([...created].some((x: any) => x.isTexture), sym + ' built the screen texture');
    disposeModel(g);
    const leaked = [...created].filter((x) => !disposed.has(x));
    assert.equal(leaked.length, 0, `${sym}${withDom ? ' (with texture)' : ''}: ${leaked.length} of ${created.size} not disposed (${leaked.map((x: any) => x.type).join(',')})`);
    assert.equal(g.children.length, 0, sym + ' emptied'); disposeModel(g); // twice is safe
  }
});

test('12 swaps across cases and devices (case<->device included) leave nothing live', () => {
  const order = ['IP16P-CLR', 'XM6', 'S25-CLR', 'IP17', 'PX9-CLR', 'PS5', 'IP16PM-CLR', 'APP3', 'IP15P-CLR', 'AW12', 'IP16-CLR', 'PX11'];
  withFakeCanvas(() => {
    const { T, created, disposed } = counting(); let cur: any = null;
    for (let i = 0; i < 12; i++) {
      const next = buildModel(T, specForSymbol(order[i]), '#c792ff');
      if (cur) disposeModel(cur); cur = next;
      const live = created.size - disposed.size, own = cur.userData.owned.length;
      assert.ok(live <= own, `swap ${i} (${order[i]}): live ${live} should be the current model's own ${own}`);
    }
    disposeModel(cur); assert.equal(created.size, disposed.size, 'nothing live after the last dispose');
  });
});

test('wiring: Product3D labels the case, shows the accessory chip for case only, DeviceArt draws CaseArt, scene honours lite', () => {
  const comp = rd('components/market/Product3D.tsx');
  assert.match(comp, /Rotatable 3D model of \$\{[^}]*name\}/);
  assert.match(comp, /spec\.kind === 'case' && <div className="p3d-chip" aria-hidden="true">Accessory · shown with a phone inside<\/div>/);
  assert.match(comp, /data-model=\{m\.symbol\} data-kind=\{spec\.kind\}/);
  assert.match(comp, /<DeviceArt kind=\{spec\.kind\} symbol=\{spec\.symbol\}/);
  const art = rd('components/market/product3d/DeviceArt.tsx');
  assert.match(art, /kind === 'case'\) return <CaseArt spec=\{caseSpecForSymbol\(symbol\)\}/);
  const css = rd('components/market/product3d.css'); assert.match(css, /\.p3d-chip\{/);
  const scene = rd('components/market/product3d/scene.ts'); assert.match(scene, /setModelLite\(model\)/g);
  assert.equal((scene.match(/setModelLite\(model\)/g) ?? []).length, 2, 'applied on goLite and on every swap while lite');
});
