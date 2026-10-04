import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompare, canonFromEntry, gateOffer, spreadOf } from '../feeds/compare.ts';
import type { SourceRun } from '../feeds/compare.ts';
import type { SourceSummary } from '../api-types.ts';
import type { FeedOffer, FeedQuery } from '../feeds/types.ts';
import type { ManifestEntry } from '../manifest.ts';

const HERO: ManifestEntry = { sku: 'CASE-IP16PRO-CLEAR-MAG-001', path: '/p/CASE-IP16PRO-CLEAR-MAG-001/', imagePath: '/img/cases-png/iphone-16-pro_clear_mag_1.png', title: 'iPhone 16 Pro Clear MagSafe Case', brand: 'Robinize', gtin: null, priceCents: 1099, currency: 'USD', availability: 'IN_STOCK', compat: 'iPhone 16 Pro', color: 'Clear', magSafe: true, pack: 1 };
const Q: FeedQuery = { gtin: '036000291452', query: 'iPhone 16 Pro Clear MagSafe Case', country: 'US' };
const offer = (over: Partial<FeedOffer> = {}): FeedOffer => ({ source: 'ebay', sourceProductId: 'v1|1|0', title: 'Clear MagSafe Case for iPhone 16 Pro', priceCents: 999, currency: 'USD', shipCents: 0, url: 'https://www.ebay.com/itm/1', imageUrl: null, seller: 's', gtin: null, condition: 'NEW', observedAt: '2026-10-02T12:00:00.000Z', gtinMatched: true, ...over });
const run = (id: string, mode: SourceRun['mode'], offers: FeedOffer[], over: Partial<SourceRun> = {}): SourceRun => ({ id, label: id, attribution: id, configured: mode !== 'MOCK', mode, cache: 'MISS', offers, error: null, quotaRemaining: 10, ...over });

test('gateOffer with catalog canon: variant mismatches are rejected by the hard gates', () => {
  const canon = canonFromEntry(HERO);
  assert.equal(gateOffer(canon, Q, offer()).locked, true);
  assert.equal(gateOffer(canon, Q, offer({ title: 'Clear MagSafe Case for iPhone 16 Pro Max' })).locked, false);
  assert.equal(gateOffer(canon, Q, offer({ title: 'Clear MagSafe Case iPhone 16 Pro 2-Pack' })).locked, false);
  assert.equal(gateOffer(canon, Q, offer({ title: 'Clear Case for iPhone 16 Pro (no magnet)' })).locked, false);
});

test('gateOffer: an offer for a different device never locks against a catalog canon', () => {
  const pixel = canonFromEntry({ ...HERO, sku: 'SKU-P9', title: 'Pixel 9 Black MagSafe Case', compat: 'Pixel 9', color: 'Black' });
  const r = gateOffer(pixel, Q, offer({ title: 'Clear MagSafe Case for iPhone 16 Pro' }));
  assert.equal(r.locked, false);
  assert.match(r.rejectReasons.join(' '), /compatibility: title does not name Pixel 9/);
  assert.equal(gateOffer(pixel, Q, offer({ title: 'Pixel 9 Black MagSafe Case' })).locked, true);
});

test('gateOffer: UPC vs EAN-13 of the same item passes; different GTIN and used condition fail', () => {
  const canon = canonFromEntry(HERO);
  assert.equal(gateOffer(canon, Q, offer({ gtin: '0036000291452' })).locked, true);
  const wrong = gateOffer(canon, Q, offer({ gtin: '4006381333931' }));
  assert.equal(wrong.locked, false);
  assert.match(wrong.rejectReasons.join(' '), /gtin/);
  assert.equal(gateOffer(canon, Q, offer({ condition: 'USED' })).locked, false);
});

test('gateOffer without canon locks only exact GTIN matches', () => {
  assert.equal(gateOffer(null, Q, offer({ gtinMatched: true })).locked, true);
  assert.equal(gateOffer(null, Q, offer({ gtinMatched: false })).locked, false);
  assert.equal(gateOffer(null, { ...Q, gtin: null }, offer({ gtinMatched: true })).locked, false);
});

