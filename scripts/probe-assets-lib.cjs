// Pure assertion logic of scripts/probe-assets.cjs (no browser, no I/O). Tested by apps/web/test/market/probe-assets.test.ts.
// A "snapshot" is everything the probe reads from the page in ONE evaluate after a switch, so a re-render between two reads cannot mix
// two markets. "Expected" values come from the catalog (name, category, referenceCents) and from the switcher option of that market,
// whose data-* attributes are the store's own numbers for that market, independent of the current selection.
'use strict';
const crypto = require('node:crypto');

const NO_TRADE = 'no trade yet';
const NO_TRADE_3D = 'No trade yet';
/** Cases and products: a market's last price must lie within +-25% of the catalog reference (catches x100 / /100 unit bugs). */
const BAND = 0.25;
const COLS = ['symbol', 'category', 'price', 'points', 'tape', 'model', 'kind', 'spin', 'empty'];

// arguments
/** `probe-assets.cjs [BASE_URL] [--reduced-motion] [--help]`; BASE_URL may also come from the environment. */
function parseArgs(argv, env = {}) {
  const out = { base: null, reduced: false, help: false, unknown: [] };
  for (const a of argv) {
    if (a === '--reduced-motion') out.reduced = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) out.unknown.push(a);
    else if (!out.base) out.base = a;
  }
  const base = out.base || env.BASE_URL || null;
  out.base = base ? base.replace(/\/+$/, '') : null;
  return out;
}

