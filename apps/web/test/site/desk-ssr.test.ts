// node --test test/site/desk-ssr.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNodeModule } from './helpers/bundle.ts';

const { html } = await loadNodeModule<{ html: string }>(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import AgentDesk from './src/components/flow/AgentDesk.tsx';
  export const html = renderToStaticMarkup(createElement(AgentDesk, {}));
`);
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const tag = (label: string) => (html.match(new RegExp('<button[^>]*aria-label="' + label + '"[^>]*>')) ?? [''])[0];
const read = (p: string) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
// Counts and event numbers come from run.json, so a fresh agent run does not break these tests.
const RUN = JSON.parse(read('src/data/run.json'));
const N: number = RUN.events.length;
const NTX: number = RUN.events.filter((e: any) => e.tx).length;
const FAILED: number = RUN.events.find((e: any) => e.tx?.status === 'reverted').id;
const ATTACK: number = RUN.events.find((e: any) => e.kind === 'revert').id;
const COMMIT: number = RUN.events.find((e: any) => e.kind === 'tx').id;
const REASON: number = RUN.events.find((e: any) => e.kind === 'reason').id;

test('the whole run is on screen at first paint (also without JavaScript), the last event selected', () => {
  assert.equal((html.match(/class="dk-row /g) ?? []).length, N);
  assert.doesNotMatch(html, /dk-row future/);
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.ok(html.includes(`data-i="${N}" class="dk-row now"`));
  assert.ok(text.includes(`Event ${N} of ${N}`));
});

test('no playback controls: no Replay the run, Play, Pause or Resume; Previous and Next pick an event', () => {
  // The Replay attack's own text says "Replay blocked." (the contract's replay protection), so match the removed control, not the word.
  for (const gone of [/Replay the run/, /Resume/, />\s*Pause/, /❚❚/, /aria-label="Playback"/]) assert.doesNotMatch(html, gone);
  assert.ok(tag('Previous event') && !/disabled/.test(tag('Previous event')), 'Previous is enabled at the last event');
  // aria-disabled, not the disabled attribute: a disabled button drops keyboard focus when the visitor reaches an end.
  assert.match(tag('Next event'), /aria-disabled="true"/);
  assert.doesNotMatch(tag('Next event'), /\sdisabled(=|\s|>)/);
  assert.ok(html.includes(`<input type="range" min="1" max="${N}"`));
});

test('every transaction links to the explorer; the chain-check summary is there (idle before the check); no reveal markup', () => {
  assert.equal(new Set([...html.matchAll(/explorer\.testnet\.chain\.robinhood\.com\/tx\/(0x[0-9a-f]{64})/g)].map((m) => m[1])).size, NTX);
  assert.match(html, /data-testid="proof-summary" data-state="idle"/);
  assert.doesNotMatch(html, /data-testid="proof-badge"/);
  assert.doesNotMatch(html, /data-reveal=/);
});

test('server-rendered proof copy never claims a check happened: it only says the transactions were sent and where to look', () => {
  assert.ok(text.includes(`These ${NTX} transactions were sent to Robinhood Chain Testnet.`));
  assert.match(text, /The links open the explorer; the check reads them from the public RPC\./);
  assert.doesNotMatch(text, /Confirmed on chain|match the chain|Checking/);
});

test('the page copy is static-safe: no playback wording, and it only says the page tries to check against the public RPC', () => {
  const page = read('src/pages/app/agent.astro');
  for (const gone of [/Press play/, /replays a run/, /cinematic replay/, /is checked against the chain when the log is on screen/]) assert.doesNotMatch(page, gone);
  assert.match(page, /tries to check each transaction against the public RPC when you open it/);
  assert.match(page, /href="\/show\/">Walk through the run</);
  assert.match(page, /<code>Replay<\/code>/, 'the contract error name stays');
});

test('reveal guard: the log is a tall block with content after it, so the -10% bottom margin of useRevealOnce can always reach it', () => {
  // useRevealOnce shrinks the viewport by 10% at the bottom; a block shorter than that which ends the document could never
  // intersect. The log is a scroll box of up to 560px holding every row of the run, and /app/agent continues after it.
  assert.match(read('src/components/flow/desk.css'), /\.dk-rows\{[^}]*max-height:560px/);
  const page = read('src/pages/app/agent.astro');
  assert.ok(page.indexOf('</AgentDesk>') > 0 && page.indexOf('</AgentDesk>') < page.indexOf('class="dk-next"'), 'content follows the desk');
});

test('no row is dimmed: later rows keep full opacity (details, links and badges stay readable)', () => {
  const css = read('src/components/flow/desk.css');
  assert.doesNotMatch(css, /\.dk-row\.future\{[^}]*opacity/);
  assert.match(css, /\.dk-row\.future \.dk-title\{/);
});

test('a row button is named by what is visible: event number, kind and title; the kind stays available on small screens', () => {
  assert.ok(html.includes(`aria-label="Explain event ${ATTACK}, refused: The agent inflates its profit claim"`));
  assert.ok(html.includes(`aria-label="Explain event ${COMMIT}, transaction: commitOpportunity`));
  assert.ok(html.includes(`aria-label="Explain event ${REASON}, reasoning: `));
  const css = read('src/components/flow/desk.css');
  assert.doesNotMatch(css, /\.dk-kind\{display:none\}/, 'visually hidden, not display:none, on mobile');
  assert.match(css, /max-width:700px\)\{[^]*\.dk-kind\{position:absolute/);
});

test('the failed tx, the expected revert, reads as a deliberate refusal before and without the check, not as a failure', () => {
  const row = html.match(new RegExp(`<li[^>]*data-i="${FAILED}"[\\s\\S]*?</li>`))![0];
  assert.match(row, /expected revert/);
  assert.match(row, /Refused on purpose, on chain: the agent inflates its profit claim/);
  assert.doesNotMatch(row, /Failed tx|reverted tx|pill bad|k-bad| bad"/);
  assert.match(row, /pill warn/);
  assert.ok(row.includes(`aria-label="Explain event ${FAILED}, expected revert: `));
  // the other refused attempts keep their red tone
  assert.match(html.match(new RegExp(`<li[^>]*data-i="${ATTACK}"[^>]*>`))![0], / bad"/);
});

test('touch targets and scrolling: links and row buttons reach --tap on coarse pointers and small screens; the log does not chain scroll', () => {
  const css = read('src/components/flow/desk.css');
  assert.match(css, /\.dk-rows\{[^}]*overscroll-behavior:contain/);
  assert.match(css, /@media\(pointer:coarse\)\{[^]*\.dk-link\{min-height:var\(--tap\)\}[^]*\.dk-row-btn\{min-height:var\(--tap\)\}/);
  assert.match(css, /max-width:700px\)\{[^]*\.dk-link\{min-height:var\(--tap\)\}/);
});
