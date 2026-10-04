// node --test test/market/product3d-specs.test.ts   (from apps/web)
// The market's 3D viewer is keyed ONLY on the market symbol. These tests pin the symbol -> kind table, the fit rule, the accent
// contrast rule and that every kind has 2D fallback art.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KINDS, SYMBOLS, FIT, specForSymbol, fitOf, contrast, accentOnDark } from '../../src/components/market/product3d/specs.ts';
import { ART } from '../../src/components/market/product3d/art.ts';

const EXPECT: Record<string, string> = {
  IP17: 'phone', IP18P: 'phone', S26: 'phone', PX11: 'phone', APP3: 'earbuds', XM6: 'headphones', NSW2: 'handheld',
  Q3S: 'vr', PS5: 'console', MBA13: 'laptop', IPAD: 'tablet', AW12: 'watch',
};

test('every market symbol resolves to its product kind', () => {
  assert.deepEqual([...SYMBOLS].sort(), Object.keys(EXPECT).sort());
  for (const [sym, kind] of Object.entries(EXPECT)) { const s = specForSymbol(sym); assert.equal(s.kind, kind, sym); assert.equal(s.symbol, sym); assert.ok(s.noun.length > 3); }
});

test('symbol lookup ignores case and whitespace; an unknown or missing symbol is a neutral generic device, never a case', () => {
  assert.equal(specForSymbol(' ip17 ').symbol, 'IP17');
  for (const bad of ['', 'NOPE', 'IP16P-CLR-X', 'CASE', undefined, null]) { const s = specForSymbol(bad as any); assert.equal(s.kind, 'generic'); assert.doesNotMatch(s.noun, /case/i); }
});

test('phones are one kind with four distinct camera variants', () => {
  const v = ['IP17', 'IP18P', 'S26', 'PX11'].map((s) => (specForSymbol(s) as any).variant);
  assert.equal(new Set(v).size, 4); assert.ok(v.every(Boolean));
});

test('fitOf: centres any box and scales its longest side to the fit target', () => {
  for (const [min, max] of [[[-1, -2, -3], [5, 6, 7]], [[10, 10, 10], [12, 400, 11]], [[-300, 0, -2], [0, 3, 2]]] as const) {
    const f = fitOf(min as any, max as any);
    const sz = [0, 1, 2].map((i) => (max[i] - min[i]) * f.scale);
    assert.ok(Math.abs(Math.max(...sz) - FIT) < 1e-9, 'longest side = FIT');
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(((min[i] + max[i]) / 2) * f.scale + f.offset[i]) < 1e-9, 'centred axis ' + i);
    assert.deepEqual(f.size.map((x) => +x.toFixed(6)), sz.map((x) => +x.toFixed(6)));
  }
  assert.throws(() => fitOf([0, 0, 0], [0, 0, 0]));
});

test('accentOnDark keeps a bright accent as is and lifts a dark one to at least 4.5:1 on the stage background', () => {
  const BG = '#0a0b0a';
  for (const a of ['#ccff00', '#37d6a0', '#5ec8ff', '#ffb454', '#c792ff', '#ff7a8a', '#1a2a8a', '#000000', '#330000']) {
    const c = accentOnDark(a); assert.match(c, /^#[0-9a-f]{6}$/);
    assert.ok(contrast(c, BG) >= 4.5, `${a} -> ${c} contrast ${contrast(c, BG).toFixed(2)}`);
  }
  assert.equal(accentOnDark('#ccff00'), '#ccff00');
  assert.equal(accentOnDark('not a colour'), accentOnDark('#ccff00'), 'a malformed accent falls back to the default');
});

test('every kind but case has 2D fallback art with an accent element, and DeviceArt renders it (case has CaseArt)', () => {
  const FLAT = KINDS.filter((k) => k !== 'case');
  for (const k of FLAT) {
    const art = ART[k]; assert.ok(art && art.length >= 3, k + ' art');
    assert.ok(art.some((e) => e.c === 'accent'), k + ' art uses the accent');
    for (const e of art) assert.ok(['body', 'trim', 'dark', 'accent'].includes(e.c));
  }
  assert.deepEqual(Object.keys(ART).sort(), [...FLAT].sort());
  const src = readFileSync(new URL('../../src/components/market/product3d/DeviceArt.tsx', import.meta.url), 'utf8');
  for (const n of ['aria-hidden', 'role="img"', 'aria-label', 'ART[']) assert.ok(src.includes(n), 'DeviceArt lost ' + n);
});

test('the viewer is keyed on the symbol only: no keying on compatibility or the market name', () => {
  const dir = new URL('../../src/components/market/', import.meta.url);
  const all = ['Product3D.tsx', 'product3d/scene.ts', 'product3d/build.ts', 'product3d/specs.ts'].map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  assert.doesNotMatch(all, /\bm\.compatibility|specFor\(/, 'no keying on compatibility or on the market name');
  assert.doesNotMatch(all, /\.compatibility|compatibility\?:|as unknown as \{ subtitle/, 'the removed catalog field has no fallback consumer any more');
  assert.match(readFileSync(new URL('Product3D.tsx', dir), 'utf8'), /const sub = m\.subtitle;/, 'the viewer reads the catalog subtitle directly');
});