test('totalCents includes known shipping only', () => {
  assert.equal(gateOffer(null, Q, offer({ priceCents: 999, shipCents: 150 })).totalCents, 1149);
  assert.equal(gateOffer(null, Q, offer({ priceCents: 999, shipCents: null })).totalCents, 999);
});

test('spreadOf: integer math, floor bps, never mixes test data into a REAL spread', () => {
  const s = (id: string, mode: SourceSummary['mode'], bestCents: number | null): SourceSummary => ({ id, label: id, attribution: id, configured: true, mode, cache: 'MISS', offers: 1, locked: 1, bestCents, bestUrl: null, observedAt: null, error: null, quotaRemaining: null });
  assert.deepEqual(spreadOf([s('a', 'REAL', 989), s('b', 'REAL', 1099)]), { minCents: 989, maxCents: 1099, deltaCents: 110, deltaBps: 1112, basis: 'REAL', sources: 2 });
  assert.equal(spreadOf([s('a', 'REAL', 989), s('m', 'MOCK', 1)]), null);
  assert.equal(spreadOf([s('m1', 'MOCK', 500), s('m2', 'MOCK', 600)])?.basis, 'MOCK');
  assert.deepEqual(spreadOf([s('a', 'REAL', 1000), s('b', 'DEGRADED', 1000)])?.deltaBps, 0);
  assert.equal(spreadOf([s('a', 'REAL', null), s('b', 'REAL', 1000)]), null);
});

test('buildCompare: per-source best over locked offers, flags, top offers', () => {
  const r = buildCompare(Q, HERO, [
    run('ebay', 'REAL', [offer({ priceCents: 1200 }), offer({ priceCents: 989 }), offer({ priceCents: 500, title: 'Clear MagSafe Case iPhone 16 Pro Max' })]),
    run('bestbuy', 'REAL', [offer({ source: 'bestbuy', priceCents: 1099, gtin: '036000291452' })]),
    run('serpapi', 'MOCK', [offer({ source: 'serpapi', priceCents: 100 })], { cache: 'NONE' }),
  ], Date.UTC(2026, 9, 2));
  assert.deepEqual(r.sources.map((s) => [s.id, s.bestCents, s.locked, s.offers]), [['ebay', 989, 2, 3], ['bestbuy', 1099, 1, 1], ['serpapi', 100, 1, 1]]);
  assert.deepEqual(r.spread, { minCents: 989, maxCents: 1099, deltaCents: 110, deltaBps: 1112, basis: 'REAL', sources: 2 });
  assert.deepEqual(r.flags, []);
  assert.equal(r.canonical?.sku, 'CASE-IP16PRO-CLEAR-MAG-001');
  assert.equal(r.offers[0].priceCents, 989);
});

test('buildCompare flags: no gtin, no canon, single source, stale, quota, all test data', () => {
  const q = { gtin: null, query: 'something', country: 'US' as const };
  const r = buildCompare(q, null, [run('ebay', 'DEGRADED', [], { cache: 'STALE', error: 'quota_exhausted' })], 0);
  assert.deepEqual(r.flags, ['gtin_unavailable', 'no_canonical', 'single_source', 'stale_cache', 'quota_exhausted', 'no_locked_offers']);
  const m = buildCompare(Q, HERO, [run('ebay', 'MOCK', [offer()]), run('bestbuy', 'MOCK', [offer({ priceCents: 1099 })])], 0);
  assert.deepEqual(m.flags, ['all_mock']);
  assert.equal(m.spread?.basis, 'MOCK');
});

test('zero or negative price offers never lock and never become bestCents', () => {
  const canon = canonFromEntry(HERO);
  const z = gateOffer(canon, Q, offer({ priceCents: 0 }));
  assert.equal(z.locked, false);
  assert.match(z.rejectReasons.join(' '), /price/);
  assert.equal(gateOffer(null, Q, offer({ priceCents: 0, gtinMatched: true })).locked, false);
  const r = buildCompare(Q, HERO, [run('ebay', 'REAL', [offer({ priceCents: 0 }), offer({ priceCents: 989 })])], 0);
  assert.equal(r.sources[0].bestCents, 989);
  assert.equal(r.sources[0].locked, 1);
});

