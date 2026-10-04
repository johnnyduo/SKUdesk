// node --test apps/web/src/lib/products.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { keccak256, toHex } from 'viem';
import { CatalogSource, fromMerchantProduct } from './products.ts';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));

test('catalog source lists every market with a marketId equal to keccak256(id)', async () => {
  const ps = await new CatalogSource(catalog).list();
  assert.equal(ps.length, catalog.markets.length); assert.equal(ps.length, 18);
  for (const p of ps) { assert.equal(p.marketId, keccak256(toHex(p.id))); assert.ok(p.referenceCents > 0 && Number.isInteger(p.referenceCents)); assert.ok(p.tick >= 1); assert.ok(p.category && p.subtitle && p.priceBasis && p.lot, p.symbol); }
  assert.deepEqual([...new Set(ps.map((p) => p.category))], ['Phones', 'Audio', 'Gaming', 'Computing', 'Wearables', 'Accessories']);
  assert.equal(new Set(ps.map((p) => p.symbol)).size, ps.length, 'symbols are unique');
});
test('the market lists twelve consumer products first, then the six phone-case Accessories; the case the vault lot is about keeps its market id', async () => {
  const ps = await new CatalogSource(catalog).list();
  assert.deepEqual(ps.slice(0, 12).map((p) => p.category === 'Accessories'), Array(12).fill(false));
  assert.deepEqual(ps.slice(12).map((p) => p.category), Array(6).fill('Accessories'));
  const c = ps.find((p) => p.id === 'CASE-IP16PRO-CLEAR-MAG-001');
  assert.ok(c, 'the first book market is listed again');
  assert.equal(c.marketId, keccak256(toHex('CASE-IP16PRO-CLEAR-MAG-001')));
  assert.equal(c.lot, 'bulk'); assert.equal(c.priceBasis, 'Catalog reference price (fixed snapshot, not a live feed)');
  assert.equal(ps[0].symbol, 'IP18P');
});
test('merchant mapping converts micros to integer cents and refuses non-USD', () => {
  const p = fromMerchantProduct({ name: 'accounts/1/products/x', offerId: 'sku-123', title: 'Device', price: { amountMicros: '10990000', currencyCode: 'USD' } });
  assert.equal(p.referenceCents, 1099); assert.equal(p.source, 'merchant'); assert.equal(p.category, ''); assert.equal(p.lot, 'bulk');
  assert.throws(() => fromMerchantProduct({ name: 'n', offerId: 's', title: 't', price: { amountMicros: '1', currencyCode: 'THB' } }), /USD only/);
});
