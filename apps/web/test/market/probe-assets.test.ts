// node --test test/market/probe-assets.test.ts   (from apps/web)
// The browser probe (scripts/probe-assets.cjs) decides pass/fail with the pure functions of scripts/probe-assets-lib.cjs; here they are
// checked without a browser: argument parsing, price bands, the empty-state classification, per-market isolation checks, hash helpers,
// the spin rule and the report table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Check = { key: string; ok: boolean; detail: string };
const require = createRequire(import.meta.url);
const lib = require('../../../../scripts/probe-assets-lib.cjs') as {
  COLS: string[]; BAND: number; NO_TRADE: string;
  parseArgs(argv: string[], env?: Record<string, string | undefined>): { base: string | null; reduced: boolean; help: boolean; unknown: string[] };
  parseUsd(text: string): number | null; usdText(cents: number): string;
  inBand(cents: number, reference: number, band?: number): boolean;
  expectedKind(entry: { symbol: string; category: string }): string | null;
  classify(opt: { state?: string; last: number; points: number }): 'traded' | 'empty' | 'loading' | 'inconsistent';
  pickDefault(opts: { symbol: string; last: number }[], hash: string): number;
  expectedFor(entry: any, opt: any): any;
  checkMarket(snap: any, exp: any, prev: any, ctx?: { announce?: boolean; seen?: string[] }): Check[];
  announceCheck(announce: string, exp: any, seen?: string[]): { ok: boolean; detail: string };
  sameImage(a: string | null, b: string | null): boolean; hashOf(buf: Uint8Array | string): string;
  spinCheck(a: { mode: string; shotsDiffer: boolean; rotA: string | null; rotB: string | null; reduced: boolean }): Check;
  modelCheck(a: { reduced: boolean; hash: string | null; others: Record<string, string> }, symbol: string): Check;
  BLANK_BYTES: number; seriesOf(snap: any): string;
  seriesCollisions(rows: { symbol: string; series: string }[]): string[][];
  formatTable(rows: any[]): string; summaryLine(rows: any[], count: number, problems: string[]): string;
};

const CASE = { symbol: 'IP16-CLR', name: 'iPhone 16 Clear MagSafe Case', category: 'Accessories', referenceCents: 1049 };
const DEV = { symbol: 'PS5', name: 'PlayStation 5', category: 'Gaming', referenceCents: 64999 };
const A = lib.expectedFor(CASE, { marketId: '0xAA', last: 1059, points: 142 });
const E = lib.expectedFor(DEV, { marketId: '0xBB', last: 0, points: 0 });
const good = (e: any) => ({
  selected: e.symbol, trigSelected: e.symbol, statsSymbol: e.symbol, lastPrice: e.priceText,
  high: e.traded ? e.priceText : '-', low: e.traded ? e.priceText : '-', trades: e.traded ? String(e.points) : '-',
  chartPoints: e.points, chartLabel: `Price chart, ${e.symbol}`, chartEmpty: e.traded ? '' : 'No trade yet',
  tapeIds: e.traded ? [e.marketId, e.marketId] : [], tapeHead: e.symbol, tapeEmpty: e.traded ? '' : `No fills yet for ${e.symbol}.`,
  epochsHead: `${e.symbol} · last ${e.traded ? 30 : 0}`, epochRows: e.traded ? Array.from({ length: 30 }, (_, i) => ({ epoch: 100 + i, price: e.priceText })) : [],
  recent: e.traded ? [{ epoch: 129, cents: String(e.last) }] : [],
  bookCount: 1,
  p3dMarket: e.symbol, p3dModel: e.symbol, p3dKind: e.kind, p3dMode: 'webgl', p3dLast: e.traded ? String(e.last) : '', p3dPrice: e.priceText === lib.NO_TRADE ? 'No trade yet' : e.priceText,
  canvasLabel: `Rotatable 3D model of ${e.name}. Drag or use arrow keys to rotate.`,
  trigText: `${e.symbol} ${e.name} ${e.priceText}`, trigPrice: e.priceText, announce: e.traded ? `Selected ${e.symbol}, last price ${e.priceText}` : `Selected ${e.symbol}, no trade yet`,
});
const failed = (r: Check[]) => r.filter((c) => !c.ok).map((c) => c.key);

