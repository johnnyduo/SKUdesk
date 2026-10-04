// node --test test/site/show-lib.test.ts   (from apps/web): the pure provenance wording of /show
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNodeModule } from './helpers/bundle.ts';

const RUN = JSON.parse(readFileSync(new URL('../../src/data/run.json', import.meta.url), 'utf8'));

type P = { date: string; first: number | null; last: number | null; txCount: number };
const lib = await loadNodeModule<{
  eyebrowLine(real: boolean, name: string, short: string, date: string): string;
  runNote(p: P): string;
  checkClaim(txCount: number): { clause: string; sentence: string };
  EXPLORER_NOTE: string;
  provenance: P;
}>(`export { eyebrowLine, runNote, checkClaim, EXPLORER_NOTE, provenance } from './src/components/show/lib.ts';`);

test('eyebrow: full line for the real run, no dangling separator without a date, a plain label for a local chain', () => {
  assert.equal(lib.eyebrowLine(true, 'Robinhood Chain Testnet', 'RH', '2 Oct 2026, 15:17 UTC'), 'ON-CHAIN RUN · Robinhood Chain Testnet · 2 Oct 2026, 15:17 UTC');
  assert.equal(lib.eyebrowLine(true, 'Robinhood Chain Testnet', 'RH', ''), 'ON-CHAIN RUN · Robinhood Chain Testnet');
  assert.equal(lib.eyebrowLine(false, 'Local', 'LOCAL', 'x'), 'LOCAL · not the public run');
});

test('run note: block span and an attempt-only check claim; no block sentence and no check claim for a run without transactions', () => {
  const full = lib.runNote({ date: 'd', first: 127660264, last: 127660415, txCount: 9 });
  assert.match(full, /^Blocks 127,660,264 to 127,660,415\. Not live: /);
  assert.match(full, /tries to check its 9 transactions against the public RPC when you open it\. The explorer links work without that\.$/);
  const none = lib.runNote({ date: 'd', first: null, last: null, txCount: 0 });
  assert.equal(none, 'Not live: this page walks through a finished run.');
  assert.doesNotMatch(none, /Blocks|null|0 transactions/);
});

test('the real run has a date and a block span', () => {
  assert.equal(lib.provenance.txCount, RUN.events.filter((e: any) => e.tx).length);
  assert.ok(lib.provenance.date);
  assert.ok(lib.provenance.first !== null && lib.provenance.last !== null && lib.provenance.first <= lib.provenance.last);
});

test('one check claim feeds every place that makes it; nothing is claimed for a run without transactions', () => {
  const c = lib.checkClaim(9);
  assert.equal(c.clause, 'tries to check its 9 transactions against the public RPC when you open it');
  assert.equal(c.sentence, 'It tries to check its 9 transactions against the public RPC when you open it. The explorer links work without that.');
  assert.deepEqual(lib.checkClaim(0), { clause: '', sentence: '' });
  assert.deepEqual(lib.checkClaim(-1), { clause: '', sentence: '' });
  assert.deepEqual(lib.checkClaim(NaN), { clause: '', sentence: '' });
  // singular for one transaction
  assert.equal(lib.checkClaim(1).clause, 'tries to check its 1 transaction against the public RPC when you open it');
  assert.doesNotMatch(lib.checkClaim(1).sentence, /1 transactions/);
  assert.match(lib.checkClaim(2).clause, /its 2 transactions /);
  // the tail sentence is one constant used by the clause sentence and the run note
  assert.equal(lib.EXPLORER_NOTE, 'The explorer links work without that.');
  assert.ok(c.sentence.endsWith(lib.EXPLORER_NOTE));
  assert.ok(lib.runNote({ date: 'd', first: 1, last: 2, txCount: 9 }).endsWith(lib.EXPLORER_NOTE));
  // the run note embeds the same clause (single source)
  assert.ok(lib.runNote({ date: 'd', first: 1, last: 2, txCount: 9 }).includes(c.clause));
  assert.doesNotMatch(lib.runNote({ date: 'd', first: 1, last: 2, txCount: 0 }), /tries to check/);
});
