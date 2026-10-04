// Run: node --test apps/web/src/lib/market-fmt.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsdCents, NO_PRICE } from './market-fmt.ts';

test('fmtUsdCents: thousands separators and exactly 2 decimals', () => {
  assert.equal(fmtUsdCents(129643), '$1,296.43');
  assert.equal(fmtUsdCents(119900), '$1,199.00');
  assert.equal(fmtUsdCents(899), '$8.99');
  assert.equal(fmtUsdCents(0), '$0.00');
  assert.equal(fmtUsdCents(1), '$0.01');
  assert.equal(fmtUsdCents(99999), '$999.99');
  assert.equal(fmtUsdCents(100000), '$1,000.00');
  assert.equal(fmtUsdCents(123456789), '$1,234,567.89');
});
test('fmtUsdCents: negative amounts keep the sign in front of the dollar sign', () => {
  assert.equal(fmtUsdCents(-129643), '-$1,296.43');
  assert.equal(fmtUsdCents(-1), '-$0.01');
  assert.equal(fmtUsdCents(-0), '$0.00');
});
test('fmtUsdCents: fractional cents (chart axis midpoints) round to a whole cent', () => {
  assert.equal(fmtUsdCents(100050.5), '$1,000.51');
  assert.equal(fmtUsdCents(100.5), '$1.01');
});
test('fmtUsdCents: non-finite input is a dash, never "$NaN"', () => {
  for (const v of [NaN, Infinity, -Infinity, undefined as unknown as number]) assert.equal(fmtUsdCents(v), NO_PRICE);
  assert.equal(NO_PRICE, '—');
});