test('parseArgs: base url argument or env, --reduced-motion, unknown flags reported, --help', () => {
  assert.deepEqual(lib.parseArgs([]), { base: null, reduced: false, help: false, unknown: [] });
  assert.deepEqual(lib.parseArgs(['http://127.0.0.1:4394/', '--reduced-motion']), { base: 'http://127.0.0.1:4394', reduced: true, help: false, unknown: [] });
  assert.equal(lib.parseArgs([], { BASE_URL: 'https://example.test/' }).base, 'https://example.test');
  assert.equal(lib.parseArgs(['http://a.test'], { BASE_URL: 'http://b.test' }).base, 'http://a.test', 'the argument wins over the env');
  assert.deepEqual(lib.parseArgs(['--reduced-motion', '--bogus']).unknown, ['--bogus']);
  assert.equal(lib.parseArgs(['-h']).help, true);
});

test('parseUsd / usdText: the terminal dollar format both ways, null for anything else', () => {
  assert.equal(lib.parseUsd('$10.59'), 1059); assert.equal(lib.parseUsd('$1,199.00'), 119900); assert.equal(lib.parseUsd(' $0.05 '), 5);
  assert.equal(lib.parseUsd('$1296.43'), null, 'a price of $1,000 or more without its thousands separator is the /market formatting bug, not a price');
  assert.equal(lib.parseUsd('$12,96.43'), null); assert.equal(lib.parseUsd('$1,296.43'), 129643);
  assert.equal(lib.parseUsd('no trade yet'), null); assert.equal(lib.parseUsd(''), null); assert.equal(lib.parseUsd('$10'), null); assert.equal(lib.parseUsd('10.59'), null);
  assert.equal(lib.usdText(1059), '$10.59'); assert.equal(lib.usdText(119900), '$1,199.00');
});

test('inBand: +-25% of the catalog reference catches unit and decimal bugs', () => {
  assert.equal(lib.BAND, 0.25);
  assert.equal(lib.inBand(1059, 1049), true); assert.equal(lib.inBand(1311, 1049), true); assert.equal(lib.inBand(1312, 1049), false);
  assert.equal(lib.inBand(787, 1049), true); assert.equal(lib.inBand(786, 1049), false);
  assert.equal(lib.inBand(105900, 1049), false, 'a x100 unit bug');
  assert.equal(lib.inBand(10, 1049), false, 'a /100 decimal bug');
  assert.equal(lib.inBand(0, 1049), false); assert.equal(lib.inBand(500, 0), false);
});

test('expectedKind: Accessories are cases, phones are phones, every other catalog device has its own kind, unknown => null', () => {
  assert.equal(lib.expectedKind({ symbol: 'IP16-CLR', category: 'Accessories' }), 'case');
  assert.equal(lib.expectedKind({ symbol: 'S25-CLR', category: 'Accessories' }), 'case');
  assert.equal(lib.expectedKind({ symbol: 'IP18P', category: 'Phones' }), 'phone');
  const kinds = Object.fromEntries([['APP3', 'earbuds'], ['XM6', 'headphones'], ['NSW2', 'handheld'], ['Q3S', 'vr'], ['PS5', 'console'], ['MBA13', 'laptop'], ['IPAD', 'tablet'], ['AW12', 'watch']]);
  for (const [s, k] of Object.entries(kinds)) assert.equal(lib.expectedKind({ symbol: s, category: 'Other' }), k, s);
  assert.equal(lib.expectedKind({ symbol: 'NEW1', category: 'Gaming' }), null, 'a market without a known model fails loudly instead of passing as generic');
});

test('classify: traded / empty / loading, and last-vs-points disagreement is inconsistent', () => {
  assert.equal(lib.classify({ state: 'traded', last: 1059, points: 3 }), 'traded');
  assert.equal(lib.classify({ state: 'none', last: 0, points: 0 }), 'empty');
  assert.equal(lib.classify({ state: 'loading', last: 0, points: 0 }), 'loading');
  assert.equal(lib.classify({ state: 'traded', last: 1059, points: 0 }), 'inconsistent');
  assert.equal(lib.classify({ state: 'none', last: 0, points: 4 }), 'inconsistent');
  assert.equal(lib.classify({ last: 500, points: 2 }), 'traded', 'without a state attribute the numbers decide');
});

test('pickDefault mirrors pickDefaultMarket: valid hash > first traded market > index 0', () => {
  const o = (l: number[]) => l.map((last, i) => ({ symbol: `S${i}`, last }));
  assert.equal(lib.pickDefault(o([0, 0, 500, 700]), 'S3'), 3); assert.equal(lib.pickDefault(o([0, 0, 500, 700]), 'S1'), 1);
  assert.equal(lib.pickDefault(o([0, 0, 500, 700]), ''), 2); assert.equal(lib.pickDefault(o([0, 0, 500, 700]), 'NOPE'), 2);
  assert.equal(lib.pickDefault(o([0, 0, 0]), ''), 0);
});

