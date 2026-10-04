import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOffer } from '../index.ts';

const canon = { brand: 'Apple-compatible', model: 'iPhone 16 Pro Clear MagSafe Case', compatibility: 'iPhone 16 Pro', color: 'Clear', packCount: 1, attributes: { magsafe: 'Yes' } };
const run = (title: string, attributes: any = {}) => matchOffer(canon, { title, attributes });
const failedGates = (title: string) => run(title).gates.filter((g) => g.hard && !g.pass).map((g) => g.gate);

test('hero title locks', () => {
  const v = run('iPhone 16 Pro Clear MagSafe Case');
  assert.equal(v.locked, true, v.rejectReasons.join('; '));
  assert.equal(v.rejectReasons.length, 0);
});

test('hero title variants with attributes still lock', () => {
  assert.equal(run('Clear MagSafe Case for iPhone 16 Pro TPU Transparent', { device: 'iPhone 16 Pro', magsafe: 'Yes', pack: '1' }).locked, true);
  assert.equal(run('iPhone 16 Pro Clear MagSafe Case TPU', { device: 'iPhone 16 Pro', magsafe: 'Yes', pack: '1' }).locked, true);
});

for (const [name, title] of [
  ['iPhone 15 Pro', 'iPhone 15 Pro Clear MagSafe Case'],
  ['iPhone 14 Pro', 'iPhone 14 Pro Clear MagSafe Case'],
  ['iPhone 16 Pro Max', 'iPhone 16 Pro Max Clear MagSafe Case'],
  ['iPhone 16 Plus', 'iPhone 16 Plus Clear MagSafe Case'],
  ['iPhone 16 (non-Pro)', 'iPhone 16 Clear MagSafe Case'],
  ['iPhone 16 Mini', 'iPhone 16 Mini Clear MagSafe Case'],
  ['Galaxy S24', 'Galaxy S24 Clear MagSafe Case'],
  ['no model at all', 'Clear MagSafe Case'],
] as const) {
  test(`rejects ${name} on compatibility`, () => {
    const v = run(title);
    assert.equal(v.locked, false);
    assert.ok(failedGates(title).includes('compatibility'), JSON.stringify(v.gates));
    assert.ok(v.rejectReasons.some((r) => r.startsWith('compatibility')));
  });
}

test('rejects multi-model listing that includes another generation', () => {
  assert.equal(run('iPhone 16 Pro / iPhone 15 Pro Clear MagSafe Case').locked, false);
});

for (const title of ['iPhone 16 Pro Clear MagSafe Case 2-Pack', 'iPhone 16 Pro Clear MagSafe Case 2 Pack', 'iPhone 16 Pro Clear MagSafe Case Pack of 2', 'iPhone 16 Pro Clear MagSafe Case Twin Pack', 'iPhone 16 Pro Clear MagSafe Case 2pcs', 'iPhone 16 Pro Clear MagSafe Case x2']) {
  test(`rejects pack: ${title}`, () => {
    const v = run(title);
    assert.equal(v.locked, false);
    assert.ok(failedGates(title).includes('packCount'));
  });
}

test('pack attribute "2-pack" rejects', () => {
  assert.equal(run('iPhone 16 Pro Clear MagSafe Case', { pack: '2-pack' }).locked, false);
});

test('rejects no-MagSafe', () => {
  for (const title of ['iPhone 16 Pro Clear Case', 'iPhone 16 Pro Clear Case (no magnet)', 'iPhone 16 Pro Clear Case without MagSafe']) {
    const v = run(title);
    assert.equal(v.locked, false, title);
    assert.ok(failedGates(title).includes('magsafe'), title);
  }
});

test("'zx2' is not a 2-pack and still locks", () => {
  const v = run('iPhone 16 Pro Clear MagSafe Case zx2');
  assert.equal(v.locked, true, v.rejectReasons.join('; '));
  assert.equal(v.gates.find((g) => g.gate === 'packCount')!.observed, '1');
});

test('gate shape is stable', () => {
  const v = run('iPhone 16 Pro Clear MagSafe Case');
  assert.deepEqual(v.gates.map((g) => g.gate), ['brand', 'compatibility', 'packCount', 'magsafe', 'gtin', 'color']);
  for (const g of v.gates) assert.deepEqual(Object.keys(g).sort(), ['expected', 'gate', 'hard', 'observed', 'pass']);
});

test('generic canon: Galaxy S24 matches only itself', () => {
  const c = { ...canon, model: 'Galaxy S24 Clear MagSafe Case', compatibility: 'Galaxy S24' };
  assert.equal(matchOffer(c, { title: 'Galaxy S24 Clear MagSafe Case' }).locked, true);
  assert.equal(matchOffer(c, { title: 'Galaxy S24 Ultra Clear MagSafe Case' }).locked, false);
  assert.equal(matchOffer(c, { title: 'Galaxy S25 Clear MagSafe Case' }).locked, false);
});
