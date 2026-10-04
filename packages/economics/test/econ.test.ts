import { test } from 'node:test';
import assert from 'node:assert/strict';
import { economics, verifyProof, type EconInputCents } from '../index.ts';

const hero: EconInputCents = { purchaseCents: 590, inboundShipCents: 42, importDutyCents: 12, taxCents: 8, procurementFeeCents: 5, paymentFeeCents: 2, sellCents: 1099, marketplaceFeeBps: 800, fulfillmentCents: 65, returnReserveBps: 200, chainCostCents: 4, units: 240, fixedBatchCents: 1800 };

test('hero case matches Solidity-verified values', () => {
  const r = economics(hero);
  assert.equal(r.landedCents, 659);
  assert.equal(r.mktFeeCents, 88);
  assert.equal(r.retCents, 22);
  assert.equal(r.netCents, 261);
  assert.equal(r.marginBps, 2374);
  assert.equal(r.breakevenCents, 838);
  assert.equal(r.maxBuyCents, 769);
  assert.equal(r.batchCents, 60840);
  assert.equal(verifyProof(hero, r).ok, true);
});

test('loss-making case clamps marginBps and maxBuy to 0 (EconLib parity)', () => {
  const loss = { ...hero, purchaseCents: 2000, sellCents: 1099 };
  const r = economics(loss);
  assert.ok(r.netCents < 0);
  assert.equal(r.marginBps, 0);
  assert.ok(r.maxBuyCents >= 0);
  assert.ok(r.batchCents < 0); // batch is not clamped
});

test('maxBuy clamps to 0 when fees exceed breakeven headroom', () => {
  // sell price tiny: breakeven (landed+fees) vs other landed costs; purchase 0 -> maxBuy never negative
  const r = economics({ ...hero, purchaseCents: 0, sellCents: 0 });
  assert.ok(r.maxBuyCents >= 0);
  assert.equal(r.marginBps, 0);
});

test('F-E2: breakEvenBuyCents is the exact break-even purchase price (hero: 851), unlike the EconLib-parity maxBuyCents (769)', () => {
  const r = economics(hero);
  assert.equal(r.maxBuyCents, 769); // parity field with EconLib.maxBuy, NOT a break-even price
  assert.equal(r.breakEvenBuyCents, 851); // purchase 590 + net 261
  assert.equal(economics({ ...hero, purchaseCents: 851 }).netCents, 0);
  assert.equal(economics({ ...hero, purchaseCents: 852 }).netCents, -1);
});

test('F-E2: breakEvenBuyCents is the largest purchase price with net >= 0 (and 0 when no purchase price works)', () => {
  for (const sellCents of [300, 700, 1099, 5000]) for (const purchaseCents of [0, 1, 590, 2000]) {
    const c = { ...hero, sellCents, purchaseCents };
    const b = economics(c).breakEvenBuyCents;
    if (b > 0 || economics({ ...c, purchaseCents: 0 }).netCents >= 0) {
      assert.ok(economics({ ...c, purchaseCents: b }).netCents >= 0, `net at ${b}`);
      assert.ok(economics({ ...c, purchaseCents: b + 1 }).netCents < 0, `net at ${b + 1}`);
    }
  }
  const hopeless = economics({ ...hero, sellCents: 100, purchaseCents: 0 });
  assert.ok(hopeless.netCents < 0);
  assert.equal(hopeless.breakEvenBuyCents, 0);
});

test('F-E1: the mirror is exact up to sellCents 9e11 and throws a RangeError above it', () => {
  const at = economics({ ...hero, sellCents: 9e11, marketplaceFeeBps: 9999, returnReserveBps: 1 });
  assert.equal(at.mktFeeCents, 899_910_000_000); // ceil(9e11 * 9999 / 1e4), matches the BigInt/EconLib value
  assert.throws(() => economics({ ...hero, sellCents: 9e11 + 1 }), (e: unknown) => e instanceof RangeError && /sellCents above 9e11 is outside the exact TS domain/.test((e as Error).message));
  assert.throws(() => economics({ ...hero, sellCents: 1e12, marketplaceFeeBps: 9999 }), RangeError);
});
