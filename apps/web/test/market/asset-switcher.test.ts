// node --test test/market/asset-switcher.test.ts   (from apps/web)
// The asset switcher's pure logic over the REAL catalog (18 markets in 6 categories): order, groups, display strings, keyboard moves,
// type-ahead, announcement and the URL-hash rule; plus source pins for the component and market-app wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  orderedMarkets, toItems, groupItems, tagOf, sparkPoints, moveIndex, createTypeahead, announceText, nextAnnouncement, indexFromHash, symbolFromHash, changeText,
  NO_TRADE, PRICE_LOADING, PAGE_STEP, type SwitcherMarket,
} from '../../src/lib/asset-switcher.ts';
import { specForSymbol } from '../../src/components/market/product3d/specs.ts';

type Entry = { symbol: string; name: string; subtitle: string; category: string; accent: string };
const rd = (f: string) => readFileSync(new URL('../../src/' + f, import.meta.url), 'utf8');
const CATALOG = JSON.parse(rd('data/catalog.json')).markets as Entry[];
const SYMBOLS = CATALOG.map((c) => c.symbol);
const CATEGORIES = ['Phones', 'Audio', 'Gaming', 'Computing', 'Wearables', 'Accessories'];
const FMT = { usd: (c: number) => '$' + (c / 100).toFixed(2), pct: (f: number) => (f > 0 ? '+' : f < 0 ? '-' : '') + Math.abs(f * 100).toFixed(2) + '%' };
const market = (i: number, last = 0, prices: number[] = [], change = 0): SwitcherMarket =>
  ({ symbol: CATALOG[i].symbol, name: CATALOG[i].name, subtitle: CATALOG[i].subtitle, category: CATALOG[i].category, accent: CATALOG[i].accent, marketId: '0x' + String(i % 10).repeat(63) + (i < 10 ? '0' : '1'), last, change, prices });
const all = () => CATALOG.map((_, i) => market(i));

test('the catalog the switcher lists: 18 markets, 6 categories in catalog order, 12 products then the 6 Accessories', () => {
  assert.equal(CATALOG.length, 18);
  assert.equal(new Set(SYMBOLS).size, 18);
  assert.deepEqual([...new Set(CATALOG.map((c) => c.category))], CATEGORIES);
  assert.equal(CATALOG.filter((c) => c.category === 'Accessories').length, 6);
  assert.ok(CATALOG.slice(12).every((c) => c.category === 'Accessories'));
});

test('orderedMarkets: every catalog market in catalog order with its catalog index, whatever the store order; missing ones skipped', () => {
  const store = all().reverse();
  const out = orderedMarkets(CATALOG, store);
  assert.deepEqual(out.map((x) => x.index), CATALOG.map((_, i) => i));
  assert.deepEqual(out.map((x) => x.market.symbol), SYMBOLS);
  const partial = orderedMarkets(CATALOG, store.filter((m) => m.symbol !== SYMBOLS[1]));
  assert.equal(partial.length, 17);
  assert.ok(!partial.some((x) => x.index === 1));
});

test('toItems: 18 items, unique symbols and ids, grouped in catalog order; price, change, direction, points and sparkline per market', () => {
  const store = all();
  store[0] = market(0, 1059, [1000, 1059], 0.059); store[1] = market(1, 1199, [1199], 0); store[2] = market(2, 990, [1000, 990], -0.01);
  const pts: Record<string, number> = { [store[0].marketId]: 353, [store[1].marketId]: 1 };
  const items = toItems(CATALOG, store, (id) => pts[id] ?? 0, FMT, true);
  assert.equal(items.length, 18);
  assert.deepEqual(items.map((i) => i.symbol), SYMBOLS);
  assert.deepEqual(items.map((i) => i.index), CATALOG.map((_, i) => i));
  assert.equal(new Set(items.map((i) => i.symbol)).size, 18);
  assert.equal(new Set(items.map((i) => i.marketId)).size, 18, 'no duplicate market ids');
  assert.deepEqual(items[0], { index: 0, symbol: SYMBOLS[0], name: CATALOG[0].name, subtitle: CATALOG[0].subtitle, category: 'Phones', accent: CATALOG[0].accent, marketId: store[0].marketId,
    state: 'traded', last: 1059, points: 353, priceText: '$10.59', changeText: '+5.90%', dir: 'up', spark: '2.0,17.0 50.0,3.0' });
  assert.equal(items[1].changeText, '0.00%'); assert.equal(items[1].spark, ''); assert.equal(items[1].state, 'traded');
  assert.equal(items[2].dir, 'down'); assert.equal(items[2].changeText, '-1.00%');
  const none = items[17];
  assert.equal(none.state, 'none'); assert.equal(none.priceText, NO_TRADE); assert.equal(none.changeText, ''); assert.equal(none.dir, 'flat'); assert.equal(none.points, 0);
  assert.equal(changeText({ last: 0, change: 0.5, prices: [1, 2] }, FMT), '');
});

