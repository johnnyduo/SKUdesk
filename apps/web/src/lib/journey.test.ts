// Run: node --test apps/web/src/lib/journey.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOURNEY, stepOf, nextOf, prevOf } from './journey.ts';

test('six numbered steps in a fixed order', () => { assert.deepEqual(JOURNEY.map((s) => s.n), [1, 2, 3, 4, 5, 6]); assert.equal(JOURNEY[3].href, '/app/create/'); });
test('every page of the site belongs to exactly the step a visitor expects', () => {
  const want: Record<string, number> = { '/show': 2, '/show/': 2, '/app/create': 4, '/app/create/': 4, '/market': 3, '/app': 1, '/app/': 1, '/app/opportunities': 1, '/app/opportunities/0a1b2c3d': 1, '/app/lots/1': 1, '/app/transactions': 1, '/app/radar': 1, '/app/orders': 1, '/app/orders/': 1,
    '/app/agent': 5, '/app/policies': 5, '/app/owner': 5, '/app/analytics': 6, '/app/deploy': 6, '/app/integrations': 6 };
  for (const [p, n] of Object.entries(want)) assert.equal(stepOf(p)?.n, n, p);
});
test('unknown pages belong to no step, so no wrong "next" button is shown', () => { assert.equal(stepOf('/'), undefined); assert.equal(stepOf('/deck'), undefined); assert.equal(stepOf('/app/nonexistent-x'), undefined); });
test('every tab of every step resolves back to that same step', () => { for (const s of JOURNEY) for (const [h] of s.tabs ?? []) assert.equal(stepOf(h)?.n, s.n, h); });
test('next and previous walk the whole list and stop at the ends', () => {
  assert.equal(prevOf(JOURNEY[0]), undefined); assert.equal(nextOf(JOURNEY[5]), undefined);
  for (let i = 0; i < 5; i++) { assert.equal(nextOf(JOURNEY[i])?.n, i + 2); assert.equal(prevOf(JOURNEY[i + 1])?.n, i + 1); }
});
test('every step link is unique and every step has a plain one-line blurb', () => { assert.equal(new Set(JOURNEY.map((s) => s.href)).size, 6); for (const s of JOURNEY) assert.ok(s.blurb.length > 20 && s.blurb.length < 90, s.label); });
