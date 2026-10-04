// node --test test/market/recent-epochs-view.test.ts   (from apps/web)
// "Recent results" under the sealed book, rendered on the server: final on-chain results with their clearing transaction, orders
// in a keyboard-accessible disclosure, wallet names from the one label helper, and no playback wording anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNodeModule } from '../site/helpers/bundle.ts';

const { render, hhmmss } = await loadNodeModule<{ render(p: unknown): string; hhmmss(t: number): string }>(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { RecentEpochsView } from './src/components/market/RecentEpochs.tsx';
  export { hhmmss } from './src/components/market/mk-fmt.ts';
  export const render = (p) => renderToStaticMarkup(createElement(RecentEpochsView, p));
`);
const BOT = '0x269afaf16c8d2d31c30dca433b8c1495028dbb6f', OTHER = '0x' + '1'.repeat(40);
const label = (a: string) => (a === BOT ? { address: a, name: 'Bot 1', short: '0x269a…bb6f', bot: true } : { address: a, name: 'Agent B', short: '0x1111…1111', bot: false });
const T = Date.UTC(2026, 9, 3, 7, 58, 0) / 1000;
const row = (over: Record<string, unknown> = {}) => ({ epoch: 812, price: 1099, volume: 6, forfeited: 1, tx: '0x' + 'ab'.repeat(32), block: 128030547, time: T,
  orders: [{ index: 0, trader: BOT, hash: '0x1', side: 0, price: 1100, units: 6, filled: 6 }, { index: 1, trader: OTHER, hash: '0x2' }], buyOrders: 1, sellOrders: 0, ...over });
const EXP = 'https://explorer.testnet.chain.robinhood.com';

test('each row is the final result of a past epoch, with its clearing transaction on the explorer', () => {
  const html = render({ rows: [row()], ready: true, explorer: EXP, label });
  assert.match(html, /data-testid="recent-epochs"/);
  assert.match(html, /<li class="sb-recent-row" data-testid="recent-epoch" data-epoch="812" data-cents="1099">/);
  assert.match(html, /Final result of epoch 812/);
  assert.match(html, /Cleared at \$10\.99, 6 units · 1 bond forfeited · 1 buy order, 0 sell orders revealed/);
  assert.ok(html.includes(hhmmss(T)), 'local time, like the epochs table');
  assert.match(html, new RegExp('href="' + EXP + '/tx/0x(ab){32}" target="_blank" rel="noopener noreferrer"'));
  assert.match(html, /for epoch 812 \(opens the block explorer in a new tab\)/);
});

test('orders sit in a keyboard-accessible disclosure with wallet names and full addresses for screen readers', () => {
  const html = render({ rows: [row()], ready: true, explorer: EXP, label });
  assert.match(html, /<details class="sb-recent-orders"><summary>2 orders in epoch 812<\/summary>/);
  assert.match(html, new RegExp(`<th scope="row" title="${BOT}">Bot 1<span class="sr-only"> \\(scripted keeper bot, ${BOT}\\)</span></th>`));
  assert.match(html, new RegExp(`<th scope="row" title="${OTHER}">Agent B<span class="sr-only"> \\(${OTHER}\\)</span></th>`));
  assert.match(html, />never revealed</); assert.match(html, />bond forfeited</);
  assert.match(html, /role="region" aria-label="Orders in epoch 812" tabindex="0"/);
});

test('no cross, no explorer, empty and loading states; never playback words', () => {
  assert.match(render({ rows: [row({ volume: 0, forfeited: 0, orders: null, buyOrders: null, sellOrders: null })], ready: true, explorer: EXP, label }), /No cross, no trade</);
  assert.doesNotMatch(render({ rows: [row()], ready: true, explorer: '', label }), /<a /);
  assert.match(render({ rows: [], ready: true, explorer: EXP, label }), /data-testid="recent-empty">No cleared epoch in this market yet\./);
  assert.match(render({ rows: [], ready: false, explorer: EXP, label }), /Loading epoch history from the chain…/);
  const text = render({ rows: [row()], ready: true, explorer: EXP, label }).replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, /\b(replay|replaying|live|recorded|demo|simulated|sample)\b/i);
});

test('a failed or partial history load never says there are no results', () => {
  const failed = render({ rows: [], ready: true, error: 'fetch failed', explorer: EXP, label });
  assert.match(failed, /data-testid="recent-empty">Could not read the epoch history from the chain \(fetch failed\)\. Trying again on the next update\./);
  assert.doesNotMatch(failed, /No cleared epoch/);
  const partial = render({ rows: [], ready: true, complete: false, explorer: EXP, label });
  assert.match(partial, /No cleared epoch found in the history loaded so far; older history is still loading\./);
  assert.doesNotMatch(partial, /in this market yet/);
  assert.match(render({ rows: [], ready: true, complete: true, explorer: EXP, label }), /No cleared epoch in this market yet\./);
  assert.match(render({ rows: [row()], ready: true, error: 'fetch failed', explorer: EXP, label }), /Final result of epoch 812/, 'rows already loaded stay visible');
});

test('while the older history is still loading, an epoch whose clear is loaded shows no order counts and no order list (its orders may be in an older chunk)', () => {
  // the clear is loaded, but only one of this epoch's two orders is (the other commit sits in a chunk not fetched yet)
  const partial = row({ orders: [{ index: 1, trader: OTHER, hash: '0x2', side: 0, price: 1100, units: 6, filled: 6 }], buyOrders: 1, sellOrders: 0 });
  const html = render({ rows: [partial], ready: true, complete: false, explorer: EXP, label });
  assert.match(html, /Final result of epoch 812/); assert.match(html, /Cleared at \$10\.99, 6 units · 1 bond forfeited</);
  assert.doesNotMatch(html, /<details|buy order|sell order|Orders in epoch/);
  assert.match(html, /data-testid="recent-partial"/);
  const done = render({ rows: [partial], ready: true, complete: true, explorer: EXP, label });
  assert.match(done, /<details class="sb-recent-orders"><summary>1 order in epoch 812/); assert.doesNotMatch(done, /recent-partial/);
});