test('toItems: while the history is loading no option shows a price, a change or a sparkline (never a stale or empty claim)', () => {
  const store = all(); store[0] = market(0, 1059, [1000, 1059], 0.059);
  const items = toItems(CATALOG, store, () => 3, FMT, false);
  for (const it of items) { assert.equal(it.state, 'loading'); assert.equal(it.priceText, PRICE_LOADING); assert.equal(it.changeText, ''); assert.equal(it.spark, ''); assert.equal(it.dir, 'flat'); }
  assert.equal(PRICE_LOADING, '...');
  assert.ok(!items.some((i) => i.priceText.includes('$')));
});

test('toItems orders by category group (first appearance) even when the catalog interleaves categories; positions stay a flat 0..n-1 list', () => {
  const cat = [{ symbol: 'A1', category: 'X' }, { symbol: 'B1', category: 'Y' }, { symbol: 'A2', category: 'X' }];
  const ms = cat.map((c, i) => ({ ...market(0), symbol: c.symbol, category: c.category, marketId: '0x' + i }));
  const items = toItems(cat, ms, () => 0, FMT, true);
  assert.deepEqual(items.map((i) => i.symbol), ['A1', 'A2', 'B1']);
  assert.deepEqual(items.map((i) => i.index), [0, 2, 1], 'index stays the catalog index (selectMarket argument)');
});

test('groupItems: 6 groups in catalog order with the right sizes and flat start positions; group labels are the category names', () => {
  const items = toItems(CATALOG, all(), () => 0, FMT, true);
  const groups = groupItems(items);
  assert.equal(groups.length, 6);
  assert.deepEqual(groups.map((g) => g.category), CATEGORIES);
  assert.deepEqual(groups.map((g) => g.items.length), [4, 2, 3, 2, 1, 6]);
  assert.deepEqual(groups.map((g) => g.start), [0, 4, 6, 9, 11, 12]);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 18);
  assert.deepEqual(groups.flatMap((g) => g.items.map((i) => i.symbol)), SYMBOLS);
  for (const g of groups) for (const it of g.items) assert.equal(it.category, g.category);
  assert.deepEqual(groupItems([]), []);
});

test('tagOf: only Accessories carry a tag, so a case is never mistaken for a phone', () => {
  assert.equal(tagOf('Accessories'), 'Accessory');
  for (const c of CATEGORIES.slice(0, 5)) assert.equal(tagOf(c), '');
  for (const it of CATALOG.filter((c) => c.category === 'Accessories')) assert.match(it.subtitle, /case/i);
});

test('sparkPoints: the asset list geometry exactly; flat series sit on the baseline; fewer than two prices draw nothing', () => {
  assert.equal(sparkPoints([1, 2, 3]), '2.0,17.0 26.0,10.0 50.0,3.0');
  assert.equal(sparkPoints([5, 5, 5]), '2.0,17.0 26.0,17.0 50.0,17.0');
  assert.equal(sparkPoints([7]), ''); assert.equal(sparkPoints([]), '');
  assert.equal(sparkPoints([1, 3], 100, 40), '2.0,37.0 98.0,3.0');
});

test('moveIndex: Down/Up stop at the ends, Home/End jump, PageUp/PageDown move a page and clamp, other keys and empty lists give null', () => {
  const n = 18;
  assert.equal(moveIndex(0, 'ArrowDown', n), 1); assert.equal(moveIndex(n - 1, 'ArrowDown', n), n - 1);
  assert.equal(moveIndex(1, 'ArrowUp', n), 0); assert.equal(moveIndex(0, 'ArrowUp', n), 0);
  assert.equal(moveIndex(3, 'Home', n), 0); assert.equal(moveIndex(0, 'End', n), n - 1);
  assert.equal(PAGE_STEP, 10);
  assert.equal(moveIndex(2, 'PageDown', n), 12); assert.equal(moveIndex(12, 'PageDown', n), 17); assert.equal(moveIndex(17, 'PageDown', n), 17);
  assert.equal(moveIndex(15, 'PageUp', n), 5); assert.equal(moveIndex(5, 'PageUp', n), 0); assert.equal(moveIndex(0, 'PageUp', n), 0);
  assert.equal(moveIndex(0, 'Enter', n), null); assert.equal(moveIndex(0, 'ArrowDown', 0), null);
});

