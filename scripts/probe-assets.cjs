// Per-asset correctness probe for /market (Playwright from the repo-root node_modules, read-only, real public RPC for chain data).
// For EVERY catalog market (read from apps/web/src/data/catalog.json at run time) it selects the market through the asset switcher
// (keyboard for every third market, pointer for the others), waits for real price text, and reads the whole page in ONE evaluate:
// last price, stats, price chart (data-points, label), trade tape (every row's data-market-id), epoch history, sealed book (one,
// keyed per market) and the 3D stage (data-market / data-model / data-kind, canvas label, price). A market that never traded must
// pass through the explicit "empty" column ("no trade yet", no price, empty chart, no tape rows, 3D still renders). A market with
// history must price within +-25% of its catalog reference, and no two markets may show the same price series. The 3D model must
// really spin (data-rotation moves, element screenshots 1.2 s apart differ) and be a non-blank picture that differs between
// markets; with --reduced-motion it must hold still instead. Then: Escape / Tab / outside click, in-page hash changes, back, an
// unknown and a malformed hash, a fresh deep link (also to an untraded market), and a 390 px phone pass.
//   node scripts/probe-assets.cjs [BASE_URL] [--reduced-motion]       (BASE_URL env also works)
// Without a base URL it serves apps/web/dist with scripts/static-server.cjs on a free 127.0.0.1 port (build first). Exit 0 all
// correct, 1 any failure, 2 no build / server. Prints a table, then the last line "probe-assets: all N markets correct".
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path');
const lib = require('./probe-assets-lib.cjs');

const ARGS = lib.parseArgs(process.argv.slice(2), process.env);
if (ARGS.help || ARGS.unknown.length) { console.log('usage: node scripts/probe-assets.cjs [BASE_URL] [--reduced-motion]\n  no BASE_URL: serves apps/web/dist on a free port (npm run build first)'); process.exit(ARGS.unknown.length ? 2 : 0); }
const REDUCED = ARGS.reduced;
const DIST = path.join(__dirname, '../apps/web/dist');
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/web/src/data/catalog.json'), 'utf8')).markets;
const GL_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']; // as scripts/e2e-market.cjs: WebGL in headless Chromium
const MORPH_MS = 2500, SPIN_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (p, id) => p.getByTestId(id);
const PRICE_OR_NONE = '^(\\$[\\d,]+\\.\\d{2}|no trade yet)$';

const freePort = () => new Promise((res, rej) => { const srv = require('node:net').createServer(); srv.once('error', rej); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); }); });
/** Serves apps/web/dist on a free port and proves the server answering is ours (a fixed port may already be taken by another server). */
async function startServer() {
  const index = path.join(DIST, 'market/index.html');
  if (!fs.existsSync(index)) { console.error(`no build at ${DIST}: run (cd apps/web && npm run -s build) first, or pass a BASE_URL`); process.exit(2); }
  const want = fs.readFileSync(index, 'utf8'); const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'static-server.cjs'), DIST, String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/market/`); if (r.ok && (await r.text()) === want) return { child, base: `http://127.0.0.1:${port}` }; } catch { /* not up yet */ } await sleep(100); }
  child.kill(); console.error('static server did not start (or served something else)'); process.exit(2);
}

const errs = [];
function watchErrors(page) {
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 140)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR|favicon/.test(m.text()) && errs.push(m.text().slice(0, 140)));
}

/** Ready AND the page shows real price text (a dollar price or "no trade yet", never the empty skeleton) for the selected market. */
async function waitSettled(page, symbol) {
  await page.waitForFunction(([sym, re]) => {
    const g = (id) => document.querySelector(`[data-testid="${id}"]`);
    const lp = g('last-price'); const t = g('market-terminal'); const trig = g('asset-switcher-trigger'); const p3 = g('product-3d');
    const opts = [...document.querySelectorAll('[data-testid="asset-option"]')];
    return t?.getAttribute('data-ready') === 'true' && (!sym || (t.getAttribute('data-selected') === sym && trig?.getAttribute('data-selected') === sym && p3?.getAttribute('data-model') === sym))
      && !!lp && new RegExp(re).test(lp.textContent.trim()) && opts.length > 0 && opts.every((o) => o.getAttribute('data-state') !== 'loading');
  }, [symbol, PRICE_OR_NONE], { timeout: 60000 });
}

