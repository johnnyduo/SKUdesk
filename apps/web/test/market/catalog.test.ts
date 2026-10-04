// node --test test/market/catalog.test.ts   (from apps/web)
// The market catalog: 12 widely known consumer products, each priced at the manufacturer's US list price as of Oct 2026 (a fixed
// reference), then six phone cases as a secondary 'Accessories' category (a fixed catalog reference price, ids unchanged from the first
// book), each distinct, URL-safe and decodable, with order sizes that keep the bots' cash bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
import { ACCESSORY_PRICE_BASIS, ACCESSORY_RE, CATALOG_KEYS, CATEGORIES, LOTS, categoriesOf, lotFor, validateCatalog } from '../../src/lib/catalog.ts';

const JSON_ = JSON.parse(readFileSync(new URL('../../src/data/catalog.json', import.meta.url), 'utf8'));
const ALL = JSON_.markets as any[];
const M = ALL.slice(0, 12); // the twelve main products
const ACC = ALL.slice(12); // the secondary category
const BANNED = /\b(recorded|recording|simulated|demo|sample|fixture|mock)\b/i;

test('the catalog is valid: unique ids, symbols and accents; known categories; price basis; lots; URL-safe symbols', () => {
  assert.deepEqual(validateCatalog(ALL), []);
  assert.equal(ALL.length, 18);
  assert.equal(ACC.length, 6);
  assert.ok(M.every((m) => m.category !== 'Accessories') && ACC.every((m) => m.category === 'Accessories'), 'the twelve main products come first, then Accessories');
});

test('the twelve markets: symbol, name, category and US list price (cents) are exactly the reviewed table', () => {
  // Researched 2026-10-03 (US list prices, before tax and shipping). Confidence per row is kept here and not in the
  // shipped JSON (which only allows CATALOG_KEYS). The basis string says "as of Oct 2026", so the reference is a fixed snapshot.
  const want = [
    ['IP18P', 'iPhone 18 Pro (256 GB)', 'Phones', 119900],    // HIGH
    ['IP17', 'iPhone 17 (256 GB)', 'Phones', 89900],          // HIGH: apple.com "from $899" (unlocked $929)
    ['S26', 'Galaxy S26 (256 GB)', 'Phones', 99999],          // HIGH
    ['PX11', 'Pixel 11 (256 GB)', 'Phones', 89900],           // MED
    ['APP3', 'AirPods Pro 3', 'Audio', 24900],                // HIGH
    ['XM6', 'Sony WH-1000XM6', 'Audio', 45999],              // MED-LOW: press list price; street price is about $399
    ['NSW2', 'Nintendo Switch 2', 'Gaming', 49999],           // HIGH
    ['Q3S', 'Meta Quest 3S (128 GB)', 'Gaming', 34999],       // MED
    ['PS5', 'PlayStation 5 (disc, 1 TB)', 'Gaming', 64999],   // HIGH-ish
    ['MBA13', 'MacBook Air 13-inch (M5, 16/512)', 'Computing', 129900], // MED-HIGH
    ['IPAD', 'iPad (A16, 128 GB)', 'Computing', 44900],       // HIGH
    ['AW12', 'Apple Watch Series 12 (42 mm)', 'Wearables', 39900], // HIGH
  ];
  assert.deepEqual(M.map((m) => [m.symbol, m.name, m.category, m.referenceCents]), want);
  for (const m of M) { assert.equal(m.source, 'catalog', m.symbol); assert.equal(m.priceBasis, 'US list price, as of Oct 2026', m.symbol); }
});

test('the twelve main products name no case, cover or other accessory', () => {
  for (const m of M) for (const k of ['name', 'subtitle', 'id', 'symbol']) assert.doesNotMatch(String(m[k]), ACCESSORY_RE, `${m.symbol} ${k}`);
  for (const m of M) assert.doesNotMatch(m.id, /^CASE-|CLEAR/, m.symbol);
  for (const m of M) assert.doesNotMatch(m.symbol, /-CLR$/, m.symbol);
});

