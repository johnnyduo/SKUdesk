// node --test test/site/desk-model.test.ts   (from apps/web)
// Every run event maps to a stage of the diagram and, for the attacks, to the guard the contract refused with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNodeModule } from './helpers/bundle.ts';

const RUN = JSON.parse(readFileSync(new URL('../../src/data/run.json', import.meta.url), 'utf8'));
const mod = await loadNodeModule<{ stageOfEvent(e: unknown): number; guardOfEvent(e: unknown): string | undefined }>(`
  export { stageOfEvent, guardOfEvent } from './src/components/flow/model.ts';
`);

// Stage boundaries come from the run itself (a fresh run may have a different number of reasoning lines):
// mandate + snapshot | agent + reasons | gates + economics | the three funding txs | attacks + the failed tx | the rest.
const N: number = RUN.events.length;
const firstId = (pred: (e: any) => boolean) => RUN.events.find(pred)!.id as number;
const AGENT = firstId((e) => e.kind === 'agent');
const GATE = firstId((e) => e.kind === 'gate');
const TX = firstId((e) => e.kind === 'tx');
const ATTACK = firstId((e) => e.kind === 'revert');
const FAILED = firstId((e) => e.tx?.status === 'reverted');
const ranges: [number, number, number][] = [[1, AGENT - 1, 0], [AGENT, GATE - 1, 1], [GATE, TX - 1, 2], [TX, ATTACK - 1, 3], [ATTACK, FAILED, 4], [FAILED + 1, N, 5]];
const expectedStage = (id: number) => ranges.find(([a, b]) => id >= a && id <= b)![2];

test('every event maps to the stage it belongs to', () => {
  assert.deepEqual(RUN.events.map((e: any) => e.id), Array.from({ length: N }, (_, i) => i + 1));
  assert.equal(ATTACK - TX, 3, 'commit, mint and fund come before the attacks');
  assert.equal(FAILED - ATTACK, RUN.attacks.length, 'the failed tx follows the attacks');
  for (const e of RUN.events) assert.equal(mod.stageOfEvent(e), expectedStage(e.id), `event ${e.id} (${e.kind})`);
});

test('attack events light the guard in their own data, in the order of the run attacks; the failed tx is the MathMismatch revert', () => {
  const attacks = RUN.events.filter((e: any) => e.id >= ATTACK && e.id < FAILED);
  assert.deepEqual(attacks.map((e: any) => mod.guardOfEvent(e)), attacks.map((e: any) => e.data.error));
  assert.deepEqual(attacks.map((e: any) => mod.guardOfEvent(e)), RUN.attacks.map((a: any) => a.error));
  assert.equal(mod.guardOfEvent(RUN.events[FAILED - 1]), 'MathMismatch');
  for (const e of RUN.events.filter((e: any) => e.id < ATTACK || e.id > FAILED)) assert.equal(mod.guardOfEvent(e), undefined, `event ${e.id}`);
});