/** Everything the checks need, read in ONE evaluate (consistent DOM), plus the option data of every market. */
const snapshot = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s); const tx = (s) => (q(s)?.textContent ?? '').replace(/\s+/g, ' ').trim(); const g = (id) => `[data-testid="${id}"]`;
  const p3d = q(g('product-3d')); const trig = q(g('asset-switcher-trigger')); const num = (v) => Number(v) || 0;
  const epochRows = [...document.querySelectorAll(g('epochs-row'))].map((r) => ({ epoch: r.getAttribute('data-epoch'), price: (r.children[2]?.textContent ?? '').trim() }));
  const eh = /(\S+) · last (\d+)\s*$/.exec(tx('.mk-epochs .mk-ph-r'));
  const canvas = q('.p3d-stage canvas'); const chart = q(g('price-chart'));
  const path = [...(chart?.querySelectorAll('path.mk-line') ?? [])].map((p) => p.getAttribute('d')).join('|');
  return {
    opts: [...document.querySelectorAll(g('asset-option'))].map((o) => ({ symbol: o.getAttribute('data-symbol'), category: o.getAttribute('data-category'), marketId: o.getAttribute('data-market-id'), last: num(o.getAttribute('data-last')), points: num(o.getAttribute('data-points')), state: o.getAttribute('data-state') })),
    groups: [...document.querySelectorAll('[role="listbox"] [role="group"]')].map((x) => x.getAttribute('data-category')),
    ready: q(g('market-terminal'))?.getAttribute('data-ready'), selected: q(g('market-terminal'))?.getAttribute('data-selected'), expanded: trig?.getAttribute('aria-expanded'),
    focusTrig: document.activeElement === trig,
    trigSelected: trig?.getAttribute('data-selected'), trigText: (trig?.textContent ?? '').replace(/\s+/g, ' ').trim(), trigPrice: (trig?.querySelector('.asw-px')?.textContent ?? '').trim(),
    statsSymbol: tx('.mk-stats h2'), lastPrice: tx(g('last-price')), high: tx(g('stat-high')), low: tx(g('stat-low')), trades: tx(g('stat-trades')),
    chartPoints: Number(chart?.getAttribute('data-points')), chartLabel: q('section.mk-chartp')?.getAttribute('aria-label') ?? '', chartEmpty: tx('.mk-chart .mk-empty b'), path,
    tapeIds: [...document.querySelectorAll(g('tape-row'))].map((r) => r.getAttribute('data-market-id')), tapeHead: tx('.mk-tape .mk-ph-r').split(' ').pop(), tapeEmpty: tx('.mk-tape .mk-none'),
    epochRows, epochsHead: eh ? `${eh[1]} · last ${eh[2]}` : tx('.mk-epochs .mk-ph-r'),
    recent: [...document.querySelectorAll(g('recent-epoch'))].map((r) => ({ epoch: r.getAttribute('data-epoch'), cents: r.getAttribute('data-cents') ?? '' })), bookCount: document.querySelectorAll(g('sealed-book')).length,
    p3dMarket: p3d?.getAttribute('data-market'), p3dModel: p3d?.getAttribute('data-model'), p3dKind: p3d?.getAttribute('data-kind'), p3dMode: p3d?.getAttribute('data-mode'), p3dLast: p3d?.getAttribute('data-last-price') ?? '',
    p3dPrice: tx(g('product-price')), canvasLabel: canvas?.getAttribute('aria-label') ?? '', rotation: p3d?.getAttribute('data-rotation') ?? null,
    announce: tx('.asw [aria-live]'),
  };
});

/** The price text the switcher's option for `sym` shows right now ("no trade yet" when it has none): taken just before a switch, it is the
 *  price the product announces at click time (prices change every epoch, so the announcement may lag the DOM by one rollover). */
const priceOf = (page, sym) => page.evaluate((x) => { const o = document.querySelector(`[data-testid="asset-option"][data-symbol="${x}"]`); return o ? Number(o.getAttribute('data-last')) || 0 : 0; }, sym).then((c) => (c > 0 ? lib.usdText(c) : lib.NO_TRADE));
const catEntry = (sym) => CATALOG.find((c) => c.symbol === sym);
const expOf = (snap, sym) => lib.expectedFor(catEntry(sym), snap.opts.find((o) => o.symbol === sym));