test('typeahead: symbol, name and subtitle prefixes; a search string; repeated letters cycle; the buffer resets after the timeout', () => {
  let t = 1000; const ta = createTypeahead(500, () => t);
  const items = CATALOG;
  const idx = (s: string) => SYMBOLS.indexOf(s);
  assert.equal(ta.key('s', items, 0), idx('S26'));                // symbol prefix, first match after the current option
  t += 600; assert.equal(ta.key('g', items, 0), idx('S26'));      // name prefix "Galaxy S26", case-insensitive, after a reset
  t += 600; assert.equal(ta.key('s', items, 0), idx('S26')); t += 100; assert.equal(ta.key('o', items, 0), idx('XM6'), 'subtitle "Sony headphones"');
  t += 600; ta.key('i', items, 0); t += 100; ta.key('p', items, 0); t += 100; ta.key('1', items, 0); t += 100;
  assert.equal(ta.key('5', items, 0), idx('IP15P-CLR'));         // "ip15" typed as one string
  assert.equal(ta.typing(), true); t += 501; assert.equal(ta.typing(), false);
  t += 600; const first = ta.key('i', items, 0)!; t += 100; const second = ta.key('i', items, first)!;
  assert.ok(first !== second && SYMBOLS[first].startsWith('I') && SYMBOLS[second].startsWith('I'), 'repeating one letter moves to the next match');
  t += 600; assert.equal(ta.key('z', items, 2), null);
  ta.reset(); assert.equal(ta.typing(), false);
  assert.equal(createTypeahead(500, () => 0).key('a', [], 0), null);
});

test('typeahead: typing any market symbol in full lands on that market, from any starting option, across all six groups', () => {
  let t = 0;
  for (const start of [0, 7, 17]) for (const [want, sym] of SYMBOLS.entries()) {
    const ta = createTypeahead(500, () => t); t += 1000;
    let cur = start; let got: number | null = null;
    for (const ch of sym) { t += 50; got = ta.key(ch, CATALOG, cur); assert.notEqual(got, null, `${sym}: no match at "${ch}"`); cur = got!; }
    assert.equal(cur, want, `typing ${sym} from ${start} landed on ${SYMBOLS[cur]}`);
  }
});

test('typeahead: the name start and the subtitle start select across groups ("iPad", "Meta", "Clear case for Pixel")', () => {
  let t = 0; const type = (s: string, start = 0) => { const ta = createTypeahead(500, () => t); t += 1000; let cur = start; for (const ch of s) { t += 50; cur = ta.key(ch, CATALOG, cur) ?? cur; } return SYMBOLS[cur]; };
  assert.equal(type('meta quest'), 'Q3S');
  assert.equal(type('nintendo'), 'NSW2');
  assert.equal(type('playstation'), 'PS5');
  assert.equal(type('ipad'), 'IPAD');
  assert.equal(type('clear case for pixel'), 'PX9-CLR');
  assert.equal(type('clear magsafe case for iphone 16 pro max'), 'IP16PM-CLR');
  assert.equal(type('apple smartwatch'), 'AW12');
});

test('announceText: symbol and last price, or that it has not traded, or that it is still loading', () => {
  assert.equal(announceText({ symbol: 'IP18P', last: 1059 }, true, FMT), 'Selected IP18P, last price $10.59');
  assert.equal(announceText({ symbol: 'PX9-CLR', last: 0 }, true, FMT), 'Selected PX9-CLR, no trade yet');
  assert.equal(announceText({ symbol: 'PX9-CLR', last: 0 }, false, FMT), 'Selected PX9-CLR, price loading');
  assert.equal(announceText({ symbol: 'IP18P', last: 1059 }, false, FMT), 'Selected IP18P, price loading', 'a price is never announced while loading');
});

