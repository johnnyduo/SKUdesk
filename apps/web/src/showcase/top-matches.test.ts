import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topMatches, type MatchOpp } from './top-matches.ts';

const opp = (id: string, productId: string, buyCents: number, sellCents: number, marginBps: number): MatchOpp => ({
  id, productId, title: `T ${id}`, buy: 'Shopee', sell: 'Google', buyCents, sellCents, netCents: sellCents - buyCents, marginBps,
});
const REC = { productId: 'P1', buyCents: 590, sellCents: 1099, netCents: 509, marginBps: 2374 }; // net = sell - buy in this fixture

test('recorded opportunity comes first, the rest by margin', () => {
  const r = topMatches([opp('a', 'P2', 600, 1000, 3000), opp('b', 'P1', 590, 1099, 2374), opp('c', 'P3', 500, 1000, 4000)], REC, 5);
  assert.deepEqual(r.map((x) => x.id), ['b', 'c', 'a']);
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 3]);
  assert.deepEqual(r.map((x) => x.recorded), [true, false, false]);
});

test('recorded is decided by value, not by assumption', () => {
  const differentPrices = topMatches([opp('b', 'P1', 600, 1099, 2374)], REC, 5);
  assert.equal(differentPrices[0].recorded, false);
  const differentProduct = topMatches([opp('b', 'P9', 590, 1099, 2374)], REC, 5);
  assert.equal(differentProduct[0].recorded, false);
  const differentMargin = topMatches([opp('b', 'P1', 590, 1099, 2000)], REC, 5);
  assert.equal(differentMargin[0].recorded, false);
});

// Each field of the by-value match must be load-bearing on its own.
// Starting from an exact match (recorded === true), perturbing exactly one field must flip it to false.
test('recorded requires every field to match: perturbing any single field un-records it', () => {
  const exact = opp('b', 'P1', 590, 1099, 2374);
  assert.equal(exact.netCents, REC.netCents); // fixture sanity: the control really is an exact match
  assert.equal(topMatches([exact], REC, 5)[0].recorded, true);
  const perturbed: Array<[string, MatchOpp]> = [
    ['productId', { ...exact, productId: 'P9' }],
    ['buyCents', { ...exact, buyCents: exact.buyCents + 1 }],
    ['sellCents', { ...exact, sellCents: exact.sellCents + 1 }],
    ['netCents', { ...exact, netCents: exact.netCents + 1 }], // buy/sell/margin untouched
    ['marginBps', { ...exact, marginBps: exact.marginBps + 1 }],
  ];
  for (const [field, o] of perturbed) {
    assert.equal(topMatches([o], REC, 5)[0].recorded, false, `changing only ${field} must not count as the recorded run`);
  }
});

test('two opportunities with identical prices are never both tagged recorded', () => {
  const r = topMatches([opp('x', 'P1', 590, 1099, 2374), opp('y', 'P1', 590, 1099, 2374)], REC, 5);
  // same product → de-duplicated to one entry
  assert.equal(r.length, 1);
  assert.equal(r.filter((x) => x.recorded).length, 1);
});

test('no recorded run: ranked by margin, ties by id', () => {
  const r = topMatches([opp('b', 'P2', 1, 2, 100), opp('a', 'P3', 1, 2, 100), opp('c', 'P4', 1, 2, 200)], null, 5);
  assert.deepEqual(r.map((x) => x.id), ['c', 'a', 'b']);
  assert.ok(r.every((x) => x.recorded === false));
});

test('one entry per product, keeping the best margin', () => {
  const r = topMatches([opp('lo', 'P2', 1, 2, 100), opp('hi', 'P2', 1, 2, 900)], null, 5);
  assert.deepEqual(r.map((x) => x.id), ['hi']);
});

// The best-margin winner must not depend on input order.
test('best margin per product wins regardless of input order', () => {
  assert.deepEqual(topMatches([opp('hi', 'P2', 1, 2, 900), opp('lo', 'P2', 1, 2, 100)], null, 5).map((x) => x.id), ['hi']);
  assert.deepEqual(topMatches([opp('lo', 'P2', 1, 2, 100), opp('hi', 'P2', 1, 2, 900)], null, 5).map((x) => x.id), ['hi']);
});

test('limit n is respected; empty and bad n give an empty list', () => {
  const list = [1, 2, 3, 4].map((i) => opp('o' + i, 'P' + i, 1, 2, i));
  assert.equal(topMatches(list, null, 2).length, 2);
  assert.deepEqual(topMatches([], null, 5), []);
  assert.deepEqual(topMatches(list, null, 0), []);
  assert.deepEqual(topMatches(list, null, NaN), []);
  assert.deepEqual(topMatches(list, null, -3), []);
});

// The limit keeps the TOP n (not just any n), ranks stay 1..n, fractional/infinite n are safe.
test('limit keeps the highest-ranked entries with ranks 1..n', () => {
  const list = [1, 2, 3, 4].map((i) => opp('o' + i, 'P' + i, 1, 2, i));
  const r = topMatches(list, null, 2);
  assert.deepEqual(r.map((x) => x.id), ['o4', 'o3']);
  assert.deepEqual(r.map((x) => x.rank), [1, 2]);
  assert.deepEqual(topMatches(list, null, 2.9).map((x) => x.id), ['o4', 'o3']); // floored
  assert.deepEqual(topMatches(list, null, Infinity), []); // non-finite n is treated as bad input
  assert.equal(topMatches(list, null, 99).length, 4); // n larger than the list is fine
});

test('the recorded run survives the limit: it takes slot 1 even when its margin is lowest', () => {
  const list = [opp('a', 'P2', 600, 1000, 3000), opp('b', 'P1', 590, 1099, 2374), opp('c', 'P3', 500, 1000, 4000)];
  const r = topMatches(list, REC, 2);
  assert.deepEqual(r.map((x) => x.id), ['b', 'c']);
  assert.deepEqual(r.map((x) => x.recorded), [true, false]);
});

test('extra fields on the input pass through and the input is not mutated', () => {
  const rich = { ...opp('a', 'P2', 1, 2, 100), image: 'a.png' };
  const input = [rich];
  const r = topMatches(input, null, 5);
  assert.equal(r[0].image, 'a.png');
  assert.equal(r[0].rank, 1);
  assert.equal('rank' in rich, false);
  assert.equal(input.length, 1);
});
