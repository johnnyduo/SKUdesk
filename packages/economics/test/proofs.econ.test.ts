// Executable cross-checks (not a formal verification) for docs/proofs/economics.md (theorems E1, E3, E7 and findings F-E1, F-E2, F-E3).
// Run: node --test packages/economics/test/proofs.econ.test.ts
// The BigInt reference and the vector generator live in packages/contracts/test/vectors/gen-econ-vectors.mjs; the SAME vectors
// are checked against EconLib on-chain by ProofsEconomics.t.sol (test_E7_...), so TS == BigInt == Solidity on every vector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { economics, type EconInputCents } from '../index.ts';
// @ts-ignore - plain .mjs module without type declarations
import { refQuote, buildVectors, toColumns, FIELDS, TS_SAFE_SELL } from '../../contracts/test/vectors/gen-econ-vectors.mjs';

type Q = Record<string, bigint>;
const toTs = (q: Q): EconInputCents => ({
  purchaseCents: Number(q.purchaseCents), inboundShipCents: Number(q.shipCents), importDutyCents: Number(q.dutyCents), taxCents: Number(q.taxCents),
  procurementFeeCents: Number(q.procFeeCents), paymentFeeCents: Number(q.payFeeCents), sellCents: Number(q.sellCents), marketplaceFeeBps: Number(q.mktFeeBps),
  fulfillmentCents: Number(q.fulfillCents), returnReserveBps: Number(q.retBps), chainCostCents: Number(q.chainCents), units: 1, fixedBatchCents: 0,
});
function tsAsBig(q: Q) {
  const r = economics(toTs(q));
  return { landed: BigInt(r.landedCents), mktFee: BigInt(r.mktFeeCents), ret: BigInt(r.retCents), net: BigInt(r.netCents), marginBps: BigInt(r.marginBps), breakeven: BigInt(r.breakevenCents), maxBuy: BigInt(r.maxBuyCents) };
}
function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const VEC = new URL('../../contracts/test/vectors/econ-vectors.json', import.meta.url);

test('E7 vectors: the committed econ-vectors.json is exactly what the deterministic generator produces', () => {
  const onDisk = JSON.parse(fs.readFileSync(VEC, 'utf8'));
  assert.deepEqual(onDisk, toColumns(buildVectors()), 'regenerate: node packages/contracts/test/vectors/gen-econ-vectors.mjs');
});

test('E7: the TS mirror equals the BigInt reference (and therefore EconLib) on every TS-safe vector; F-E1 outside it', () => {
  const j = JSON.parse(fs.readFileSync(VEC, 'utf8')); let safe = 0, unsafeDiff = 0;
  for (let i = 0; i < j.tsSafe.length; i++) {
    const q: Q = {}; for (const f of FIELDS) q[f] = BigInt(j[f][i]);
    const exp = { landed: BigInt(j.exp_landed[i]), mktFee: BigInt(j.exp_mktFee[i]), ret: BigInt(j.exp_ret[i]), net: BigInt(j.exp_net[i]), marginBps: BigInt(j.exp_marginBps[i]), breakeven: BigInt(j.exp_breakeven[i]), maxBuy: BigInt(j.exp_maxBuy[i]) };
    assert.deepEqual(refQuote(q), exp, 'reference reproduces the vector');
    if (j.tsSafe[i] === '1') { assert.deepEqual(tsAsBig(q), exp, `vector ${i}`); safe++; }
    else { assert.throws(() => tsAsBig(q), RangeError, `vector ${i} is above 9e11`); unsafeDiff++; } // F-E1 resolution: the mirror refuses instead of returning a value off by a cent
  }
  assert.ok(safe > 1500, 'non-vacuous'); assert.ok(unsafeDiff > 0, 'F-E1: vectors above sellCents = 9e11 exist and the mirror raises RangeError on every one');
});

test('E7 (exhaustive ceil lemma): every sell in [0,150] x every bps in [0,10000]: both bps fees equal ceil(sell*bps/10^4)', () => {
  let n = 0;
  for (let s = 0; s <= 150; s++) for (let b = 0; b <= 10_000; b++) {
    const r = economics({ purchaseCents: 0, inboundShipCents: 0, importDutyCents: 0, taxCents: 0, procurementFeeCents: 0, paymentFeeCents: 0, sellCents: s, marketplaceFeeBps: b, fulfillmentCents: 0, returnReserveBps: 10_000 - b, chainCostCents: 0, units: 1, fixedBatchCents: 0 });
    const e1 = Math.ceil((s * b) / 10_000), e2 = Math.ceil((s * (10_000 - b)) / 10_000); // exact here: s*b <= 1.5e6
    if (r.mktFeeCents !== e1 || r.retCents !== e2) assert.fail(`s=${s} b=${b}`);
    n++;
  }
  assert.equal(n, 151 * 10_001);
});

