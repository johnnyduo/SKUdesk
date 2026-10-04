// node --test test/site/radar-ssr.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNodeModule } from './helpers/bundle.ts';

const { html, rows, gates } = await loadNodeModule<{ html: string; rows: number; gates: { pass: number; fail: number } }>(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import RadarSweep from './src/components/commerce/RadarSweep.tsx';
  import { ROWS } from './src/components/commerce/market.ts';
  export const html = renderToStaticMarkup(createElement(RadarSweep, { rows: ROWS, groups: true }));
  export const rows = ROWS.length;
  export const gates = { pass: ROWS.flatMap((r) => r.gates).filter((g) => g.pass).length, fail: ROWS.flatMap((r) => r.gates).filter((g) => !g.pass).length };
`);
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const read = (p: string) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('every verdict renders final at first paint, with no replay control', () => {
  assert.equal(rows, 10);
  assert.equal((html.match(/class="mk-row (locked|rejected)/g) ?? []).length, rows);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /Replay the gates|replay re-shows|Replaying the build-time/);
  assert.match(text, /All 10 verdicts shown\. They were computed by matchOffer when this page was built\./);
  assert.doesNotMatch(html, /\bpending\b|checking…|queued/);
});

test('the accessible text always carries the final result of every gate', () => {
  assert.equal((html.match(/<span class="sr-only"> pass<\/span>/g) ?? []).length, gates.pass);
  assert.equal((html.match(/<span class="sr-only"> fail<\/span>/g) ?? []).length, gates.fail);
  assert.match(html, /<ul class="mk-rows" tabindex="-1" aria-label="Identity-gate verdicts">/);
});

test('static copy claims no live check: the verdicts are stored build-time results, nothing is hidden or armed without JavaScript', () => {
  assert.doesNotMatch(html, /data-reveal|Revealing|opacity/);
  assert.doesNotMatch(text, /\b(live|just now|verified on chain|recorded|demo|simulated|sample|mock)\b/i);
  assert.match(html, /<p class="status" id="mk-sweep-status" role="status" aria-live="polite">All 10 verdicts shown\./);
});

test('the page says the list only reveals build-time results; the list hydrates on idle so it can be armed before it is seen', () => {
  const page = read('src/pages/app/radar.astro');
  assert.match(page, /<RadarSweep client:idle rows=\{ROWS\} groups=\{true\} \/>/);
  assert.doesNotMatch(page, /client:visible rows=\{ROWS\}/);
  assert.match(page, /the list below only reveals them and computes nothing\./);
  assert.doesNotMatch(read('src/components/commerce/RadarSweep.tsx') + page, /[Rr]eplay/);
});

test('the sweep is arranged so it can never hide content for good: pending rows are not dimmed, the control is tappable', () => {
  const css = read('src/components/commerce/market.css');
  assert.doesNotMatch(css, /\.mk-row\.pending\{[^}]*opacity/);
  assert.doesNotMatch(css, /\.mk-gate\.wait\{[^}]*opacity/);
  assert.match(css, /\.mk-sweep-bar \.btn\{[^}]*min-height:var\(--tap\)/);
  assert.match(css, /\.mk-rows:focus-visible\{/);
  const src = read('src/components/commerce/RadarSweep.tsx');
  assert.doesNotMatch(src, /\bdisabled\b/, 'aria-disabled keeps focus; this control is removed instead, with focus handed to the list');
});