// Keyword-sourced offers (SerpApi/SearchApi: gtinMatched false) need positive colour evidence and no form-factor conflict.
const KW = (title: string, over: Partial<FeedOffer> = {}) => offer({ source: 'serpapi', title, priceCents: 699, condition: 'UNKNOWN', gtinMatched: false, ...over });

test('keyword offer: the Insignia hard-shell title (no colour word) never locks against the clear TPU canon', () => {
  const r = gateOffer(canonFromEntry(HERO), Q, KW('Insignia Hard-Shell Case with MagSafe for iPhone 16 Pro', { seller: 'Best Buy' }));
  assert.equal(r.locked, false);
  assert.match(r.rejectReasons.join(' | '), /color: title does not show clear\/transparent/);
  assert.match(r.rejectReasons.join(' | '), /form: title says hard-shell but the canonical product is not/);
});

test('keyword offer: clear/transparent synonyms lock; a title with no colour word or another colour does not', () => {
  const canon = canonFromEntry(HERO);
  assert.equal(gateOffer(canon, Q, KW('iPhone 16 Pro Clear MagSafe Case TPU Transparent')).locked, true);
  assert.equal(gateOffer(canon, Q, KW('Transparent MagSafe Case for iPhone 16 Pro')).locked, true);
  assert.equal(gateOffer(canon, Q, KW('Crystal MagSafe Case for iPhone 16 Pro')).locked, true);
  assert.equal(gateOffer(canon, Q, KW('Black MagSafe Case for iPhone 16 Pro')).locked, false);
  const none = gateOffer(canon, Q, KW('MagSafe Case for iPhone 16 Pro'));
  assert.equal(none.locked, false);
  assert.match(none.rejectReasons.join(' | '), /color: title does not show clear\/transparent/);
  assert.doesNotMatch(none.rejectReasons.join(' | '), /form:/);
  assert.equal(gateOffer(canon, Q, KW('Clear MagSafe Case for iPhone 16 Pro', { condition: 'USED' })).locked, false);
  assert.equal(gateOffer(canon, Q, KW('Clear MagSafe Case for iPhone 16 Pro')).locked, true);
});

test('keyword offer: each form-factor conflict word rejects an otherwise clear title', () => {
  const canon = canonFromEntry(HERO);
  for (const w of ['hard shell', 'hardshell', 'Hard-Shell', 'silicone', 'leather', 'wallet', 'folio', 'battery', 'kickstand', 'rugged', 'armor', 'armour', 'glitter', 'liquid']) {
    const r = gateOffer(canon, Q, KW('Clear ' + w + ' MagSafe Case for iPhone 16 Pro'));
    assert.equal(r.locked, false, w);
    assert.match(r.rejectReasons.join(' | '), /form: title says /, w);
  }
});

test('keyword offer: a form-factor word is allowed when the canonical model already contains it; other colours need their own word', () => {
  const rugged = canonFromEntry({ ...HERO, sku: 'SKU-R', title: 'iPhone 16 Pro Black Rugged MagSafe Case', color: 'Black' });
  assert.equal(gateOffer(rugged, Q, KW('Black Rugged MagSafe Case for iPhone 16 Pro')).locked, true);
  assert.equal(gateOffer(rugged, Q, KW('Rugged MagSafe Case for iPhone 16 Pro')).locked, false); // no colour evidence
  assert.equal(gateOffer(rugged, Q, KW('Black Rugged Leather MagSafe Case for iPhone 16 Pro')).locked, false); // leather is not in the canon
  const shell = canonFromEntry({ ...HERO, sku: 'SKU-H', title: 'iPhone 16 Pro Clear Hard-Shell MagSafe Case' });
  assert.equal(gateOffer(shell, Q, KW('Clear Hard Shell MagSafe Case for iPhone 16 Pro')).locked, true);
});

test('GTIN-matched offers keep their GTIN evidence: no colour word or form word needed', () => {
  const canon = canonFromEntry(HERO);
  assert.equal(gateOffer(canon, Q, offer({ title: 'MagSafe Case for iPhone 16 Pro', gtinMatched: true })).locked, true);
  assert.equal(gateOffer(canon, Q, offer({ title: 'Hard-Shell MagSafe Case for iPhone 16 Pro', gtinMatched: true })).locked, true);
  // no query GTIN means gtinMatched cannot count as evidence
  assert.equal(gateOffer(canon, { ...Q, gtin: null }, offer({ title: 'MagSafe Case for iPhone 16 Pro', gtinMatched: true })).locked, false);
});