test('the six Accessories keep their on-chain identity (id, symbol, accent, reference price, tick) and say what they are', () => {
  // Exactly the first book's six markets: keccak256(id) is the BlindBook market id, so no id may change.
  const want = [
    ['CASE-IP16PRO-CLEAR-MAG-001', 'IP16P-CLR', '#ccff00', 1099, 'iPhone 16 Pro Clear MagSafe Case', 'Clear MagSafe case for iPhone 16 Pro'],
    ['CASE-IP16PROMAX-CLEAR-MAG-001', 'IP16PM-CLR', '#37d6a0', 1199, 'iPhone 16 Pro Max Clear MagSafe Case', 'Clear MagSafe case for iPhone 16 Pro Max'],
    ['CASE-IP15PRO-CLEAR-MAG-001', 'IP15P-CLR', '#5ec8ff', 1249, 'iPhone 15 Pro Clear MagSafe Case', 'Clear MagSafe case for iPhone 15 Pro'],
    ['CASE-IP16-CLEAR-MAG-001', 'IP16-CLR', '#ffb454', 1049, 'iPhone 16 Clear MagSafe Case', 'Clear MagSafe case for iPhone 16'],
    ['CASE-S25-CLEAR-001', 'S25-CLR', '#c792ff', 899, 'Galaxy S25 Clear Case', 'Clear case for Galaxy S25'],
    ['CASE-PIXEL9-CLEAR-001', 'PX9-CLR', '#ff7a8a', 849, 'Pixel 9 Clear Case', 'Clear case for Pixel 9'],
  ];
  assert.deepEqual(ACC.map((m) => [m.id, m.symbol, m.accent, m.referenceCents, m.name, m.subtitle]), want);
  for (const m of ACC) { assert.equal(m.tick, 1, m.symbol); assert.match(m.name, ACCESSORY_RE, m.symbol); assert.match(m.subtitle, /\b(case|cover)\b.* for /i, m.symbol); }
  // the id of the case every doc and video uses: keccak256("CASE-IP16PRO-CLEAR-MAG-001") starts 0x874760df and ends 550e
  const h = keccak256(toHex(ACC[0].id)); assert.ok(h.startsWith('0x874760df') && h.endsWith('550e'), h);
  assert.deepEqual(ACC.map((m) => m.source), ['snapshot', 'snapshot', 'snapshot', 'catalog', 'catalog', 'catalog']);
});

test('the Accessories price basis is a fixed catalog reference, never a list price or a live feed', () => {
  assert.equal(ACCESSORY_PRICE_BASIS, 'Catalog reference price (fixed snapshot, not a live feed)');
  for (const m of ACC) assert.equal(m.priceBasis, ACCESSORY_PRICE_BASIS, m.symbol);
});

test('lots: every item priced above $249 uses the unit lot, so a maker order never exceeds $5,000 of reference value', () => {
  for (const m of ALL) {
    assert.equal(m.lot, lotFor(m.referenceCents), m.symbol);
    assert.ok(LOTS[m.lot as keyof typeof LOTS].maker[1] * m.referenceCents <= 500_000, m.symbol);
  }
  assert.deepEqual(M.filter((m) => m.lot !== 'unit').map((m) => m.symbol), []);
  assert.equal(lotFor(6999), 'bulk', 'cheap items would keep the original bulk lot');
  assert.deepEqual(ACC.map((m) => m.lot), Array(6).fill('bulk'), 'cases cost $8-13: the original bulk lot, as when the first book traded');
  for (const m of ALL) assert.equal(m.lot, lotFor(m.referenceCents), m.symbol);
});

test('catalog order follows the category order, so the grouped switcher lists markets in catalog order; Accessories come last', () => {
  const rank = ALL.map((m) => CATEGORIES.indexOf(m.category));
  assert.deepEqual(rank, [...rank].sort((a, b) => a - b));
  assert.deepEqual(categoriesOf(ALL), [...CATEGORIES]);
  assert.equal(CATEGORIES[CATEGORIES.length - 1], 'Accessories');
  assert.equal(categoriesOf(M).includes('Accessories' as never), false);
});