test('expectedFor: lower-case ids, kind, traded flag, "no trade yet" for an untraded market, band flag', () => {
  assert.equal(A.marketId, '0xaa'); assert.equal(A.priceText, '$10.59'); assert.equal(A.traded, true); assert.equal(A.kind, 'case'); assert.equal(A.bandOk, true);
  assert.equal(E.priceText, lib.NO_TRADE); assert.equal(E.traded, false); assert.equal(E.kind, 'console'); assert.equal(E.bandOk, true, 'an empty market has no price to band-check');
  assert.equal(lib.expectedFor(CASE, { marketId: '0xaa', last: 105900, points: 3 }).bandOk, false);
});

test('checkMarket: a correct traded page and a correct EMPTY page pass every column', () => {
  const rt = lib.checkMarket(good(A), A, null, { announce: true });
  assert.deepEqual(rt.map((c) => c.key), ['selected', 'price', 'band', 'stats', 'points', 'tape', 'epochs', 'book', 'model', 'kind', 'empty', 'trigger', 'announce']);
  assert.deepEqual(failed(rt), []);
  assert.deepEqual(failed(lib.checkMarket(good(E), E, A, { announce: true })), [], 'an untraded market passes through the explicit empty column, no price required');
  assert.deepEqual(failed(lib.checkMarket({ ...good(A), p3dMode: 'loading', canvasLabel: '' }, A, null)), [], 'no canvas yet is not a failure of the label');
});

test('checkMarket: the empty market must SAY it is empty everywhere and show no price', () => {
  assert.deepEqual(failed(lib.checkMarket({ ...good(E), lastPrice: '$5.00' }, E, null)), ['price', 'empty']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(E), chartPoints: 3 }, E, null)), ['points', 'empty']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(E), chartEmpty: '' }, E, null)), ['empty']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(E), tapeIds: [E.marketId] }, E, null)), ['tape', 'empty']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(E), p3dPrice: '$5.00', p3dLast: '500' }, E, null)), ['model', 'empty']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(E), high: '$9.00' }, E, null)), ['stats', 'empty']);
});

test('checkMarket: isolation, a previous market still visible is caught in every panel', () => {
  const B = lib.expectedFor({ symbol: 'S25-CLR', name: 'Galaxy S25 Clear Case', category: 'Accessories', referenceCents: 899 }, { marketId: '0xbb', last: 902, points: 144 });
  assert.deepEqual(failed(lib.checkMarket(good(B), B, A)), []);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), lastPrice: A.priceText }, B, A)), ['price', 'stale']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), tapeHead: A.symbol }, B, A)), ['tape', 'stale']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), epochsHead: `${A.symbol} · last 30` }, B, A)), ['epochs', 'stale']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), tapeIds: [B.marketId, A.marketId] }, B, A)), ['tape']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), tapeIds: Array(41).fill(B.marketId) }, B, A)), ['tape']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), chartPoints: A.points }, B, A)), ['points']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), chartLabel: `Price chart, ${A.symbol}` }, B, A)), ['points']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), p3dModel: A.symbol }, B, A)), ['model', 'stale']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), p3dKind: 'phone' }, B, A)), ['kind']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), canvasLabel: good(A).canvasLabel }, B, A)), ['model']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), recent: [{ epoch: 129, cents: String(A.last) }] }, B, A)), ['book']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), bookCount: 2 }, B, A)), ['book']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), trigPrice: '' }, B, A)), ['trigger']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), announce: good(A).announce }, B, A, { announce: true })), ['announce']);
  assert.deepEqual(failed(lib.checkMarket({ ...good(B), selected: A.symbol, trigSelected: A.symbol, statsSymbol: A.symbol }, B, A)), ['selected', 'stale']);
});

