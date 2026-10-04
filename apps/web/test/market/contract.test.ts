// node --test test/market/contract.test.ts   (from apps/web)
// The browser e2e scripts (scripts/e2e-market.cjs, scripts/e2e-browser.cjs) drive the terminal through
// these data-testids and attributes. This test fails as soon as one silently disappears from the components.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const src = (f: string) => readFileSync(new URL('../../src/components/market/' + f, import.meta.url), 'utf8');
const ALL = ['Terminal.tsx', 'AssetList.tsx', 'PriceChart.tsx', 'EpochClock.tsx', 'SealedBook.tsx', 'Product3D.tsx', 'Tape.tsx', 'AssetSwitcher.tsx'].map(src).join('\n');
const CONTRACT: [string, string[]][] = [
  ['Terminal.tsx', ['data-testid="market-terminal"', 'data-ready={', 'data-selected={', 'data-testid="last-price"', 'data-testid="chain-stalled"', 'data-testid="testnet-note"', 'data-history={', 'data-source={', '<AssetSwitcher />', '<SealedBook key={sel.marketId} marketId={sel.marketId} />']],
  ['AssetList.tsx', ['data-testid="asset-row"']],
  ['PriceChart.tsx', ['data-testid="price-chart"', 'data-points={']],
  ['EpochClock.tsx', ['data-testid="epoch-clock"', 'data-phase={']],
  ['SealedBook.tsx', ['data-testid="sealed-book"', 'data-phase={', 'data-sealed-count={', 'data-revealed-count={', 'data-cleared={', 'data-testid="clearing-price"', 'data-testid="order-chip"']],
  ['AgentsRound.tsx', ['data-testid="agents-round"', 'data-testid="agent-card"', 'data-label={']],
  ['RecentEpochs.tsx', ['data-testid="recent-epochs"', 'data-testid="recent-epoch"', 'data-epoch={', 'data-testid="recent-empty"']],
  ['BotStatus.tsx', ['data-testid="bot-status"', 'data-state={']],
  ['Product3D.tsx', ['data-testid="product-3d"', 'data-mode={']],
  ['Tape.tsx', ['data-testid="tape-row"', 'data-market-id={lc(f.marketId)}']],
  ['AssetSwitcher.tsx', ['data-testid="asset-switcher"', 'data-testid="asset-switcher-trigger"', 'data-selected={settled ? cur.symbol', 'data-testid="asset-option"', 'data-symbol={it.symbol}', 'data-category={it.category}', 'data-market-id={', 'data-last={', 'data-points={', 'data-state={', 'role="combobox"', 'role="listbox"', 'role="option"', 'role="group"', 'aria-labelledby={', 'aria-activedescendant={', 'aria-live="polite"']],
];

for (const [file, needles] of CONTRACT) {
  test(`${file} keeps its e2e hooks`, () => { const s = src(file); for (const n of needles) assert.ok(s.includes(n), `${file} lost ${n}`); });
}

test('every testid the market e2e script uses exists in a market component', () => {
  const e2e = readFileSync(new URL('../../../../scripts/e2e-market.cjs', import.meta.url), 'utf8');
  const ids = new Set([...e2e.matchAll(/T\(page, '([a-z0-9-]+)'\)/g), ...e2e.matchAll(/data-testid="([a-z0-9-]+)"/g)].map((m) => m[1]));
  assert.ok(ids.size >= 8, `found ${ids.size} ids`);
  for (const id of ids) assert.ok(ALL.includes(`data-testid="${id}"`), `e2e uses ${id}, no component renders it`);
});

test('data-ready means "last price and recent chart usable", not "full history loaded"', () => {
  const t = src('Terminal.tsx');
  assert.ok(t.includes("data-ready={s.ready ? 'true' : 'false'}"));
  assert.ok(t.includes("data-history={s.historyComplete ? 'complete' : 'partial'}"));
});