test('on-chain market ids (keccak256 of the id) never collide across all 18; ids and symbols are unique; the primary market is the iPhone 18 Pro', () => {
  const ids = ALL.map((m) => keccak256(toHex(m.id)));
  assert.equal(new Set(ids).size, ALL.length);
  assert.equal(new Set(ALL.map((m) => m.id.toLowerCase())).size, 18);
  assert.equal(new Set(ALL.map((m) => m.symbol.toLowerCase())).size, 18);
  for (const m of ALL) assert.equal(encodeURIComponent(m.symbol), m.symbol, `${m.symbol} is URL-safe (hyphens allowed)`);
  assert.equal(ALL[0].symbol, 'IP18P', 'the page opens on the first market; data-ready waits for it');
});

// CIE76 colour distance and WCAG contrast: accents are told apart by colour alone in the switcher swatches and the 3D glow.
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lab = (h: string) => {
  const [r, g, b] = hex(h).map(lin); const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, Y = r * 0.2126 + g * 0.7152 + b * 0.0722, Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const lum = (h: string) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
test('accents are distinct within the twelve main products and within Accessories (CIE76 >= 20 for every pair) and readable on the terminal background (contrast >= 4.5)', () => {
  // The six cases keep the accents they had on the first book, which the first six main products also use; the switcher groups by category.
  for (const group of [M, ACC]) for (let i = 0; i < group.length; i++) {
    assert.ok((lum(group[i].accent) + 0.05) / (lum('#0a0b0a') + 0.05) >= 4.5, `${group[i].symbol} accent contrast`);
    for (let j = i + 1; j < group.length; j++) {
      const a = lab(group[i].accent), b = lab(group[j].accent);
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= 20, `${group[i].symbol} vs ${group[j].symbol}`);
    }
  }
});

test('the deploy script decodes exactly these fields, in alphabetical order (forge sorts JSON keys)', () => {
  const sol = readFileSync(new URL('../../../../packages/contracts/script/DeployBook.s.sol', import.meta.url), 'utf8');
  const body = sol.match(/struct Mkt \{([^}]*)\}/)?.[1] ?? '';
  const fields = [...body.matchAll(/(?:string|uint256) (\w+);/g)].map((x) => x[1]);
  assert.deepEqual(fields, [...CATALOG_KEYS]);
  assert.deepEqual([...CATALOG_KEYS], [...CATALOG_KEYS].sort());
  for (const m of ALL) assert.deepEqual(Object.keys(m).sort(), [...CATALOG_KEYS], m.symbol);
});

test('catalog copy never uses the banned words and never calls a price live or current (the note ships in the Terminal bundle)', () => {
  assert.doesNotMatch(JSON_.note, BANNED); assert.match(JSON_.note, /list price/); assert.match(JSON_.note, /test token/); assert.match(JSON_.note, /phone cases/);
  for (const m of ALL) for (const k of ['name', 'subtitle', 'category', 'priceBasis'] as const) assert.doesNotMatch(m[k], BANNED, `${m.symbol} ${k}`);
  assert.doesNotMatch(JSON.stringify(JSON_), /\b(live|current) (market )?price\b/i);
  assert.doesNotMatch(JSON.stringify(JSON_), /\b(USDC|mUSDC)\b/);
});

