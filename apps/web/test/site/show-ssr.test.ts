// node --test test/site/show-ssr.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNodeModule } from './helpers/bundle.ts';
import { runDateText } from '../../src/lib/chain-proof.ts';

// Run facts come from run.json, so a fresh agent run does not break these tests.
const RUN = JSON.parse(readFileSync(new URL('../../src/data/run.json', import.meta.url), 'utf8'));
const NTX: number = RUN.events.filter((e: any) => e.tx).length;
const DATE = runDateText(RUN.meta.startedAt);
const PROFIT = '$' + ((Number(RUN.end.totalProceeds) - Number(RUN.end.totalPaidOut)) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const { html } = await loadNodeModule<{ html: string }>(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import Player from './src/components/show/Player.tsx';
  export const html = renderToStaticMarkup(createElement(Player));
`);
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('first paint: a provenance eyebrow and a walkthrough button, no replay control or label anywhere', () => {
  assert.ok(DATE && text.includes(`ON-CHAIN RUN · Robinhood Chain Testnet · ${DATE}`));
  assert.match(html, /Walk through the run<\/button>/);
  for (const gone of [/REPLAY/, /Replay the run/, />Replay</, /Play again/, /replayed from the chain/, /Replay from the start/, /\bsh-play\b/, /sh-recpill/]) assert.doesNotMatch(html, gone);
});

test('first paint shows the finished result and the evidence, before any click', () => {
  assert.ok(text.includes(PROFIT), PROFIT);
  assert.match(html, /id="final"/);
  assert.match(html, /data-testid="proof-summary" data-state="idle"/);
  assert.ok(text.includes(`These ${NTX} transactions were sent to Robinhood Chain Testnet.`));
  assert.match(text, /The links open the explorer; the check reads them from the public RPC\./);
  assert.match(text, /Verify it yourself/);
  const tx = new Set([...html.matchAll(/href="https:\/\/explorer\.testnet\.chain\.robinhood\.com\/tx\/(0x[0-9a-f]{64})"/g)].map((m) => m[1]));
  assert.equal(tx.size, NTX);
  for (const a of [RUN.meta.core, RUN.meta.token, RUN.meta.agent]) assert.ok(html.includes('/address/' + a), a);
});

test('no proof state is shown before a check (without JavaScript: links only, never a fake state)', () => {
  assert.doesNotMatch(html, /data-testid="proof-badge"/);
  assert.doesNotMatch(html, /data-testid="proof-pill"/);
  assert.doesNotMatch(html, /data-testid="mandate-now"/);
});

test('the honesty line stays: a finished run, not a live one, fixed-snapshot prices; no owner-rule words', () => {
  assert.ok(text.includes(`Honesty line. This is a finished run from ${DATE}, not a live one`));
  assert.match(text, /Market prices were a fixed snapshot/);
  assert.match(html, /does not equal the contract-derived net in this run\.|The two amounts match by construction in this run/);
  assert.match(text, /Settlement uses test USDG \(mUSDG\), a testnet stand-in token\./);
  assert.doesNotMatch(text, /\b(recorded|recording|demo|simulated|sample)\b|mock|mUSDC/i);
});

test('the static copy only claims an attempt to check (true without JavaScript or with the RPC down), and the speed label starts with what it shows (×1)', () => {
  const claim = `tries to check its ${NTX} transactions against the public RPC when you open it. The explorer links work without that.`;
  assert.ok(text.includes(claim));
  assert.ok(text.includes(`walks through it and ${claim} Market prices`), 'the honesty line carries the same claim');
  assert.doesNotMatch(text, /are checked against the chain when you open/);
  assert.doesNotMatch(text, /walks through it and checks its transactions/);
  assert.match(html, /aria-label="×1 walkthrough speed"/);
  assert.doesNotMatch(html, /speed 1 times/);
});

test('the mandate line renders at most once on the page', () => {
  assert.ok((html.match(/data-testid="mandate-now"/g) ?? []).length <= 1);
});

test('opening view: the "How the pieces connect" details is closed, so the evidence card comes first (it opens when the walkthrough starts)', () => {
  const tag = html.match(/<details[^>]*class="sh-map"[^>]*>/)?.[0] ?? '';
  assert.ok(tag, 'details present');
  assert.doesNotMatch(tag, /\bopen\b/);
  assert.ok(html.indexOf('id="final"') > html.indexOf('class="sh-map"'));
});