const SHOT_CSS = 'html.probe-shot .p3d-top, html.probe-shot .p3d-bot, html.probe-shot .p3d-glow, html.probe-shot .p3d-reset, html.probe-shot .p3d-hint, html.probe-shot .p3d-chip { visibility: hidden !important; }';
/** The 3D stage as pixels only. The text overlays are hidden for the whole session (class set once at page open, see open()), so two markets
 *  cannot differ by their labels, and toggling the class around a shot (which re-composites the panel) cannot make a still frame differ. */
async function stageShot(page) {
  try { return await page.locator('[data-testid="product-3d"] .p3d-stage').screenshot({ timeout: 15000 }); } catch { return null; }
}

const hashes = {};           // symbol -> picture hash of the frame taken first for that market
const seriesBy = {};         // symbol -> price series signature
const problems = [];         // failures that belong to no market row
const rows = [];
let prevExp = null;
const note = (m) => console.log('  note', m);
const problem = (m) => { problems.push(m); };

/**
 * Settle after a switch, then read once and check. opts.spin: also run the 3D motion/picture checks (desktop only).
 * Returns { snap, exp, checks }; pushes a table row when opts.row.
 */
async function verify(page, symbol, via, opts = {}) {
  await waitSettled(page, symbol);
  await sleep(MORPH_MS);   // the product morph
  const snap0 = await snapshot(page); const rot0 = snap0.rotation;
  const shotA = opts.spin ? await stageShot(page) : null;
  await sleep(opts.spin ? SPIN_MS : 0);
  let snap = await snapshot(page);
  const shotB = opts.spin ? await stageShot(page) : null;
  let exp = expOf(snap, symbol);
  // The announcement carries the price of the click; the DOM price is read now. Same market throughout: the announced price must be one this
  // market showed since the click (before the click, at the two reads). If the announcement still disagrees, re-read once (one rollover).
  const seen = [...(opts.seen ?? []), snap0.lastPrice, snap.lastPrice];
  const prevFor = opts.prev === undefined ? prevExp : opts.prev; const wantAnnounce = opts.announce !== false;
  let checks = lib.checkMarket(snap, exp, prevFor, { announce: wantAnnounce, seen });
  if (wantAnnounce && checks.some((c) => c.key === 'announce' && !c.ok)) {
    await sleep(250); snap = await snapshot(page); exp = expOf(snap, symbol); seen.push(snap.lastPrice);
    checks = lib.checkMarket(snap, exp, prevFor, { announce: true, seen });
  }
  const row = { symbol, category: exp.category, priceText: exp.priceText, points: exp.points, tape: snap.tapeIds.length, via, checks, spin: null, extra: [], empty: exp.traded ? 'no' : 'yes' };
  if (opts.spin) {
    const hA = shotA && shotA.length > lib.BLANK_BYTES ? lib.hashOf(shotA) : null; const hB = shotB && shotB.length > lib.BLANK_BYTES ? lib.hashOf(shotB) : null;
    row.spin = lib.spinCheck({ mode: snap.p3dMode, shotsDiffer: hA !== null && hB !== null && hA !== hB, rotA: rot0, rotB: snap.rotation, reduced: REDUCED });
    row.extra.push(lib.modelCheck({ reduced: REDUCED, hash: hA, others: hashes }, symbol));
    if (hA !== null && !(symbol in hashes)) hashes[symbol] = hA;
    row.shotBytes = shotA ? shotA.length : 0;
  }
  if (opts.row) { rows.push(row); seriesBy[symbol] = lib.seriesOf(snap); }
  else for (const c of [...checks, ...(row.spin ? [row.spin] : []), ...row.extra]) if (!c.ok) problem(`${symbol} (${via}) ${c.key}: ${c.detail}`);
  if (opts.prev === undefined) prevExp = exp;
  return { snap, exp, checks };
}