test('announceCheck: the announced price must be one this market really showed (current DOM price or the one just before a rollover), never another market\'s', () => {
  const now = A.priceText;                       // what the DOM shows when the probe reads both
  assert.equal(lib.announceCheck(good(A).announce, A, [now]).ok, true, 'announce price equals the DOM price');
  assert.equal(lib.announceCheck(good(A).announce, A).ok, true, 'no trail: the expected price itself');
  const rolled = `Selected ${A.symbol}, last price $10.49`;   // announced at click time, the epoch rolled over before the read
  assert.equal(lib.announceCheck(rolled, A, ['$10.49', now]).ok, true, 'one rollover: the earlier DOM price of the SAME market is accepted');
  const bad = lib.announceCheck(rolled, A, [now]);
  assert.equal(bad.ok, false, 'a price this market never showed is a failure'); assert.match(bad.detail, /\$10\.49/);
  assert.equal(lib.announceCheck(`Selected IP15-CLR, last price ${now}`, A, [now]).ok, false, 'another market\'s symbol fails even with the right price');
  assert.equal(lib.announceCheck(`Selected ${A.symbol}, last price ${now} extra`, A, [now]).ok, false, 'exact sentence shape');
  assert.equal(lib.announceCheck(good(E).announce, E, ['$1.00']).ok, true, 'an untraded market must say no trade yet');
  assert.equal(lib.announceCheck(`Selected ${E.symbol}, last price $1.00`, E, ['$1.00']).ok, false, 'an untraded market never announces a price');
  assert.equal(lib.announceCheck(`Selected ${A.symbol}, price loading`, A, [now]).ok, false, 'loading text is not a settled announcement');
  assert.equal(lib.announceCheck(`${good(A).announce}\u00a0`.replace(/\s+$/, ''), A, [now]).ok, true);
});

test('checkMarket: the announce column uses the price trail (ctx.seen) so one epoch rollover between click and read is not a failure', () => {
  const rolled = { ...good(A), announce: `Selected ${A.symbol}, last price $10.49` };
  assert.deepEqual(failed(lib.checkMarket(rolled, A, null, { announce: true })), ['announce'], 'without a trail the stale price fails');
  assert.deepEqual(failed(lib.checkMarket(rolled, A, null, { announce: true, seen: ['$10.49', A.priceText] })), [], 'with the trail it passes');
  assert.deepEqual(failed(lib.checkMarket({ ...rolled, announce: good(A).announce.replace(A.symbol, 'XYZ') }, A, null, { announce: true, seen: ['$10.49', A.priceText] })), ['announce'], 'the isolation part (symbol) still fails');
});

test('checkMarket: the price band and the stats are enforced for traded markets', () => {
  const X = lib.expectedFor(CASE, { marketId: '0xaa', last: 105900, points: 142 });
  assert.deepEqual(failed(lib.checkMarket(good(X), X, null)), ['band', 'book'], 'the recent results of the same market are out of band too');
  assert.deepEqual(failed(lib.checkMarket({ ...good(A), high: '$9.00' }, A, null)), ['stats'], 'last price above the high');
  assert.deepEqual(failed(lib.checkMarket({ ...good(A), trades: '-' }, A, null)), ['stats']);
});

test('checkMarket: two markets at the same price are not reported as stale', () => {
  const C = lib.expectedFor({ symbol: 'IP15P-CLR', name: 'iPhone 15 Pro Clear MagSafe Case', category: 'Accessories', referenceCents: 1249 }, { marketId: '0xdd', last: 1059, points: 142 });
  assert.deepEqual(failed(lib.checkMarket(good(C), C, A)), []);
});

test('seriesCollisions: two different markets must never show the same price series', () => {
  assert.deepEqual(lib.seriesCollisions([{ symbol: 'A', series: '1|2|3' }, { symbol: 'B', series: '1|2|4' }, { symbol: 'C', series: '' }, { symbol: 'D', series: '' }]), [], 'empty series are not compared');
  assert.deepEqual(lib.seriesCollisions([{ symbol: 'A', series: '1|2|3' }, { symbol: 'B', series: '1|2|3' }, { symbol: 'C', series: '9' }]), [['A', 'B']]);
});

test('seriesOf: epoch table plus chart path; nothing priced => empty string (so untraded markets are never compared)', () => {
  const rows = [{ epoch: '5', price: '$10.59' }, { epoch: '4', price: 'no trade' }];
  assert.equal(lib.seriesOf({ epochRows: rows, path: 'M0,0L1,1' }), '5:$10.59,4:no trade|M0,0L1,1');
  assert.equal(lib.seriesOf({ epochRows: [{ epoch: '4', price: 'no trade' }], path: '' }), '');
  assert.equal(lib.seriesOf({ epochRows: [], path: '' }), '');
  assert.notEqual(lib.seriesOf({ epochRows: rows, path: 'M0,0L1,1' }), lib.seriesOf({ epochRows: [{ epoch: '5', price: '$10.60' }], path: 'M0,0L1,1' }));
  assert.ok(lib.BLANK_BYTES >= 1000, 'a flat one-colour stage PNG is below the blank threshold');
});