// money
/** '$1,199.00' -> 119900; anything that is not a terminal dollar price -> null. */
function parseUsd(text) {
  const m = /^\$(\d{1,3}(?:,\d{3})*)\.(\d{2})$/.exec(String(text ?? '').trim());
  return m ? Number(m[1].replace(/,/g, '')) * 100 + Number(m[2]) : null;
}
/** Integer cents to the terminal's dollar text: 1059 -> $10.59, 119900 -> $1,199.00. */
const usdText = (cents) => (cents < 0 ? '-$' : '$') + Math.abs(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function inBand(cents, reference, band = BAND) {
  if (!(cents > 0) || !(reference > 0)) return false;
  return cents >= reference * (1 - band) - 1e-9 && cents <= reference * (1 + band) + 1e-9;
}

// catalog knowledge
// The 3D model kind per symbol (src/components/market/product3d/specs.ts). Phones and Accessories are decided by category; a market
// whose model is not listed here returns null, so a new catalog entry FAILS the probe until its model is added (never "generic").
const DEVICE_KIND = { APP3: 'earbuds', XM6: 'headphones', NSW2: 'handheld', Q3S: 'vr', PS5: 'console', MBA13: 'laptop', IPAD: 'tablet', AW12: 'watch' };
function expectedKind(entry) {
  if (entry.category === 'Accessories') return 'case';
  if (entry.category === 'Phones') return 'phone';
  return DEVICE_KIND[entry.symbol] ?? null;
}

/** What one switcher option says about its market. */
function classify(opt) {
  const last = Number(opt.last) || 0, points = Number(opt.points) || 0;
  if (opt.state === 'loading') return 'loading';
  if (last > 0 && points > 0) return 'traded';
  if (last === 0 && points === 0) return 'empty';
  return 'inconsistent';
}

/** Mirror of market-view pickDefaultMarket: a valid #hash symbol, else the first market with a last price, else index 0. */
function pickDefault(opts, hash) {
  const h = opts.findIndex((m) => m.symbol === hash); if (h >= 0) return h;
  const t = opts.findIndex((m) => m.last > 0); return t >= 0 ? t : 0;
}

/** What the page must show for one market. `cat` = catalog entry, `opt` = { marketId, last, points } read from its asset-option. */
function expectedFor(cat, opt) {
  const last = Number(opt.last) || 0, points = Number(opt.points) || 0; const traded = last > 0;
  return {
    symbol: cat.symbol, name: cat.name, category: cat.category, referenceCents: cat.referenceCents, marketId: String(opt.marketId).toLowerCase(), last, points, traded,
    priceText: traded ? usdText(last) : NO_TRADE, kind: expectedKind(cat), bandOk: traded ? inBand(last, cat.referenceCents) : true,
  };
}
const announceFor = (exp, priceText = exp.priceText) => (exp.traded ? `Selected ${exp.symbol}, last price ${priceText}` : `Selected ${exp.symbol}, ${NO_TRADE}`);
/**
 * The live-region sentence must name THIS market and, for a traded one, a price THIS market really showed. The announcement is made at
 * click time and prices change every epoch (45 s), so the price in the sentence may be the one shown just before a rollover:
 * `seen` = the price texts of this market the probe observed since the click (default: only the expected one). Another market's
 * symbol, an invented price, a price on an untraded market or a loading sentence all fail. Whitespace is normalised (the product
 * alternates a no-break space so a repeated sentence still mutates the live region).
 */
function announceCheck(announce, exp, seen) {
  const got = String(announce ?? '').replace(/\s+/g, ' ').trim();
  const prices = exp.traded ? [...new Set([exp.priceText, ...(seen ?? [])])] : [exp.priceText];
  const ok = prices.some((p) => got === announceFor(exp, p));
  return { ok, detail: ok ? '' : `live region "${got}" (want "${announceFor(exp)}"${exp.traded && prices.length > 1 ? ` or the same sentence with a price seen since the click: ${prices.join(', ')}` : ''})` };
}

// per-market checks
const head = (s) => String(s ?? '').split(' · ')[0];
const rowsCount = (s) => { const m = /last (\d+)/.exec(String(s ?? '')); return m ? Number(m[1]) : -1; };
const intOf = (t) => (/^[\d,]+$/.test(String(t).trim()) ? Number(String(t).replace(/,/g, '')) : null);

/**
 * Checks one snapshot against the expectation. `prev` = the previously selected market's expectation (or null).
 * ctx.announce: also require the live-region text (true when the switch came from the dropdown or a hash change); ctx.seen: price texts
 * this market showed since the click (see announceCheck).
 * Returns [{ key, ok, detail }]; the keys are the checks behind the report columns.
 */
function checkMarket(snap, exp, prev, ctx = {}) {
  const out = []; const add = (key, ok, detail) => out.push({ key, ok: !!ok, detail: ok ? '' : detail });
  const sym = exp.symbol;
  add('selected', snap.selected === sym && snap.trigSelected === sym && snap.statsSymbol === sym, `data-selected "${snap.selected}", trigger "${snap.trigSelected}", stats heading "${snap.statsSymbol}" (want ${sym})`);
  add('price', snap.lastPrice === exp.priceText, `last-price "${snap.lastPrice}" != store ${exp.priceText}`);
  const shown = parseUsd(snap.lastPrice);
  add('band', !exp.traded || (exp.bandOk && shown !== null && inBand(shown, exp.referenceCents)), `price ${snap.lastPrice} outside +-${BAND * 100}% of the catalog reference ${usdText(exp.referenceCents)}`);
  // stats strip: high/low/trades are dashes for an untraded market; for a traded one low <= last <= high and trades >= chart points
  const hi = parseUsd(snap.high), lo = parseUsd(snap.low), tr = intOf(snap.trades);
  const statsOk = exp.traded
    ? hi !== null && lo !== null && tr !== null && lo <= exp.last && exp.last <= hi && tr >= exp.points
    : snap.high === '-' && snap.low === '-' && snap.trades === '-';
  add('stats', statsOk, `stats high "${snap.high}" low "${snap.low}" trades "${snap.trades}" with last ${exp.priceText}, ${exp.points} points`);
  add('points', snap.chartPoints === exp.points && snap.chartLabel === `Price chart, ${sym}`, `price-chart data-points ${snap.chartPoints} (store ${exp.points}), label "${snap.chartLabel}"`);
  const foreign = snap.tapeIds.filter((id) => id !== exp.marketId).length;
  add('tape', foreign === 0 && snap.tapeIds.length <= 40 && (exp.traded || snap.tapeIds.length === 0) && snap.tapeHead === sym,
    `${foreign} of ${snap.tapeIds.length} tape rows from another market (${exp.traded ? 'max 40' : 'none expected for an untraded market'}); header "${snap.tapeHead}"`);
  const nRows = snap.epochRows.length;
  add('epochs', head(snap.epochsHead) === sym && rowsCount(snap.epochsHead) === nRows && nRows <= 30, `epochs header "${snap.epochsHead}" with ${nRows} rows (want ${sym}, matching count, max 30)`);
  // the sealed book is keyed per market: exactly one on the page, and its "recent results" are rows of THIS market's epoch table
  const byEpoch = new Map(snap.epochRows.map((r) => [String(r.epoch), r.price]));
  const recentBad = snap.recent.filter((r) => {
    if (r.cents === '') return false;
    if (!exp.traded) return true;
    const c = Number(r.cents); const row = byEpoch.get(String(r.epoch));
    return !inBand(c, exp.referenceCents) || (row !== undefined && row !== usdText(c));
  });
  add('book', snap.bookCount === 1 && recentBad.length === 0, `${snap.bookCount} sealed books; recent results not matching this market's epochs/band: ${JSON.stringify(recentBad)}`);
  const p3dLast = exp.traded ? String(exp.last) : '';
  const p3dPrice = exp.traded ? exp.priceText : NO_TRADE_3D;
  const canvasOk = snap.p3dMode !== 'webgl' || (typeof snap.canvasLabel === 'string' && snap.canvasLabel.includes(exp.name));
  add('model', snap.p3dMarket === sym && snap.p3dModel === sym && snap.p3dLast === p3dLast && snap.p3dPrice === p3dPrice && canvasOk,
    `product-3d market "${snap.p3dMarket}" model "${snap.p3dModel}" last "${snap.p3dLast}" price "${snap.p3dPrice}" (want ${sym}/${p3dLast}/${p3dPrice}); canvas "${snap.canvasLabel}"`);
  add('kind', exp.kind !== null && snap.p3dKind === exp.kind, `product-3d data-kind "${snap.p3dKind}" (want ${exp.kind ?? 'a known model for ' + sym})`);
  // the explicit EMPTY column: an untraded market must say so everywhere and show no price anywhere; a traded one shows no empty state
  const emptyOk = exp.traded
    ? !/no trade yet/i.test(snap.chartEmpty ?? '')
    : snap.lastPrice === NO_TRADE && snap.chartPoints === 0 && /no trade yet/i.test(snap.chartEmpty ?? '') && snap.tapeIds.length === 0 && snap.p3dLast === '' && snap.p3dPrice === NO_TRADE_3D
      && snap.high === '-' && snap.low === '-' && snap.trades === '-';
  add('empty', emptyOk, exp.traded ? `traded market shows an empty state "${snap.chartEmpty}"` : `untraded market must show "no trade yet" and no price: last "${snap.lastPrice}", chart points ${snap.chartPoints}, chart "${snap.chartEmpty}", ${snap.tapeIds.length} tape rows, 3D "${snap.p3dPrice}"`);
  add('trigger', String(snap.trigText).includes(sym) && String(snap.trigText).includes(exp.name) && snap.trigPrice === exp.priceText, `trigger text "${snap.trigText}" price "${snap.trigPrice}"`);
  if (ctx.announce) { const a = announceCheck(snap.announce, exp, ctx.seen); add('announce', a.ok, a.detail); }
  if (prev && prev.symbol !== sym) {
    const syms = [snap.selected, snap.trigSelected, snap.statsSymbol, snap.p3dMarket, snap.p3dModel, snap.tapeHead, head(snap.epochsHead)].filter((x) => x === prev.symbol);
    const px = prev.traded && prev.priceText !== exp.priceText ? [snap.lastPrice, snap.p3dPrice, snap.trigPrice].filter((x) => x === prev.priceText) : [];
    add('stale', syms.length === 0 && px.length === 0, `previous market still shown: ${syms.length} symbol and ${px.length} price fields equal ${prev.symbol} / ${prev.priceText}`);
  }
  return out;
}

// pictures and series
const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const sameImage = (a, b) => a !== null && b !== null && a === b;

/** Spinning: the pictures 1.2 s apart differ AND data-rotation moved. With reduced motion the model must hold still in both. */
function spinCheck({ mode, shotsDiffer, rotA, rotB, reduced }) {
  if (mode !== 'webgl') return { key: 'spin', ok: false, detail: `3D mode is "${mode}", not webgl` };
  if (reduced) {
    const ok = rotA === rotB && !shotsDiffer;
    return { key: 'spin', ok, detail: ok ? '' : `reduced motion but rotation ${rotA} -> ${rotB}, pictures ${shotsDiffer ? 'differ' : 'identical'}` };
  }
  const ok = shotsDiffer && rotA !== rotB;
  return { key: 'spin', ok, detail: ok ? '' : `pictures ${shotsDiffer ? 'differ' : 'identical'}, rotation ${rotA} -> ${rotB}` };
}

/** The model's picture exists and is not the picture of any other market (`others` = symbol -> hash of the markets probed so far). */
function modelCheck({ reduced, hash, others }, symbol) {
  if (hash === null) return { key: 'picture', ok: false, detail: `${symbol}: no 3D picture (stage not visible or canvas blank)` };
  const same = Object.entries(others).filter(([s, h]) => s !== symbol && sameImage(h, hash)).map(([s]) => s);
  return { key: 'picture', ok: same.length === 0, detail: same.length ? `${symbol}'s 3D picture is identical to ${same.join(', ')}${reduced ? '' : ' (spinning)'}` : '' };
}

/** A stage screenshot with fewer bytes than this is a flat panel (a PNG of one colour is a few KB), i.e. a blank 3D stage. */
const BLANK_BYTES = 6000;

/** The price series a page shows, as one string: the epoch table (epoch and price per row) and the chart's line path. '' when nothing was priced. */
function seriesOf(snap) {
  const priced = snap.epochRows.filter((r) => String(r.price).startsWith('$'));
  if (!priced.length && !snap.path) return '';
  return snap.epochRows.map((r) => `${r.epoch}:${r.price}`).join(',') + '|' + (snap.path || '');
}

/** Two different markets must never show the same price series. Empty series are not compared. Returns the colliding symbol groups. */
function seriesCollisions(rows) {
  const by = new Map();
  for (const r of rows) if (r.series) (by.get(r.series) ?? by.set(r.series, []).get(r.series)).push(r.symbol);
  return [...by.values()].filter((g) => g.length > 1);
}

// report
const bad = (checks, ...keys) => checks.filter((c) => keys.includes(c.key) && !c.ok);
const cellOf = (checks, ...keys) => (bad(checks, ...keys).length ? 'FAIL' : 'ok');
const allChecks = (r) => [...r.checks, ...(r.spin ? [r.spin] : []), ...(r.extra ?? [])];
const rowOk = (r) => allChecks(r).every((c) => c.ok);

/** One row per probed market: symbol, category, price, points, tape, model, kind, spin, empty, result; then a detail line per failure. */
function formatTable(rows) {
  const header = [...COLS, 'result'];
  const body = rows.map((r) => [
    r.symbol, r.category, r.priceText, String(r.points), String(r.tape),
    cellOf(allChecks(r), 'model', 'picture'), cellOf(r.checks, 'kind'), r.spin ? (r.spin.ok ? 'ok' : 'FAIL') : '-', bad(r.checks, 'empty').length ? 'FAIL' : r.empty, rowOk(r) ? 'PASS' : 'FAIL',
  ]);
  const w = header.map((h, i) => Math.max(h.length, ...body.map((b) => String(b[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  const details = rows.flatMap((r) => allChecks(r).filter((c) => !c.ok).map((c) => `  FAIL ${r.symbol} (${r.via}) ${c.key}: ${c.detail}`));
  return [line(header), ...body.map(line), ...details].join('\n');
}

/** The last line. `count` = catalog size; every catalog market must have been probed. `problems` = other failures (scenarios, console errors). */
function summaryLine(rows, count, problems) {
  const failedRows = rows.filter((r) => !rowOk(r)).length;
  const missing = Math.max(0, count - new Set(rows.map((r) => r.symbol)).size);
  const n = failedRows + (missing ? 1 : 0) + problems.length;
  return n === 0 ? `probe-assets: all ${count} markets correct`
    : `probe-assets: ${n} FAILURE(S): ${failedRows} of ${rows.length} markets probed failed, ${missing} of ${count} not probed, ${problems.length} other problems`;
}

module.exports = { NO_TRADE, NO_TRADE_3D, BAND, COLS, parseArgs, parseUsd, usdText, inBand, expectedKind, classify, pickDefault, expectedFor, announceFor, announceCheck, checkMarket, hashOf, sameImage, BLANK_BYTES, seriesOf, spinCheck, modelCheck, seriesCollisions, formatTable, summaryLine };