test('validateCatalog catches each broken field', () => {
  const ok = M[1]; // IP17
  const cases: [string, any[], RegExp][] = [
    ['duplicate symbol', [ok, { ...M[2], symbol: ok.symbol }], /duplicate symbol/],
    ['duplicate id', [ok, { ...M[2], id: ok.id }], /duplicate id/],
    ['duplicate accent (case-insensitive)', [ok, { ...M[2], accent: ok.accent.toUpperCase() }], /accent must be|duplicate accent/],
    ['lower-case symbol', [{ ...ok, symbol: 'ip17' }], /symbol must match/],
    ['symbol needing escapes', [{ ...ok, symbol: 'IP 17' }], /symbol must match/],
    ['symbol too long', [{ ...ok, symbol: 'IPHONE17-256GB' }], /symbol must match/],
    ['unknown category', [{ ...ok, category: 'Phone case' }], /unknown category/],
    ['a case in a main-category name', [{ ...ok, name: 'iPhone 17 Clear MagSafe Case' }], /accessory/],
    ['a cover in a main-category subtitle', [{ ...ok, subtitle: 'Apple folio cover' }], /accessory/],
    ['an Accessories entry whose name is not a case or cover', [{ ...ACC[0], name: 'iPhone 16 Pro Clear Shell' }], /name must say case or cover/],
    ['an Accessories subtitle that does not say what it is', [{ ...ACC[0], subtitle: 'Apple smartphone' }], /subtitle must say/],
    ['an Accessories subtitle that does not name the device it fits', [{ ...ACC[0], subtitle: 'Clear MagSafe case' }], /subtitle must say/],
    ['an Accessories entry with a list-price basis', [{ ...ACC[0], priceBasis: 'US list price, as of Oct 2026' }], /priceBasis/],
    ['a main entry with the accessory price basis', [{ ...ok, priceBasis: ACCESSORY_PRICE_BASIS }], /priceBasis/],
    ['a duplicate accent inside Accessories', [ACC[0], { ...ACC[1], accent: ACC[0].accent }], /duplicate accent/],
    ['price basis missing', [(({ priceBasis, ...r }) => r)(ok)], /keys must be exactly|priceBasis/],
    ['price basis empty', [{ ...ok, priceBasis: '' }], /priceBasis/],
    ['price basis missing the month', [{ ...ok, priceBasis: 'US list price' }], /priceBasis/],
    ['price basis claiming a current price', [{ ...ok, priceBasis: 'current US price' }], /priceBasis/],
    ['price basis of the old launch wording', [{ ...ok, priceBasis: 'US launch list price, MSRP, Sep 2024' }], /priceBasis/],
    ['zero price', [{ ...ok, referenceCents: 0 }], /referenceCents/],
    ['fractional price', [{ ...ok, referenceCents: 12.5 }], /referenceCents/],
    ['price above the contract maximum', [{ ...ok, referenceCents: 1_000_001 }], /referenceCents/],
    ['bulk lot on an expensive device', [{ ...ok, lot: 'bulk' }], /lot must be unit/],
    ['unit lot on a cheap item', [{ ...ok, referenceCents: 6999, lot: 'unit' }], /lot must be bulk/],
    ['unknown lot', [{ ...ok, lot: 'pallet' }], /lot must be one of/],
    ['empty subtitle', [{ ...ok, subtitle: ' ' }], /subtitle/],
    ['extra key (the old compatibility field)', [{ ...ok, compatibility: 'iPhone 17' }], /keys must be exactly/],
    ['missing key', [(({ subtitle, ...r }) => r)(ok)], /keys must be exactly/],
    ['bad source', [{ ...ok, source: 'merchant' }], /source/],
  ];
  for (const [name, list, re] of cases) assert.match(validateCatalog(list).join('\n'), re, name);
  assert.deepEqual(validateCatalog(ACC), [], 'accessories are allowed as a category');
  assert.deepEqual(validateCatalog([M[0], ACC[0]]), [], 'the same accent in two different categories is allowed (the six cases keep their first-book accents)');
  assert.deepEqual(validateCatalog([]), ['markets must be a non-empty array']);
  assert.match(validateCatalog(Array.from({ length: 65 }, (_, i) => ({ ...ok, id: `X-${i}`, symbol: `X-${i}`, accent: '#' + i.toString(16).padStart(6, '0') }))).join('\n'), /at most 64/);
});