test('one display name per wallet: chips, tape and agent cards all go through market-view walletLabel (via market-app labelWallet)', () => {
  for (const f of ['SealedBook.tsx', 'Tape.tsx']) { const s = src(f); assert.ok(s.includes('labelWallet('), `${f} names wallets with labelWallet`); assert.ok(!/const short(Addr)? = /.test(s), `${f} has its own address shortener`); }
  assert.ok(src('AgentsRound.tsx').includes('agentCards(chips, traders, bond, bots)'));
  assert.ok(src('SealedBook.tsx').includes('bots={KEEPER_BOTS}'));
  // the Agent column: a visible header cell, six grid tracks in header and rows at desktop and at phone width, the name cell can shrink (no horizontal page scroll at 390 px)
  assert.ok(src('Tape.tsx').includes('<span>Side</span><span>Agent</span><span>Price</span>'));
  const css = src('market.css'), tail = css.slice(css.indexOf('Trade tape: Agent column'));
  assert.equal((tail.match(/grid-template-columns:[^;}]*/g) ?? []).map((t) => t.replace('grid-template-columns:', '').trim().split(/\s+(?![^(]*\))/).length).join(','), '6,6', 'desktop and phone grids both have 6 tracks');
  assert.ok(/\.mk-tr \.mk-who\{[^}]*min-width:0[^}]*text-overflow:ellipsis/.test(tail));
});
test('the sealed book has no playback mode: no replay button, note, badge, data-mode or styles; it mounts Recent results', () => {
  for (const f of ['SealedBook.tsx', 'AgentsRound.tsx', 'RecentEpochs.tsx']) assert.doesNotMatch(src(f), /replay/i, `${f} still mentions a replay`);
  const sb = src('SealedBook.tsx');
  for (const gone of ['data-mode=', 'sb-btn', 'requestAnimationFrame']) assert.ok(!sb.includes(gone), `SealedBook still has ${gone}`);
  assert.ok(sb.includes('<RecentEpochs marketId={marketId} />'));
  assert.doesNotMatch(readFileSync(new URL('../../src/components/market/book.css', import.meta.url), 'utf8'), /replay|\.sb-btn\b/i, 'book.css keeps no replay styles');
});
test('honest load states: old-history errors stay quiet, a total failure keeps skeletons, the retry copy matches the backoff', () => {
  for (const f of ['Terminal.tsx', 'PriceChart.tsx', 'Tape.tsx', 'EpochsTable.tsx', 'SealedBook.tsx', 'RecentEpochs.tsx', 'BotStatus.tsx', 'AgentsRound.tsx']) assert.ok(!src(f).includes('historyError'), `${f} renders historyError`);
  // RecentEpochs.tsx is not in this list on purpose: its empty text already says 'Could not read the epoch history' when the store has an error, never 'no cleared epoch'
  for (const f of ['Terminal.tsx', 'PriceChart.tsx', 'Tape.tsx', 'EpochsTable.tsx']) assert.ok(src(f).includes('loadFailed(s)'), `${f} ignores a total load failure`);
  const t = src('Terminal.tsx');
  assert.ok(!t.includes('Retrying every 2 seconds'), 'the backoff grows to 30 s');
  assert.ok(t.includes('tradeStats(all)') && t.includes('changeWindow(all)'), 'stats from the fold-aware helpers');
});
test('default selection: an explicit #hash wins, else the first market with a clearing price, decided by market-app only until the user chooses', () => {
  const app = readFileSync(new URL('../../src/lib/market-app.ts', import.meta.url), 'utf8');
  for (const n of ['pickDefaultMarket', 'settleSelection', 'locked: true']) assert.ok(app.includes(n), `market-app lost ${n}`);
  assert.ok(/export function selectMarket\(i: number\) \{[^}]*locked: true/.test(app), 'a user choice locks the selection');
});
test('the asset switcher has its own test ids (the browser e2e counts the asset list rows), selects through selectMarket and lists every market grouped by category', () => {
  const sw = src('AssetSwitcher.tsx');
  assert.ok(!sw.includes('asset-row'), 'AssetSwitcher must not render the asset list row id');
  assert.ok(sw.includes('selectMarket(it.index)'));
  assert.equal((src('Terminal.tsx').match(/<AssetSwitcher \/>/g) ?? []).length, 1);
  assert.ok(sw.includes('groupItems(items)') && sw.includes('{g.category}'), 'options sit in role=group blocks labelled with their category');
  assert.ok(sw.includes('tagOf(') && sw.includes('{it.subtitle}') && sw.includes('<Ident it={cur} />') && sw.includes('<Ident it={it} />'), 'trigger and options say what each market is (subtitle) and tag Accessories');
  assert.ok(sw.includes("e.key === 'Escape'") || sw.includes("k === 'Escape'"), 'Escape closes');
  assert.ok(sw.includes('scrollIntoView'), 'the active option scrolls into view in the 18-row list');
  assert.ok(sw.includes('loaded') && sw.includes('s.ready && !loadFailed(s)'), 'no price while the history is loading (the terminal rule)');
  assert.ok(src('Product3D.tsx').includes('key={String(m.marketId)}'), 'the price live region is keyed by market (no double announcement)');
  const css = src('asset-switcher.css');
  assert.ok(/\.asw-list\{[^}]*max-height:[^;}]*;[^}]*overflow:auto/.test(css), 'the list scrolls inside a max-height');
});

test('no "order book" wording in the market components (user-facing text and aria; code comments may use it)', () => {
  for (const f of readdirSync(new URL('../../src/components/market/', import.meta.url)).filter((n) => /\.tsx$/.test(n))) {
    const code = src(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /order\s?book/i, `${f} says "order book"`);
  }
});
