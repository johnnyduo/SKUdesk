// Run: node --test apps/web/src/components/wallet/parse.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDollars, parseMarginPct, parseSeconds, parseTokenAmount, parseAddress, baseToInput, centsToInput } from './parse.ts';

test('dollars to cents is exact and strict', () => {
  assert.deepEqual(parseDollars('2,500.50'), { ok: true, cents: 250050 }); assert.deepEqual(parseDollars('$0.07'), { ok: true, cents: 7 });
  for (const bad of ['', '0', '-1', '1.234', 'abc', '1e3']) assert.equal(parseDollars(bad).ok, false, bad);
});
test('margin percent is 1..90 and becomes basis points', () => {
  assert.deepEqual(parseMarginPct('18'), { ok: true, bps: 1800 }); assert.deepEqual(parseMarginPct('18.5%'), { ok: true, bps: 1850 });
  for (const bad of ['0', '0.99', '90.01', '91', '', 'x']) assert.equal(parseMarginPct(bad).ok, false, bad);
  assert.equal(parseMarginPct('1').ok, true); assert.equal(parseMarginPct('90').ok, true);
});
test('seconds are positive whole numbers', () => { assert.deepEqual(parseSeconds('180'), { ok: true, seconds: 180 }); for (const bad of ['0', '1.5', '-3', '']) assert.equal(parseSeconds(bad).ok, false, bad); });
test('token amounts use exact base units', () => {
  assert.deepEqual(parseTokenAmount('1000'), { ok: true, base: 1_000_000_000n }); assert.deepEqual(parseTokenAmount('0.000001'), { ok: true, base: 1n });
  assert.equal(parseTokenAmount('0').ok, false); assert.equal(parseTokenAmount('1.0000001').ok, false);
  assert.equal(baseToInput(5_913_500_000n), '5913.5'); assert.equal(baseToInput(1n), '0.000001'); assert.equal(centsToInput(250000n), '2500'); assert.equal(centsToInput(250050n), '2500.50');
});
test('addresses are validated and normalised', () => {
  const r = parseAddress('0x6129c88ce91acdf5c1e42188b1af88c2166a5501'); assert.ok(r.ok && r.address === '0x6129C88CE91ACdf5c1E42188B1aF88C2166a5501');
  assert.equal(parseAddress('0x123').ok, false); assert.equal(parseAddress('').ok, false);
});
