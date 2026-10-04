// node --test test/market/panel-header-css.test.ts   (from apps/web)
// Source pin for the panel headers (Trades / Recent epochs / Markets): .mk-panel has overflow:hidden, so a header whose right group (provenance chip +
// symbol, nowrap) is wider than the panel would be cut off at the right edge (seen on Trades at 1280 px with a long symbol such as IP16PM-CLR).
// The header must wrap (the right group drops to its own line, right-aligned) and the right group must be allowed to shrink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/components/market/market.css', import.meta.url), 'utf8');
const rule = (sel: string) => new RegExp('(?:^|\\n)' + sel.replace(/[.\-]/g, '\\$&') + '\\{([^}]*)\\}').exec(css)?.[1] ?? '';

test('.mk-ph wraps instead of clipping, and its title never shrinks to nothing', () => {
  const ph = rule('.mk-ph');
  assert.match(ph, /display:flex/); assert.match(ph, /flex-wrap:wrap/);
  assert.match(rule('.mk-ph h2'), /flex:0 0 auto/);
});

test('.mk-ph-r (chip + symbol) can shrink and wrap inside its row, right-aligned, and the chip itself stays a nowrap tag', () => {
  const r = rule('.mk-ph-r');
  assert.match(r, /min-width:0/); assert.match(r, /max-width:100%/); assert.match(r, /flex-wrap:wrap/); assert.match(r, /margin-left:auto/);
  assert.match(r, /justify-content:flex-end/);
  assert.match(readFileSync(new URL('../../src/styles/global.css', import.meta.url), 'utf8'), /\.prov\{[^}]*white-space:nowrap/, 'the chip is unchanged: a compact nowrap tag');
});
