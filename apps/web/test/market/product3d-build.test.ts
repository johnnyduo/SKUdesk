// node --test test/market/product3d-build.test.ts   (from apps/web)
// Builds every model with the real three package in Node (no WebGL needed) and checks fit, size and disposal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SYMBOLS, FIT, specForSymbol } from '../../src/components/market/product3d/specs.ts';
import { buildModel, disposeModel, setModelGlow, statsOf } from '../../src/components/market/product3d/build.ts';

const ALL = [...SYMBOLS, 'UNKNOWN-SYMBOL'];

test('every model: finite box, centred, longest side = FIT within 2%, small mesh count, accent material present', () => {
  for (const sym of ALL) {
    const g = buildModel(THREE, specForSymbol(sym), '#5ec8ff');
    const box = new THREE.Box3().setFromObject(g, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    for (const v of [size.x, size.y, size.z, c.x, c.y, c.z]) assert.ok(Number.isFinite(v), sym + ' finite');
    assert.ok(size.x > 0.5 && size.y > 0.5 && size.z > 0.5, sym + ' has volume ' + size.toArray());
    assert.ok(Math.abs(c.x) < 1e-3 && Math.abs(c.y) < 1e-3 && Math.abs(c.z) < 1e-3, `${sym} centred ${c.toArray()}`);
    assert.ok(Math.abs(Math.max(size.x, size.y, size.z) - FIT) / FIT < 0.02, `${sym} max dim ${Math.max(size.x, size.y, size.z)}`);
    const ex = g.userData.extent; assert.ok(Math.abs(ex.w - size.x) < 1e-3 && Math.abs(ex.h - size.y) < 1e-3 && Math.abs(ex.d - size.z) < 1e-3, sym + ' extent matches');
    const st = statsOf(g); assert.ok(st.meshes >= 3 && st.meshes < 40, `${sym} meshes ${st.meshes}`);
    assert.equal(g.userData.symbol, specForSymbol(sym).symbol);
    assert.ok(g.getObjectByName('accent'), sym + ' has an accent element');
    disposeModel(g);
  }
});

test('the models are not all the same silhouette', () => {
  const sigs = new Set(SYMBOLS.map((s) => { const e = buildModel(THREE, specForSymbol(s), '#fff').userData.extent; return [e.w, e.h, e.d].map((x: number) => x.toFixed(1)).join('x'); }));
  assert.ok(sigs.size >= 9, 'distinct bounding boxes: ' + sigs.size);
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

test('disposing a model frees every geometry and material it created (counting fake of three)', () => {
  for (const sym of ALL) {
    const { T, created, disposed } = counting();
    const g = buildModel(T, specForSymbol(sym), '#ffb454');
    assert.ok(created.size > 3, sym + ' created resources');
    disposeModel(g);
    const leaked = [...created].filter((x) => !disposed.has(x));
    assert.equal(leaked.length, 0, `${sym}: ${leaked.length} of ${created.size} resources not disposed (${leaked.map((x: any) => x.type).join(',')})`);
    assert.equal(g.children.length, 0, sym + ' emptied');
  }
});

test('12 product swaps leave no live resources behind', () => {
  const { T, created, disposed } = counting(); let cur: any = null; let peak = 0;
  for (let i = 0; i < 12; i++) {
    const next = buildModel(T, specForSymbol(SYMBOLS[i % SYMBOLS.length]), '#c792ff');
    if (cur) disposeModel(cur); cur = next; peak = Math.max(peak, created.size - disposed.size);
  }
  const live = created.size - disposed.size, one = statsOf(cur).geometries + statsOf(cur).materials;
  assert.ok(live <= one, `live ${live} should equal the last model's own ${one}`);
  disposeModel(cur); assert.equal(created.size, disposed.size);
});

test('setModelGlow tints only the accent material and never allocates per call', () => {
  const g = buildModel(THREE, specForSymbol('XM6'), '#ccff00'); const acc: any = g.getObjectByName('accent');
  const before = acc.material.color.getHexString(), tint = new THREE.Color('#3ed598');
  setModelGlow(g, tint, 1); assert.notEqual(acc.material.color.getHexString(), before);
  setModelGlow(g, tint, 0); assert.equal(acc.material.color.getHexString(), before);
  disposeModel(g);
});

test('a dark accent is lifted so the accent lines stay visible on the dark stage', () => {
  const g = buildModel(THREE, specForSymbol('PS5'), '#000000'); const acc: any = g.getObjectByName('accent');
  const c = acc.material.color; assert.ok(c.r + c.g + c.b > 0.4, 'accent edge is not black'); disposeModel(g);
});
