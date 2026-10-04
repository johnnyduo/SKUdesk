// node --test test/market/selection-skeleton.test.ts   (from apps/web)
// Before the default selection has settled (no explicit #hash, store not ready) the terminal must not show a guessed market that swaps a
// moment later: the server render (and the hydration pass) is a neutral skeleton. Renders the REAL Terminal on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// like test/site/helpers/bundle.ts, but the terminal imports stylesheets (ignored here) and three.js (only ever imported lazily in the browser)
const root = fileURLToPath(new URL('../../', import.meta.url));
async function renderEntry(contents: string): Promise<{ html: string }> {
  const out = await build({
    stdin: { contents, resolveDir: root, loader: 'tsx', sourcefile: 'entry.tsx' }, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', target: 'es2022', logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr('file:///x.mjs');" }, define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' }, external: ['three'],
  });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
}

const { html } = await renderEntry(`
  import { createElement } from 'react';
  import { renderToString } from 'react-dom/server';
  import Terminal from './src/components/market/Terminal.tsx';
  export const html = renderToString(createElement(Terminal));
`);
const CATALOG = JSON.parse(readFileSync(new URL('../../src/data/catalog.json', import.meta.url), 'utf8')).markets as { symbol: string; name: string; subtitle: string; id: string; category: string }[];
const first = CATALOG[0];
/** The markup of the element that starts at `open` and runs to its matching close tag. */
const block = (open: RegExp, tag: string): string => {
  const m = open.exec(html); assert.ok(m, `${open} present`);
  let i = m!.index, depth = 0; const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g'); re.lastIndex = i; let t;
  while ((t = re.exec(html))) { depth += t[1] ? -1 : 1; if (depth === 0) return html.slice(i, re.lastIndex); }
  throw new Error('unbalanced ' + tag);
};

test('server render: the terminal is not ready, selected nothing, not settled', () => {
  assert.match(html, /data-testid="market-terminal" data-ready="false" data-selected="" data-settled="false"/);
});

test('hero skeleton: aria-busy, same stat boxes, no symbol, name, price, reference or source line of any market', () => {
  const hero = block(/<section class="mk-panel mk-stats"/, 'section');
  assert.match(hero, /aria-busy="true"/); assert.match(hero, /data-testid="hero-skeleton"/);
  for (const k of ['Last price', 'Change', 'High', 'Low', 'Volume', 'Trades']) assert.ok(hero.includes(`<span class="mk-k">${k}</span>`), k);
  assert.ok(!hero.includes(first.symbol) && !hero.includes(first.name), 'no guessed market');
  for (const m of CATALOG) assert.ok(!hero.includes(`>${m.symbol}<`), `no ${m.symbol} in the hero`);
  assert.doesNotMatch(hero, /no trade yet|\$\d|data-testid="last-price"|price-source/i, 'neither a price nor "no trade yet" nor a reference');
  assert.match(hero, /aria-label="Market summary"/, 'the label does not name a market');
});

test('3D panel: the viewer is not mounted, only the empty placeholder box (aria-busy), nothing names a market', () => {
  const panel = block(/<div class="mk-panel mk-p3d o2"/, 'div');
  assert.match(panel, /aria-busy="true"/); assert.match(panel, /class="p3d p3d-ph" aria-hidden="true"/);
  assert.ok(!panel.includes('data-testid="product-3d"') && !panel.includes(first.name) && !panel.includes(first.symbol));
});

test('product facts: skeleton without SKU, category or reference price', () => {
  const facts = block(/<section class="mk-panel mk-facts-p o1"/, 'section');
  assert.match(facts, /aria-busy="true"/);
  assert.ok(!facts.includes(first.id) && !facts.includes(first.category) && !/\$\d/.test(facts) && !facts.includes('pf-sku'));
});

test('switcher trigger: no selected symbol or category until settled', () => {
  const trig = /<div[^>]*data-testid="asset-switcher-trigger"[^>]*>/.exec(html)![0];
  assert.match(trig, /data-selected=""/); assert.match(trig, /data-category=""/); assert.match(trig, /aria-busy="true"/);
  const box = block(/<div[^>]*data-testid="asset-switcher-trigger"/, 'div');
  assert.ok(!box.includes(first.name) && !box.includes(`>${first.symbol}<`));
});

test('markets list: busy, no row marked selected, no "no trade yet" guess; every market is still listed', () => {
  const list = block(/<section class="mk-panel mk-assets o1"/, 'section');
  assert.match(list, /aria-busy="true"/);
  assert.ok(!list.includes('aria-current'), 'no row selected yet'); assert.ok(!list.includes('aria-pressed="true"'));
  assert.ok(!/class="mk-ar on"/.test(list)); assert.ok(!/no trade yet/.test(list));
  assert.equal((list.match(/data-testid="asset-row"/g) ?? []).length, CATALOG.length);
});

test('market-app: useSelectionSettled wiring (server and hydration see the skeleton; an explicit hash settles at once)', () => {
  const app = readFileSync(new URL('../../src/lib/market-app.ts', import.meta.url), 'utf8');
  assert.ok(app.includes('isSettled(settleSelection({ index: sel.index, locked }, s.markets, s.ready), s.ready, explicitHash())'));
  assert.ok(app.includes('() => false, () => true'), 'hydration pass renders the skeleton like the server');
  assert.ok(app.includes("if (explicitHash()) sel = { index: pickDefaultMarket(withLast(() => 0), hashSymbol()), locked: true };"), 'a valid hash locks the selection at load');
});
