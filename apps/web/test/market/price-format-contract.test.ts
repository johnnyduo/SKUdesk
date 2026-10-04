// node --test test/market/price-format-contract.test.ts   (from apps/web)
// Every dollar amount on /market comes from ONE helper (src/lib/market-fmt.ts: "$1,296.43"). This source test fails when a market file
// formats a price on its own again (toFixed(2) on cents/100, a local `usd` const, a hand-rolled toLocaleString currency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../src/', import.meta.url);
const comps = readdirSync(new URL('components/market/', root)).filter((f) => /\.(tsx?|jsx?)$/.test(f)).map((f) => 'components/market/' + f);
const libs = readdirSync(new URL('lib/', root)).filter((f) => /^market.*\.ts$/.test(f) && !/\.test\./.test(f)).map((f) => 'lib/' + f);
const FILES = [...comps, ...libs];
const read = (f: string) => readFileSync(new URL(f, root), 'utf8');

// Allowed non-price toFixed(2) uses, as "file :: exact line fragment". Each one is a percentage, a token amount or SVG geometry.
const ALLOW: [string, string][] = [
  ['components/market/mk-fmt.ts', "Math.abs(f * 100).toFixed(2) + '%'"],            // percentage
  ['components/market/Product3D.tsx', "(ch * 100).toFixed(2)}%"],                   // percentage
  ['components/market/SealedBook.tsx', 'const f = (n: number) => n.toFixed(2);'],    // SVG path coordinates in 0..100 viewBox units
  ['components/market/SealedBook.tsx', '(bond / 1e6).toFixed(2)} mUSDG'],           // token amount (6-decimal base units), not dollars
  ['lib/market-view.ts', '(base / 1e6).toFixed(2)'],                                // token amount (bondTokens)
];

test('the market files are discovered (guard against an empty glob)', () => {
  assert.ok(comps.length >= 10 && libs.length >= 8, `${comps.length} components, ${libs.length} libs`);
  assert.ok(FILES.includes('components/market/Product3D.tsx') && FILES.includes('lib/market-view.ts'));
});

test('no market file formats a price with an ad-hoc toFixed(2)', () => {
  const bad: string[] = [];
  for (const f of FILES) for (const [i, line] of read(f).split('\n').entries()) {
    if (!/toFixed\(2\)/.test(line)) continue;
    if (ALLOW.some(([af, frag]) => af === f && line.includes(frag))) continue;
    bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
  }
  assert.deepEqual(bad, []);
});

test('no market file defines its own dollar formatter or divides cents by 100 for display', () => {
  const bad: string[] = [];
  for (const f of FILES) for (const [i, line] of read(f).split('\n').entries()) {
    const code = line.replace(/\/\/.*$/, '');
    if (/\bconst usd\s*=/.test(code) && f !== 'components/market/mk-fmt.ts') bad.push(`${f}:${i + 1}: local usd`);
    if (/\(\s*\w+\s*\/\s*100\s*\)\s*\.(toFixed|toLocaleString)/.test(code)) bad.push(`${f}:${i + 1}: cents/100 formatted by hand`);
    if (/['"`]\$['"`]\s*\+\s*\(/.test(code) || /`\$\$\{\(/.test(code)) bad.push(`${f}:${i + 1}: hand-built "$" string`);
  }
  assert.deepEqual(bad, []);
});

test('mk-fmt usd and the price source line both delegate to the shared helper', () => {
  assert.match(read('components/market/mk-fmt.ts'), /from '\.\.\/\.\.\/lib\/market-fmt(\.ts)?'/);
  assert.match(read('lib/market-view.ts'), /from '\.\/market-fmt\.ts'/);
  assert.doesNotMatch(read('components/market/mk-fmt.ts'), /lib\/run/, 'the market island must not pull the recorded-run module for a formatter');
});

test('the shared helper is pure: no imports', () => {
  assert.doesNotMatch(read('lib/market-fmt.ts'), /^\s*import\s/m);
});

test('chart axis gutter fits a 9 to 10 character price label at 11px mono (about 6.6px per glyph)', () => {
  const m = /const M = \{ l: \d+, r: (\d+)/.exec(read('components/market/PriceChart.tsx'));
  assert.ok(m, 'chart margin constant found');
  const r = Number(m[1]), glyph = 6.6, labelStart = 8;
  assert.ok(labelStart + 10 * glyph <= r, `right gutter ${r}px must hold "$10,000.00" starting ${labelStart}px in (${labelStart + 10 * glyph}px)`);
});