test('buildCompare: a cheaper hard-shell keyword offer cannot set the SerpApi best or the locked count', () => {
  const r = buildCompare(Q, HERO, [
    run('serpapi', 'REAL', [
      KW('Insignia Hard-Shell Case with MagSafe for iPhone 16 Pro', { priceCents: 699, seller: 'Best Buy' }),
      KW('iPhone 16 Pro Clear MagSafe Case', { priceCents: 1049, shipCents: 0 }),
      KW('Clear MagSafe Case for iPhone 16 Pro Max', { priceCents: 899 }),
      KW('MagSafe Case for iPhone 16 Pro', { priceCents: 799 }),
      KW('Transparent MagSafe Case for iPhone 16 Pro', { priceCents: 1499 }),
    ]),
  ], 0);
  assert.deepEqual([r.sources[0].bestCents, r.sources[0].locked, r.sources[0].offers], [1049, 2, 5]);
  assert.equal(r.offers.filter((o) => o.locked).length, 2);
  assert.equal(r.offers.find((o) => o.priceCents === 699)?.locked, false);
});

// Fix 6: grip/stand/accessory bundles are a different product from the plain clear TPU case.
const POP_TITLE = 'Package - PopSockets - MagSafe PopCase for iPhone 16 Pro Case with Customizable Grip';

test('keyword offer: the PopSockets PopCase package title never locks against the clear TPU canon', () => {
  const canon = canonFromEntry(HERO);
  const r = gateOffer(canon, Q, KW(POP_TITLE, { priceCents: 2698, seller: 'Best Buy' }));
  assert.equal(r.locked, false);
  assert.match(r.rejectReasons.join(' | '), /form: title says /);
  // even with a clear word present (the dangerous shape) the form rules reject it
  const clear = gateOffer(canon, Q, KW('Package - PopSockets - MagSafe PopCase for iPhone 16 Pro Clear Case with Customizable Grip', { priceCents: 2698 }));
  assert.equal(clear.locked, false);
  assert.match(clear.rejectReasons.join(' | '), /form: title says popsockets/);
  assert.match(clear.rejectReasons.join(' | '), /form: title says popcase/);
  assert.match(clear.rejectReasons.join(' | '), /form: title says customizable/);
  assert.match(clear.rejectReasons.join(' | '), /form: title says grip/);
  assert.match(clear.rejectReasons.join(' | '), /form: title says package/);
});

const NEW_WORDS: [string, string][] = [
  ['popsockets', 'iPhone 16 Pro Clear MagSafe Case PopSockets'],
  ['popcase', 'iPhone 16 Pro Clear MagSafe PopCase'],
  ['popgrip', 'iPhone 16 Pro Clear MagSafe Case with PopGrip'],
  ['pop socket', 'iPhone 16 Pro Clear MagSafe Case with Pop Socket'],
  ['grip', 'iPhone 16 Pro Clear MagSafe Case with Grip'],
  ['ring holder', 'iPhone 16 Pro Clear MagSafe Case with Ring Holder'],
  ['stand', 'iPhone 16 Pro Clear MagSafe Case Kickstand Stand'],
  ['stand', 'iPhone 16 Pro Clear MagSafe Case with Stand'],
  ['lanyard', 'iPhone 16 Pro Clear MagSafe Case with Lanyard'],
  ['strap', 'iPhone 16 Pro Clear MagSafe Case Wrist Strap'],
  ['charm', 'iPhone 16 Pro Clear MagSafe Case Charm'],
  ['customizable', 'iPhone 16 Pro Clear MagSafe Case Customizable'],
  ['customizable', 'iPhone 16 Pro Clear MagSafe Case Customized'],
  ['customizable', 'iPhone 16 Pro Clear MagSafe Case Customization Kit'],
  ['package', 'Package - iPhone 16 Pro Clear MagSafe Case'],
  ['package', 'Package iPhone 16 Pro Clear MagSafe Case'],
];

