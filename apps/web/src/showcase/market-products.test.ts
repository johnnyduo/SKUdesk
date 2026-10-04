import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_PRODUCTS, fmtList, listLine } from './market-products.ts';

test('fmtList formats integer cents with thousands separators and two decimals', () => {
  assert.equal(fmtList(119900), '$1,199.00');
  assert.equal(fmtList(99999), '$999.99');
  assert.equal(fmtList(24900), '$249.00');
  assert.equal(fmtList(5), '$0.05');
  assert.equal(fmtList(129900), '$1,299.00');
  assert.equal(fmtList(100000000), '$1,000,000.00');
});

test('the ring shows seven distinct market products from five categories, with whole-cent list prices', () => {
  assert.equal(MARKET_PRODUCTS.length, 7);
  assert.equal(new Set(MARKET_PRODUCTS.map((p) => p.symbol)).size, 7);
  assert.equal(new Set(MARKET_PRODUCTS.map((p) => p.name)).size, 7);
  assert.equal(new Set(MARKET_PRODUCTS.map((p) => p.category)).size, 5);
  for (const p of MARKET_PRODUCTS) assert.ok(Number.isInteger(p.listCents) && p.listCents > 0, p.symbol);
});

test('neighbouring ring tiles are never the same category twice in a row, and neither end is a phone (the on-chain run, a phone case, sits between them)', () => {
  assert.notEqual(MARKET_PRODUCTS[0].category, 'Phones');
  assert.notEqual(MARKET_PRODUCTS[MARKET_PRODUCTS.length - 1].category, 'Phones');
  MARKET_PRODUCTS.forEach((p, i) => { if (i > 0) assert.notEqual(p.category, MARKET_PRODUCTS[i - 1].category, `${MARKET_PRODUCTS[i - 1].symbol} -> ${p.symbol}`); });
});

test('the caption names the category and says list price, never live or street', () => {
  for (const p of MARKET_PRODUCTS) {
    const line = listLine(p);
    assert.match(line, /^(Phones|Audio|Gaming|Computing|Wearables) · US list price \$[\d,]+\.\d\d$/);
    assert.doesNotMatch(line, /live|street|market price/i);
  }
});