test('E7 (exhaustive small grid): 1,327,104 quotes, TS == BigInt reference on every output', () => {
  const bps = [0n, 1n, 2_500n, 3_333n, 9_999n, 10_000n]; let n = 0, profitable = 0;
  for (let s = 0n; s <= 47n; s++) for (const m of bps) for (const r of bps) for (let p = 0n; p <= 15n; p++) for (const f of [0n, 1n, 7n]) for (const c of [0n, 3n]) for (const o of [0n, 1n]) for (const pay of [0n, 2n]) for (const tax of [0n, 5n]) {
    const q: Q = { purchaseCents: p, shipCents: o, dutyCents: o, taxCents: tax, procFeeCents: o, payFeeCents: pay, sellCents: s, mktFeeBps: m, fulfillCents: f, retBps: r, chainCents: c };
    const a = tsAsBig(q), e = refQuote(q);
    if (a.landed !== e.landed || a.mktFee !== e.mktFee || a.ret !== e.ret || a.net !== e.net || a.marginBps !== e.marginBps || a.breakeven !== e.breakeven || a.maxBuy !== e.maxBuy) assert.fail(JSON.stringify(q, (_k, v) => String(v)));
    n++; if (e.net > 0n) profitable++;
  }
  assert.equal(n, 1_327_104); // 48 * 6 * 6 * 16 * 3 * 2 * 2 * 2 * 2
  assert.ok(profitable > 50_000);
});

test('E7 (random, large): 300,000 quotes over the TS-safe accepted domain (sellCents <= 9e11), TS == BigInt reference', () => {
  const r = rng(7331);
  const big = (lim: bigint) => { const hi = BigInt(Math.floor(r() * 2 ** 26)), lo = BigInt(Math.floor(r() * 2 ** 26)); return ((hi << 26n) | lo) % (lim + 1n); };
  const logu = (lim: bigint) => { const d = Math.floor(r() * 13); const cap = 10n ** BigInt(d); return big(cap < lim ? cap : lim); };
  const bpsv = () => { const k = r(); return k < 0.15 ? 0n : k < 0.3 ? 10_000n : BigInt(Math.floor(r() * 10_001)); };
  let profitable = 0;
  for (let i = 0; i < 300_000; i++) {
    const q: Q = {}; for (const f of FIELDS) q[f] = f.endsWith('Bps') ? bpsv() : logu(10n ** 12n);
    if (q.sellCents > TS_SAFE_SELL) q.sellCents = q.sellCents % (TS_SAFE_SELL + 1n);
    if (i % 3 === 0) { q.sellCents = TS_SAFE_SELL - big(1000n); } // hug the boundary of the safe region
    const a = tsAsBig(q), e = refQuote(q);
    if (a.landed !== e.landed || a.mktFee !== e.mktFee || a.ret !== e.ret || a.net !== e.net || a.marginBps !== e.marginBps || a.breakeven !== e.breakeven || a.maxBuy !== e.maxBuy) assert.fail(JSON.stringify(q, (_k, v) => String(v)));
    if (e.net > 0n) profitable++;
  }
  assert.ok(profitable > 10_000, 'non-vacuous');
});

test('E7 lemma: Math.floor(a / b) is the exact floor whenever a + b <= 2^53 (1,000,000 samples hugging 2^53)', () => {
  const r = rng(99); const LIM = 2 ** 53;
  for (let i = 0; i < 1_000_000; i++) {
    const b = i % 4 === 0 ? 10_000 : 1 + Math.floor(r() * 2 ** 30);
    const a = LIM - b - Math.floor(r() * 2 ** 20);
    if (a < 0) continue;
    if (BigInt(Math.floor(a / b)) !== BigInt(a) / BigInt(b)) assert.fail(`a=${a} b=${b}`);
  }
});