test('keyword offer: each new accessory/bundle word rejects an otherwise clear title with a form reason', () => {
  const canon = canonFromEntry(HERO);
  for (const [w, title] of NEW_WORDS) {
    const r = gateOffer(canon, Q, KW(title));
    assert.equal(r.locked, false, title);
    assert.match(r.rejectReasons.join(' | '), new RegExp('form: title says ' + w + ' but'), title);
  }
});

test('keyword offer: real clear-TPU titles stay locked; "Retail Package" mid-title, standard and understand do not trip a rule', () => {
  const canon = canonFromEntry(HERO);
  for (const title of [
    'iPhone 16 Pro Clear MagSafe Case TPU Transparent',
    'Clear Case for iPhone 16 Pro MagSafe Compatible',
    'iPhone 16 Pro Transparent MagSafe Case',
    'iPhone 16 Pro Clear MagSafe Case TPU Transparent Retail Package',
    'iPhone 16 Pro Clear MagSafe Case Standard Edition',
    'iPhone 16 Pro Clear MagSafe Case you will understand',
    'iPhone 16 Pro Clear MagSafe Case Gripping Edge', // "gripping" is not the word grip
  ]) {
    const r = gateOffer(canon, Q, KW(title));
    assert.equal(r.locked, true, title + ' :: ' + r.rejectReasons.join(' | '));
  }
});

test('keyword offer: GTIN-matched offers are never screened by the new words', () => {
  const canon = canonFromEntry(HERO);
  assert.equal(gateOffer(canon, Q, offer({ title: 'iPhone 16 Pro MagSafe Case with Grip', gtinMatched: true })).locked, true);
});

test('keyword offer: a new word is allowed when the canonical model contains it', () => {
  for (const [w, title] of NEW_WORDS) {
    if (w === 'package' || /Kickstand/.test(title)) continue; // package: handled below; kickstand is its own (already tested) rule
    const head = w === 'customizable' ? (title.match(/Customi\w+/) as RegExpMatchArray)[0] : w;
    const canon = canonFromEntry({ ...HERO, sku: 'SKU-X', title: 'iPhone 16 Pro Clear ' + head + ' MagSafe Case' });
    assert.equal(gateOffer(canon, Q, KW(title)).locked, true, w + ' :: ' + title + ' :: ' + gateOffer(canon, Q, KW(title)).rejectReasons.join(' | '));
  }
  const grip = canonFromEntry({ ...HERO, sku: 'SKU-G', title: 'iPhone 16 Pro Clear Grip MagSafe Case' });
  assert.equal(gateOffer(grip, Q, KW('Clear Grip MagSafe Case for iPhone 16 Pro')).locked, true);
  assert.equal(gateOffer(grip, Q, KW('Clear Grip Lanyard MagSafe Case for iPhone 16 Pro')).locked, false); // lanyard not in the canon
  const pkg = canonFromEntry({ ...HERO, sku: 'SKU-K', title: 'Package iPhone 16 Pro Clear MagSafe Case' });
  assert.equal(gateOffer(pkg, Q, KW('Package iPhone 16 Pro Clear MagSafe Case')).locked, true);
});

test('buildCompare: a PopSockets package offer at 2698 as the only otherwise-locked offer is excluded from best and locked count', () => {
  const popClear = 'Package - PopSockets - MagSafe PopCase for iPhone 16 Pro Clear Case with Customizable Grip';
  const r = buildCompare(Q, HERO, [
    run('serpapi', 'REAL', [
      KW(popClear, { priceCents: 2698, seller: 'Best Buy' }),
      KW(POP_TITLE, { priceCents: 2698, seller: 'Best Buy' }),
      KW('Insignia Hard-Shell Case with MagSafe for iPhone 16 Pro', { priceCents: 699, seller: 'Best Buy' }),
      KW('MagSafe Case for iPhone 16 Pro', { priceCents: 799 }),
    ]),
  ], 0);
  assert.deepEqual([r.sources[0].bestCents, r.sources[0].locked, r.sources[0].offers], [null, 0, 4]);
  assert.equal(r.offers.filter((o) => o.locked).length, 0);
});
