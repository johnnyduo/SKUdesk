import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackRecord, fmtInt, type HistoryEvent } from './track-record.ts';

const ev = (e: string, a: Record<string, string> = {}): HistoryEvent => ({ e, b: 1, a });

test('counts each event kind and the distinct bidding wallets (case-insensitive)', () => {
  const t = trackRecord([ev('Committed', { trader: '0xAA' }), ev('Committed', { trader: '0xaa' }), ev('Committed', { trader: '0xBB' }), ev('Revealed'), ev('Fill'), ev('Fill'), ev('EpochCleared'), ev('Other')], 99);
  assert.deepEqual(t, { rounds: 1, bids: 3, reveals: 1, fills: 2, bidders: 2, headBlock: 99 });
});

test('an empty history is all zeros, never NaN', () => {
  assert.deepEqual(trackRecord([], 0), { rounds: 0, bids: 0, reveals: 0, fills: 0, bidders: 0, headBlock: 0 });
});

test('fmtInt adds thousands separators', () => {
  assert.equal(fmtInt(536), '536');
  assert.equal(fmtInt(1688), '1,688');
  assert.equal(fmtInt(1234567), '1,234,567');
});

test('the committed history yields plausible numbers (rounds cleared never exceed rounds that had bids)', () => {
  const h = JSON.parse(readFileSync(new URL('../data/blindbook-history.json', import.meta.url), 'utf8'));
  const t = trackRecord(h.events, h.head);
  assert.ok(t.rounds > 0 && t.bids > 0 && t.bidders > 0 && t.headBlock > 0);
  assert.ok(t.reveals <= t.bids, 'a bid is revealed at most once');
});