test('E3: rounding never overstates net or margin (BigInt, 200,000 random accepted quotes)', () => {
  const r = rng(4242); const big = (lim: bigint) => BigInt(Math.floor(r() * 2 ** 31)) * BigInt(Math.floor(r() * 2 ** 21)) % (lim + 1n);
  for (let i = 0; i < 200_000; i++) {
    const q: Q = {}; for (const f of FIELDS) q[f] = f.endsWith('Bps') ? BigInt(Math.floor(r() * 10_001)) : big(i % 2 ? 10n ** 12n : 10n ** 5n);
    const e = refQuote(q); const landed = e.landed;
    const n4 = 10_000n * q.sellCents - q.sellCents * q.mktFeeBps - q.sellCents * q.retBps - 10_000n * (q.fulfillCents + landed + q.chainCents);
    assert.ok(e.net * 10_000n <= n4 && n4 < e.net * 10_000n + 20_000n, 'exact - 2 < net <= exact');
    if (e.net > 0n) assert.ok(e.marginBps * q.sellCents <= n4, 'margin <= exact margin');
  }
});

test('F-E1: sellCents = 1e12, mktFeeBps = 9999 (EconLib fee 999,900,000,000; plain Number math gave ...001): the mirror now raises RangeError', () => {
  const q: Q = Object.fromEntries(FIELDS.map((f: string) => [f, 0n])); q.sellCents = 10n ** 12n; q.mktFeeBps = 9_999n;
  assert.equal(refQuote(q).mktFee, 999_900_000_000n);
  assert.throws(() => tsAsBig(q), (e: unknown) => e instanceof RangeError && /sellCents above 9e11 is outside the exact TS domain/.test((e as Error).message));
  // Boundary: 9e11 is exact against the BigInt reference (= EconLib), 9e11 + 1 raises.
  const b: Q = { ...q, sellCents: TS_SAFE_SELL, mktFeeBps: 9_999n };
  assert.deepEqual(tsAsBig(b), refQuote(b));
  assert.throws(() => tsAsBig({ ...b, sellCents: TS_SAFE_SELL + 1n }), RangeError);
});

test('F-E2: maxBuy (EconLib parity field) = purchase + mktFee + fulfill + ret + chain, not the break-even purchase price (hero: 769 vs 851); breakEvenBuyCents is 851', () => {
  const hero = { purchaseCents: 590, inboundShipCents: 42, importDutyCents: 12, taxCents: 8, procurementFeeCents: 5, paymentFeeCents: 2, sellCents: 1099, marketplaceFeeBps: 800, fulfillmentCents: 65, returnReserveBps: 200, chainCostCents: 4, units: 240, fixedBatchCents: 1800 };
  const r = economics(hero);
  assert.equal(r.maxBuyCents, 590 + 88 + 65 + 22 + 4);
  const atMaxBuy = economics({ ...hero, purchaseCents: r.maxBuyCents }); assert.ok(atMaxBuy.netCents > 0, 'buying at "maxBuy" still leaves profit');
  const be = hero.purchaseCents + r.netCents; // largest purchase price with net >= 0 (fees do not depend on purchase)
  assert.equal(economics({ ...hero, purchaseCents: be }).netCents, 0); assert.equal(economics({ ...hero, purchaseCents: be + 1 }).netCents, -1);
  assert.equal(be, 851); assert.equal(r.breakEvenBuyCents, 851);
  // the same facts through the BigInt reference (EconLib formulas)
  const q: Q = { purchaseCents: 851n, shipCents: 42n, dutyCents: 12n, taxCents: 8n, procFeeCents: 5n, payFeeCents: 2n, sellCents: 1099n, mktFeeBps: 800n, fulfillCents: 65n, retBps: 200n, chainCents: 4n };
  assert.equal(refQuote(q).net, 0n); assert.equal(refQuote({ ...q, purchaseCents: 852n }).net, -1n);
});

test('F-E3: TS capitalCents/batchCents are not exact above 2^53 (contract spend is exact); display-only', () => {
  const r = economics({ purchaseCents: 6e12, inboundShipCents: 0, importDutyCents: 0, taxCents: 0, procurementFeeCents: 0, paymentFeeCents: 0, sellCents: 0, marketplaceFeeBps: 0, fulfillmentCents: 0, returnReserveBps: 0, chainCostCents: 0, units: 999_999_999, fixedBatchCents: 0 });
  assert.notEqual(BigInt(r.capitalCents), 6n * 10n ** 12n * 999_999_999n);
});