(async () => {
  const local = ARGS.base ? null : await startServer(); const BASE = ARGS.base ?? local.base;
  console.log(`probe-assets: ${BASE}  catalog ${CATALOG.length} markets${REDUCED ? '  (reduced motion)' : ''}`);
  const browser = await chromium.launch({ args: GL_ARGS });
  const ctxOpts = (w, h, extra = {}) => ({ viewport: { width: w, height: h }, reducedMotion: REDUCED ? 'reduce' : 'no-preference', ...extra });
  const open = async (ctx, hash = '') => { const page = await ctx.newPage(); watchErrors(page); await page.goto(`${BASE}/market/${hash}`, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.addStyleTag({ content: SHOT_CSS }); await page.evaluate(() => document.documentElement.classList.add('probe-shot')); return page; };
  try {
    // desktop: the whole catalog through the switcher
    const ctx = await browser.newContext(ctxOpts(1440, 900)); const page = await open(ctx);
    await waitSettled(page, null);
    const first = await snapshot(page);
    const syms = first.opts.map((o) => o.symbol);
    const flat = [...first.opts].sort((a, b) => CATALOG.findIndex((c) => c.symbol === a.symbol) - CATALOG.findIndex((c) => c.symbol === b.symbol));
    if (JSON.stringify([...syms].sort()) !== JSON.stringify(CATALOG.map((c) => c.symbol).sort())) problem(`listbox lists ${syms.length} markets that are not the ${CATALOG.length} catalog symbols`);
    if (JSON.stringify(syms) !== JSON.stringify(flat.map((o) => o.symbol))) note('listbox order differs from catalog order (grouped by category)');
    const wantGroups = [...new Set(CATALOG.map((c) => c.category))];
    if (JSON.stringify(first.groups) !== JSON.stringify(wantGroups)) problem(`listbox groups ${first.groups.join(',')} != catalog categories ${wantGroups.join(',')}`);
    const wantDefault = CATALOG[lib.pickDefault(flat, '')].symbol;
    if (first.selected !== wantDefault) problem(`default market is ${first.selected}, pickDefaultMarket rule gives ${wantDefault}`);
    const trig = T(page, 'asset-switcher-trigger');
    const classes = first.opts.map((o) => lib.classify(o)); if (classes.includes('inconsistent')) problem(`options with last/points that disagree: ${first.opts.filter((o) => lib.classify(o) === 'inconsistent').map((o) => o.symbol).join(',')}`);
    console.log(`  default market ${first.selected}; ${classes.filter((c) => c === 'traded').length} traded, ${classes.filter((c) => c === 'empty').length} with no history`);
    prevExp = expOf(first, first.selected);
    // Escape closes without a change, focus stays on the trigger
    await trig.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    { const s = await snapshot(page); if (s.expanded !== 'false' || !s.focusTrig || s.selected !== first.selected) problem(`Escape: expanded=${s.expanded} focusOnTrigger=${s.focusTrig} selected=${s.selected}`); }

    // every market in turn, after the current one and wrapping, so each one is selected through the dropdown
    const start = Math.max(0, CATALOG.findIndex((c) => c.symbol === first.selected));
    const order = CATALOG.map((c, i) => CATALOG[(start + 1 + i) % CATALOG.length].symbol);
    for (const [n, sym] of order.entries()) {
      const pos = syms.indexOf(sym); let via = 'click'; const seen = [await priceOf(page, sym)];
      if (n % 3 === 0) {   // keyboard: open, Home, ArrowDown x position, Enter
        via = 'keyboard';
        await trig.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Home');
        for (let k = 0; k < pos; k++) await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        const s = await snapshot(page); if (s.expanded !== 'false' || !s.focusTrig) problem(`${sym}: keyboard select left the list open or moved focus (expanded=${s.expanded} focus=${s.focusTrig})`);
      } else { await trig.click(); await page.locator(`[data-testid="asset-option"][data-symbol="${sym}"]`).click(); }
      await verify(page, sym, via, { row: true, spin: true, seen });
    }
    // Tab closes without selecting; an outside press closes
    await trig.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Tab');
    { const s = await snapshot(page); if (s.expanded !== 'false' || s.selected !== prevExp.symbol) problem(`Tab: expanded=${s.expanded} selected=${s.selected} (was ${prevExp.symbol})`); }
    await trig.click(); await page.mouse.click(5, 880);
    if ((await trig.getAttribute('aria-expanded')) !== 'false') problem('a pointer press outside does not close the listbox');
    // in-page hash change, back, unknown and malformed hashes
    const a = CATALOG[CATALOG.length - 1].symbol, b = CATALOG[1 % CATALOG.length].symbol;
    const dflt = (snap) => CATALOG[lib.pickDefault(snap.opts.map((o) => ({ symbol: o.symbol, last: o.last })).sort((x, y) => CATALOG.findIndex((c) => c.symbol === x.symbol) - CATALOG.findIndex((c) => c.symbol === y.symbol)), 'NOPE')].symbol;
    let seenH = [await priceOf(page, a)];
    await page.evaluate((s) => { location.hash = s; }, a); await verify(page, a, 'hashchange', { seen: seenH });
    seenH = [await priceOf(page, b)];
    await page.evaluate((s) => { location.hash = s; }, b); await verify(page, b, 'hashchange', { seen: seenH });
    seenH = [await priceOf(page, a)];
    await page.evaluate(() => history.back()); await verify(page, a, 'back', { seen: seenH });
    const fallback = dflt(await snapshot(page));
    await page.evaluate(() => { location.hash = 'NOPE-CLR'; }); await verify(page, fallback, 'unknown hash', { announce: false });
    await page.evaluate(() => { location.hash = '%E0%A4%A'; }); await verify(page, fallback, 'malformed hash', { announce: false });
    await ctx.close();

    // fresh deep links: the last market, and the first market without history (when there is one)
    const deep = [a]; const emptyFirst = first.opts.find((o) => lib.classify(o) === 'empty'); if (emptyFirst && emptyFirst.symbol !== a) deep.push(emptyFirst.symbol);
    for (const sym of deep) {
      const dctx = await browser.newContext(ctxOpts(1440, 900)); const dpage = await open(dctx, `#${encodeURIComponent(sym)}`);
      await verify(dpage, sym, 'deep link', { announce: false, prev: null, spin: true }); await dctx.close();
    }

    // phone 390 px: the switcher works without the Assets tab
    const pctx = await browser.newContext(ctxOpts(390, 844, { hasTouch: true, isMobile: true })); const ppage = await open(pctx);
    await waitSettled(ppage, null);
    const ptrig = T(ppage, 'asset-switcher-trigger'); const tb = await ptrig.boundingBox();
    if (!tb || tb.height < 44 || tb.x < 0 || tb.x + tb.width > 390) problem(`phone trigger box ${JSON.stringify(tb)} (needs >= 44 px tall, inside 390 px)`);
    if ((await T(ppage, 'market-terminal').getAttribute('data-tab')) === 'assets') problem('phone starts on the Assets tab');
    const before = await snapshot(ppage); const target = CATALOG[Math.max(0, CATALOG.length - 2)].symbol;
    const seenP = [await priceOf(ppage, target)];
    await ptrig.tap();
    const optH = await ppage.$$eval('[data-testid="asset-option"]', (els) => els.map((e) => e.getBoundingClientRect().height));
    if (optH.length !== CATALOG.length || optH.some((h) => h < 44)) problem(`phone options ${optH.map(Math.round).join(',')} px (need ${CATALOG.length}, each >= 44)`);
    await ppage.locator(`[data-testid="asset-option"][data-symbol="${target}"]`).tap();
    await verify(ppage, target, 'phone tap', { prev: before.selected === target ? null : expOf(before, before.selected), seen: seenP });
    if (await ppage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) problem('phone: horizontal overflow');
    await pctx.close();
  } finally { await browser.close(); local?.child.kill(); }

  for (const grp of lib.seriesCollisions(Object.entries(seriesBy).map(([symbol, series]) => ({ symbol, series })))) problem(`markets show the same price series: ${grp.join(' = ')}`);
  if (errs.length) problem(`console/page errors: ${[...new Set(errs)].join(' | ')}`);
  rows.sort((x, y) => CATALOG.findIndex((c) => c.symbol === x.symbol) - CATALOG.findIndex((c) => c.symbol === y.symbol));
  console.log(lib.formatTable(rows));
  const sizes = rows.map((r) => r.shotBytes).filter(Boolean); if (sizes.length) note(`3D stage screenshot bytes: min ${Math.min(...sizes)} max ${Math.max(...sizes)} (blank threshold ${lib.BLANK_BYTES})`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  const line = lib.summaryLine(rows, CATALOG.length, problems);
  console.log(`\n${line}`);
  process.exit(line.endsWith('correct') ? 0 : 1);
})().catch((e) => { console.error('probe-assets crashed:', e.message); process.exit(1); });