test('hashOf / sameImage: stable content hashes, null (no screenshot) is never "the same"', () => {
  assert.equal(lib.hashOf('abc'), lib.hashOf(new TextEncoder().encode('abc'))); assert.notEqual(lib.hashOf('abc'), lib.hashOf('abd'));
  assert.equal(lib.hashOf('abc').length, 16);
  assert.equal(lib.sameImage('x', 'x'), true); assert.equal(lib.sameImage('x', 'y'), false); assert.equal(lib.sameImage(null, null), false); assert.equal(lib.sameImage('x', null), false);
});

test('spinCheck: normal motion needs webgl, changed pictures and a moved rotation; reduced motion must hold still', () => {
  assert.equal(lib.spinCheck({ mode: 'webgl', shotsDiffer: true, rotA: '0.100', rotB: '0.400', reduced: false }).ok, true);
  assert.equal(lib.spinCheck({ mode: 'webgl', shotsDiffer: false, rotA: '0.100', rotB: '0.400', reduced: false }).ok, false);
  assert.equal(lib.spinCheck({ mode: 'webgl', shotsDiffer: true, rotA: '0.100', rotB: '0.100', reduced: false }).ok, false);
  assert.equal(lib.spinCheck({ mode: 'fallback', shotsDiffer: true, rotA: '0', rotB: '0', reduced: false }).ok, false);
  assert.equal(lib.spinCheck({ mode: 'webgl', shotsDiffer: false, rotA: '0.200', rotB: '0.200', reduced: true }).ok, true);
  assert.equal(lib.spinCheck({ mode: 'webgl', shotsDiffer: true, rotA: '0.200', rotB: '0.200', reduced: true }).ok, false, 'pixels moved with reduced motion');
  assert.equal(lib.spinCheck({ mode: 'webgl', shotsDiffer: false, rotA: '0.200', rotB: '0.300', reduced: true }).ok, false);
});

test('modelCheck: a model picture must differ from every other market\'s when frozen (reduced motion), and exist', () => {
  assert.equal(lib.modelCheck({ reduced: true, hash: 'h1', others: { B: 'h2' } }, 'A').ok, true);
  assert.equal(lib.modelCheck({ reduced: true, hash: 'h1', others: { B: 'h1' } }, 'A').ok, false);
  assert.equal(lib.modelCheck({ reduced: true, hash: null, others: {} }, 'A').ok, false);
  assert.equal(lib.modelCheck({ reduced: false, hash: 'h1', others: { B: 'h1' } }, 'A').ok, false, 'identical pictures are never fine');
});

test('formatTable: the nine columns, one line per market, a result column and a detail line per failure; summaryLine counts from the catalog', () => {
  const okRow = { symbol: 'IP16-CLR', category: 'Accessories', priceText: '$10.59', points: 142, tape: 2, via: 'click', checks: lib.checkMarket(good(A), A, null), spin: { key: 'spin', ok: true, detail: '' }, empty: 'no' };
  const badRow = { symbol: 'PS5', category: 'Gaming', priceText: lib.NO_TRADE, points: 0, tape: 0, via: 'keyboard', checks: lib.checkMarket({ ...good(E), p3dKind: 'phone' }, E, A), spin: { key: 'spin', ok: true, detail: '' }, empty: 'yes' };
  const out = lib.formatTable([okRow, badRow]).split('\n');
  assert.match(out[0], /^symbol\s+category\s+price\s+points\s+tape\s+model\s+kind\s+spin\s+empty\s+result$/);
  assert.match(out[1], /^IP16-CLR\s+Accessories\s+\$10\.59\s+142\s+2\s+ok\s+ok\s+ok\s+no\s+PASS$/);
  assert.match(out[2], /^PS5\s+Gaming\s+no trade yet\s+0\s+0\s+ok\s+FAIL\s+ok\s+yes\s+FAIL$/);
  assert.equal(out.length, 4); assert.match(out[3], /FAIL PS5 \(keyboard\) kind: /);
  assert.equal(lib.summaryLine([okRow], 1, []), 'probe-assets: all 1 markets correct');
  assert.equal(lib.summaryLine([okRow, badRow], 2, []), 'probe-assets: 1 FAILURE(S): 1 of 2 markets probed failed, 0 of 2 not probed, 0 other problems');
  assert.equal(lib.summaryLine([okRow], 18, []), 'probe-assets: 1 FAILURE(S): 0 of 1 markets probed failed, 17 of 18 not probed, 0 other problems', 'a market that was not probed is a failure');
  assert.equal(lib.summaryLine([okRow], 1, ['boom']), 'probe-assets: 1 FAILURE(S): 0 of 1 markets probed failed, 0 of 1 not probed, 1 other problems');
  assert.deepEqual(lib.COLS, ['symbol', 'category', 'price', 'points', 'tape', 'model', 'kind', 'spin', 'empty']);
});