test('nextAnnouncement: the live region text always changes, so choosing the same market again is announced again', () => {
  const t = 'Selected IP18P, last price $10.59';
  assert.equal(nextAnnouncement('', t), t, 'first announcement is the text itself');
  assert.equal(nextAnnouncement('Selected PS5, no trade yet', t), t, 'a different previous text is replaced unchanged');
  const again = nextAnnouncement(t, t);
  assert.notEqual(again, t, 'identical text would not mutate the aria-live node, so nothing would be read out');
  assert.equal(again.trim(), t, 'only whitespace differs');
  assert.equal(again.replace(/\s+/g, ' ').trim(), t, 'whitespace-normalised readers (and the probe) see the same sentence');
  assert.notEqual(nextAnnouncement(again, t), again, 'and it keeps toggling on every further repeat');
  assert.equal(nextAnnouncement(again, t).trim(), t);
  assert.equal(nextAnnouncement(t, 'Selected IP18P, last price $10.60'), 'Selected IP18P, last price $10.60', 'a new price after a rollover is a plain replacement');
});

test('AssetSwitcher.commit announces on every commit and reads the price from the store at announce time', () => {
  const src = rd('components/market/AssetSwitcher.tsx');
  const commit = /const commit = \(p: number\) => \{[\s\S]*?\n  \};/.exec(src)?.[0] ?? '';
  assert.ok(commit, 'commit() found');
  assert.ok(!/it\.index === sel\.index\) return/.test(commit), 'no early return that skips the announcement when the market is already selected');
  assert.match(commit, /announce\(/, 'commit announces');
  assert.match(src, /marketStore\.getState\(\)/, 'the announced price is read from the live store, not from a render-time closure');
  assert.match(src, /nextAnnouncement\(/);
});

test('the URL hash: every symbol (with "-" for the cases) round-trips plain and percent-encoded; unknown, empty or malformed hashes fall back to 0', () => {
  for (const [i, s] of SYMBOLS.entries()) {
    assert.equal(indexFromHash('#' + s, SYMBOLS), i, s); assert.equal(indexFromHash(s, SYMBOLS), i);
    assert.equal(indexFromHash('#' + encodeURIComponent(s).replace(/-/g, '%2D'), SYMBOLS), i, s + ' encoded');
    assert.equal(symbolFromHash('#' + s), s);
  }
  assert.equal(indexFromHash('#NOPE', SYMBOLS), 0);
  assert.equal(indexFromHash('', SYMBOLS), 0);
  assert.equal(indexFromHash('#', SYMBOLS), 0);
  assert.equal(indexFromHash('#%E0%A4%A', SYMBOLS), 0);        // decodeURIComponent throws on this
  assert.equal(symbolFromHash('#%E0%A4%A'), '');
  assert.equal(symbolFromHash(''), '');
  assert.equal(indexFromHash('#' + SYMBOLS[5].toLowerCase(), SYMBOLS), 0);
});

test('market-app reads the URL hash through the pure helper (a malformed hash cannot throw at module load or on hashchange) and a switcher choice goes through selectMarket', () => {
  const src = rd('lib/market-app.ts');
  assert.ok(src.includes("import { symbolFromHash } from './asset-switcher.ts';"));
  assert.ok(src.includes('symbolFromHash(window.location.hash)'));
  assert.ok(!src.includes('decodeURIComponent('), 'the hash is decoded only inside the pure helper');
  assert.ok(/export const selectedIndex = /.test(src));
});

test('Product3D follows the selection: all 18 symbols resolve to distinct real specs (symbol, kind) and the component keys its spec and data-model on the selected symbol', () => {
  const specs = SYMBOLS.map((s) => specForSymbol(s));
  assert.deepEqual(specs.map((s) => s.symbol), SYMBOLS);
  assert.equal(new Set(specs.map((s) => s.symbol)).size, 18);
  assert.ok(specs.every((s) => s.kind !== 'generic'));
  assert.deepEqual(specs.map((s) => s.kind === 'case'), CATALOG.map((c) => c.category === 'Accessories'));
  const p3d = rd('components/market/Product3D.tsx');
  assert.ok(p3d.includes('specForSymbol(m.symbol), [m.symbol]'));
  assert.ok(p3d.includes('data-model={m.symbol}'));
  assert.ok(p3d.includes('setProduct(spec, accent)'));
});
