// Usage: node scripts/hero-check.mjs   (after `npm run build`). Env: DIST=/path/to/dist to check another build,
// ONLY=desktop,follow,... to run just some scenarios (desktop follow lost idle permaloss restore fit mobile reduced nowebgl nojs).
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/serve.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(web, '.shots'); await mkdir(out, { recursive: true });
const srv = await serve(process.env.DIST ?? path.join(web, 'dist'));
const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const launch = (args = GL) => chromium.launch({ args }).catch(() => chromium.launch({ channel: 'chrome', args }));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (n) => !ONLY || ONLY.includes(n);
let failed = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failed++; };
const scrollTo = (page, p) => page.evaluate((p) => { const r = document.querySelector('.sc'); scrollTo(0, r.offsetTop + p * (r.offsetHeight - innerHeight)); }, p);
const settle = (page, ms = 1600) => page.waitForTimeout(ms);
const attach = (page, label) => {
  page.on('pageerror', (e) => { console.log(`FAIL  [${label}] page error: ${e.message}`); failed++; });
  page.on('response', (r) => { if (r.status() >= 400) console.log(`WARN  [${label}] ${r.status()} ${r.url()}`); if (r.status() >= 400 && r.url().includes('/img/')) { console.log(`FAIL  [${label}] image ${r.status()} ${r.url()}`); failed++; } });
};
const noOverlap = (page) => page.evaluate(() => { const r = [...document.querySelectorAll('.sc-card')].map((e) => e.getBoundingClientRect()); return r.every((b, i) => i === 0 || b.top >= r[i - 1].bottom - 1); });
const activeName = (page) => page.evaluate(() => document.querySelector('.sc-card.is-active .sc-name')?.textContent?.trim() ?? '');
const inView = (page, sel, count) => page.evaluate(([sel, count]) => { const els = [...document.querySelectorAll(sel)]; return els.length === count && els.every((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }); }, [sel, count]);

// desktop: active tile follows scroll (works for any item count)
if (want('desktop')) {
  const b = await launch(); const page = await b.newPage({ viewport: { width: 1440, height: 900 } }); attach(page, 'desktop');
  // Record how many WebGL frames had been drawn the first time `sc-ready` (the poster fade) appeared.
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const sc = document.querySelector('.sc');
      if (sc && sc.classList.contains('sc-ready') && window.__readyRenders === undefined) window.__readyRenders = Number(sc.dataset.renders || 0);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await page.goto(srv.url + '/'); await page.waitForSelector('.sc.sc-ready', { timeout: 25000 });
  await page.waitForTimeout(800);
  const rr = await page.evaluate(() => window.__readyRenders);
  ok('poster fades only after at least one WebGL frame was drawn', typeof rr === 'number' && rr >= 1, `renders at first sc-ready: ${rr}`);
  ok('poster hides after first WebGL frame', await page.evaluate(() => getComputedStyle(document.querySelector('.sc-poster')).opacity === '0'));
  const names = await page.evaluate(() => [...document.querySelectorAll('.sc-card .sc-name')].map((e) => e.textContent.trim()));
  const count = names.length;
  ok('at least 2 product cards', count >= 2, `count ${count}`);
  for (let i = 0; i < count; i++) {
    const p = i / (count - 1);
    await scrollTo(page, p); await settle(page);
    const got = await page.evaluate(() => document.querySelector('.sc').dataset.active);
    ok(`desktop tile ${i} at p=${p.toFixed(2)}`, got === String(i), `got ${got}`);
    ok(`desktop tile ${i}: caption names it`, (await activeName(page)) === names[i]);
    if (i === 0 || i === count - 1 || i === Math.floor(count / 2)) await page.screenshot({ path: path.join(out, `hero-d-${i}.png`) });
  }
  ok('exactly one caption active', (await page.locator('.sc-card.is-active').count()) === 1);
  ok('first card is tagged On-chain run', (await page.locator('.sc-card').first().locator('.sc-rec').count()) === 1);
  ok('only one card is tagged On-chain run', (await page.locator('.sc-rec').count()) === 1);
  ok('"Identical match" only on the recorded card', (await page.locator('.sc-ok').count()) === 1 && (await page.locator('.sc-card').first().locator('.sc-ok').count()) === 1);
  const kinds = await page.evaluate(() => [...document.querySelectorAll('.sc-card')].map((e) => e.dataset.kind));
  ok('first card is the on-chain run, the other seven are market products', kinds[0] === 'run' && kinds.length === 8 && kinds.slice(1).every((k) => k === 'market'), JSON.stringify(kinds));
  const mk = await page.evaluate(() => [...document.querySelectorAll('.sc-card[data-kind="market"]')].map((e) => ({ name: e.querySelector('.sc-name')?.textContent?.trim() ?? '', cat: e.dataset.category, cents: Number(e.dataset.listCents), line: e.querySelector('.sc-line')?.textContent?.trim() ?? '', href: e.querySelector('.sc-go')?.getAttribute('href'), tags: e.querySelectorAll('.sc-ok, .sc-rec').length })));
  ok('seven market cards with distinct names from five categories', mk.length === 7 && new Set(mk.map((e) => e.name)).size === 7 && new Set(mk.map((e) => e.cat)).size === 5, `${mk.length} cards, ${new Set(mk.map((e) => e.cat)).size} categories`);
  ok('market captions say "US list price" and match the card data (whole dollars and cents)', mk.every((e) => { const m = e.line.match(/^(\w+) · US list price \$([\d,]+)\.(\d\d)$/); return !!m && m[1] === e.cat && Number(m[2].replace(/,/g, '')) * 100 + Number(m[3]) === e.cents && e.cents > 0; }), mk.map((e) => e.line).join(' | '));
  ok('market cards carry neither the identical nor the on-chain run tag, and link to /market', mk.every((e) => e.tags === 0 && e.href === '/market'));
  ok('no market caption claims live or street prices', mk.every((e) => !/live|street/i.test(e.line)));
  // frame time (informational on software GL)
  await scrollTo(page, 0); await settle(page, 600);
  const stats = await page.evaluate(async () => {
    const r = document.querySelector('.sc'); const total = r.offsetHeight - innerHeight, t0 = performance.now(); const dts = []; let last = t0;
    await new Promise((res) => { const f = (t) => { dts.push(t - last); last = t; const k = Math.min(1, (t - t0) / 3000); scrollTo(0, r.offsetTop + k * total); k < 1 ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
    dts.sort((a, b) => a - b);
    const gl = document.createElement('canvas').getContext('webgl'); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return { median: dts[dts.length >> 1], p95: dts[Math.floor(dts.length * 0.95)], renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown' };
  });
  const soft = /swiftshader|software|llvmpipe/i.test(stats.renderer);
  console.log(`INFO  frame time median ${stats.median.toFixed(1)}ms p95 ${stats.p95.toFixed(1)}ms on "${stats.renderer}"`);
  if (soft) console.log('NOTE  software GL: frame time is informational only'); else ok('median frame ≤ 20ms on GPU', stats.median <= 20);
  await b.close();
}

// caption follows the RENDERED (smoothed) ring position, not the scroll target, on every frame mid-transition
if (want('follow')) {
  const b = await launch(); const page = await b.newPage({ viewport: { width: 1440, height: 900 } }); attach(page, 'follow');
  await page.goto(srv.url + '/'); await page.waitForSelector('.sc.sc-ready', { timeout: 25000 }); await scrollTo(page, 0); await settle(page, 1200);
  const n = await page.locator('.sc-card').count(); const target = Math.floor((n - 1) / 2); // the middle tile, for any card count
  const res = await page.evaluate(([n, target]) => new Promise((resolve) => {
    const r = document.querySelector('.sc'), total = r.offsetHeight - innerHeight, samples = []; let frame = 0;
    const f = () => {
      if (frame < 5) scrollTo(0, r.offsetTop + (((frame + 1) / 5) * target / (n - 1)) * total); // p = 1/5 ... 5/5 of the way to the middle tile, one step per frame
      frame++;
      samples.push({ active: r.dataset.active, pos: Number(r.dataset.pos) });
      if (frame < 90 && !(frame > 8 && Math.abs(Number(r.dataset.pos) - target) < 0.002)) requestAnimationFrame(f); else resolve(samples);
    };
    requestAnimationFrame(f);
  }), [n, target]);
  const bad = res.filter((x) => x.active !== String(Math.round(x.pos)));
  const mid = res.filter((x) => Math.abs(x.pos - Math.round(x.pos)) > 0.05);
  ok('caption equals round(rendered ring position) at every frame', bad.length === 0, bad.length ? `first mismatch ${JSON.stringify(bad[0])} of ${res.length} samples` : `${res.length} samples`);
  ok('the follow check really ran mid-transition (>= 3 samples between tiles)', mid.length >= 3, `${mid.length} mid-flight samples`);
  await b.close();
}

// transient context loss: poster returns, loop stops (captions still follow scroll), rendering resumes on restore
if (want('lost')) {
  const b = await launch(); const page = await b.newPage({ viewport: { width: 1440, height: 900 } }); attach(page, 'lost');
  await page.goto(srv.url + '/'); await page.waitForSelector('.sc.sc-ready', { timeout: 25000 });
  await scrollTo(page, 0.3); await settle(page, 2500);
  await page.evaluate(() => { const c = document.querySelector('.sc-gl'); const gl = c.getContext('webgl2') ?? c.getContext('webgl'); window.__x = gl.getExtension('WEBGL_lose_context'); window.__x.loseContext(); });
  await page.waitForTimeout(400);
  ok('poster returns on context loss', await page.evaluate(() => !document.querySelector('.sc').classList.contains('sc-ready')));
  const rBefore = await page.evaluate(() => document.querySelector('.sc').dataset.renders);
  const n = await page.locator('.sc-card').count(); const lostAt = Math.round(0.75 * (n - 1));
  await scrollTo(page, lostAt / (n - 1)); await page.waitForTimeout(800);   // scroll DURING the loss (to the tile nearest 75%)
  const during = await page.evaluate(() => ({ ready: document.querySelector('.sc').classList.contains('sc-ready'), renders: document.querySelector('.sc').dataset.renders, active: document.querySelector('.sc').dataset.active }));
  ok('no WebGL frames and no poster fade while the context is lost', !during.ready && during.renders === rBefore, `renders ${rBefore} -> ${during.renders}, ready ${during.ready}`);
  ok('captions keep following the scroll while the context is lost', during.active === String(lostAt), `active ${during.active}`);
  await page.evaluate(() => window.__x.restoreContext()); await settle(page, 1200);
  ok('rendering resumes after context restore', await page.evaluate(() => document.querySelector('.sc').classList.contains('sc-ready')));
  await b.close();
}

// render loop is idle when the hero is really off-screen (fresh page, scrolled to the bottom)
if (want('idle')) {
  const b = await launch(); const page = await b.newPage({ viewport: { width: 1440, height: 900 } }); attach(page, 'idle');
  await page.goto(srv.url + '/'); await page.waitForSelector('.sc.sc-ready', { timeout: 25000 }); await settle(page, 800);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await settle(page, 2500);
  ok('hero is really off-screen (more than 10% of a viewport above)', await page.evaluate(() => document.querySelector('.sc').getBoundingClientRect().bottom < -0.1 * innerHeight));
  const r1 = await page.evaluate(() => document.querySelector('.sc').dataset.renders); // read BEFORE poking the page
  await page.evaluate(() => { for (let i = 0; i < 3; i++) dispatchEvent(new Event('scroll')); });
  await settle(page, 2000);
  const r2 = await page.evaluate(() => document.querySelector('.sc').dataset.renders);
  ok('render loop idle when the hero is off-screen', r1 === r2, `${r1} → ${r2}`);
  await b.close();
}

// permanent context loss unpins
if (want('permaloss')) {
  const b = await launch(); const page = await b.newPage({ viewport: { width: 1440, height: 900 } }); attach(page, 'permaloss');
  await page.goto(srv.url + '/'); await page.waitForSelector('.sc.sc-ready', { timeout: 25000 });
  await scrollTo(page, 0.3); await settle(page, 1200);
  await page.evaluate(() => { const c = document.querySelector('.sc-gl'); const gl = c.getContext('webgl2') ?? c.getContext('webgl'); gl.getExtension('WEBGL_lose_context').loseContext(); });
  await page.waitForTimeout(6000);
  ok('permanent context loss falls back to the unpinned layout', await page.evaluate(() => document.querySelector('.sc').classList.contains('sc-static') && getComputedStyle(document.querySelector('.sc-sticky')).position === 'static'));
  ok('permanent context loss: cards stack without overlapping', await noOverlap(page));
  await b.close();
}

// scroll restoration lands on the right tile
if (want('restore')) {
  const b = await launch(); const page = await b.newPage({ viewport: { width: 1440, height: 900 } }); attach(page, 'restore');
  await page.goto(srv.url + '/'); await page.waitForSelector('.sc.sc-ready', { timeout: 25000 });
  const count = await page.locator('.sc-card').count();
  const want = Math.min(2, count - 1);
  await scrollTo(page, want / (count - 1)); await settle(page, 1200);
  await page.reload(); await page.waitForSelector('.sc.sc-ready', { timeout: 25000 }); await settle(page, 900);
  ok(`reload while scrolled to tile ${want}`, (await page.evaluate(() => document.querySelector('.sc').dataset.active)) === String(want));
  await b.close();
}

// first screen fits: CTA, scope tag (and the active caption when pinned) are fully visible
const FIT = [[375, 667], [360, 740], [360, 800], [375, 812], [390, 844], [1280, 720], [1440, 900]];
if (want('fit')) for (const [w, h] of FIT) {
  const b = await launch(); const page = await b.newPage({ viewport: { width: w, height: h } }); attach(page, `fit-${w}x${h}`);
  await page.goto(srv.url + '/'); await page.waitForSelector('.sc.sc-ready, .sc.sc-static', { timeout: 25000 }); await settle(page, 1200);
  const pinned = await page.evaluate(() => !document.querySelector('.sc').classList.contains('sc-static') && getComputedStyle(document.querySelector('.sc-sticky')).position === 'sticky');
  ok(`${w}x${h}: pinned exactly when taller than 700px`, pinned === (h > 700), `pinned ${pinned}`);
  ok(`${w}x${h}: kicker ("Built on Robinhood Chain") visible on the first screen`, await inView(page, '.sc .lp-kicker', 1) && await page.evaluate(() => { const e = document.querySelector('.sc .lp-kicker'); const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 && /Robinhood Chain/.test(e.textContent); }));
  ok(`${w}x${h}: both buttons fully visible on the first screen`, await inView(page, '.sc .lp-cta a', 2));
  ok(`${w}x${h}: scope tag visible on the first screen`, await inView(page, '.sc .sc-scope', 1));
  ok(`${w}x${h}: sub line visible on the first screen`, await inView(page, '.sc .lp-sub', 1));
  ok(`${w}x${h}: hero copy says "identical" and shows the live category`, await page.evaluate(() => /identical/i.test(document.querySelector('.sc .lp-sub')?.textContent ?? '') && /live category/i.test(document.querySelector('.sc .sc-scope')?.textContent ?? '')));
  if (pinned) {
    const ringH = await page.evaluate(() => document.querySelector('.sc-ring').clientHeight);
    ok(`${w}x${h}: ring is at least 200px tall`, ringH >= 200, `ring ${ringH}px`);
    ok(`${w}x${h}: active caption fully visible`, await inView(page, '.sc-card.is-active', 1));
    await scrollTo(page, 1); await settle(page, 1800);
    ok(`${w}x${h}: last caption fully visible`, await inView(page, '.sc-card.is-active', 1));
  } else {
    ok(`${w}x${h}: unpinned layout hides the ring and stacks the cards`, await page.evaluate(() => getComputedStyle(document.querySelector('.sc-ring')).display === 'none' && getComputedStyle(document.querySelector('.sc-sticky')).position === 'static'));
  }
  await page.screenshot({ path: path.join(out, `fit-${w}x${h}.png`) });
  await b.close();
}

// phone-sized viewport + resize
if (want('mobile')) {
  const b = await launch(); const page = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); attach(page, 'mobile');
  await page.goto(srv.url + '/'); await page.waitForSelector('.sc.sc-ready', { timeout: 25000 });
  ok('compact layout on 390px', (await page.evaluate(() => document.querySelector('.sc').dataset.compact)) === 'true');
  ok('no horizontal scroll on 390px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const p of [0, 0.5, 1]) { await scrollTo(page, p); await settle(page); await page.screenshot({ path: path.join(out, `hero-m-${String(p).replace('.', '_')}.png`) }); }
  await page.setViewportSize({ width: 1440, height: 900 }); await settle(page, 1000);
  ok('compact flag clears when widened', (await page.evaluate(() => document.querySelector('.sc').dataset.compact)) === 'false');
  ok('canvas matches host after resize', await page.evaluate(() => { const c = document.querySelector('.sc-gl'), h = document.querySelector('.sc-canvas'); return c.clientWidth === h.clientWidth && c.clientHeight === h.clientHeight; }));
  await b.close();
}

// reduced motion, no WebGL, no JS
if (want('reduced')) {
  const b = await launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage(); attach(page, 'reduced'); await page.goto(srv.url + '/'); await page.waitForTimeout(1200);
  ok('reduced motion: not pinned', await page.evaluate(() => getComputedStyle(document.querySelector('.sc-sticky')).position === 'static'));
  ok('reduced motion: all cards visible', await page.evaluate(() => [...document.querySelectorAll('.sc-card')].every((e) => getComputedStyle(e).opacity === '1')));
  ok('reduced motion: cards stack without overlapping', await noOverlap(page));
  ok('reduced motion: product images shown', await page.evaluate(() => [...document.querySelectorAll('.sc-img')].every((e) => getComputedStyle(e).display !== 'none')));
  ok('reduced motion: headline is not full-width', await page.evaluate(() => document.querySelector('.sc-copy').getBoundingClientRect().width <= 645));
  await page.screenshot({ path: path.join(out, 'hero-reduced.png') });
  await b.close();
}
if (want('nowebgl')) {
  const b = await launch(['--disable-gpu', '--disable-3d-apis', '--disable-webgl']); const page = await b.newPage({ viewport: { width: 1440, height: 900 } }); attach(page, 'nowebgl');
  await page.goto(srv.url + '/');
  const fell = await page.waitForSelector('.sc.sc-static', { timeout: 25000 }).then(() => true, () => false);
  ok('no WebGL: falls back to static layout', fell);
  await settle(page, 1500); // tile image loads must not throw after the fallback
  ok('no WebGL: cards stack without overlapping', await noOverlap(page));
  await b.close();
}
if (want('nojs')) {
  const b = await launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const page = await ctx.newPage(); await page.goto(srv.url + '/');
  const texts = await page.evaluate(() => ({ h1: document.querySelector('h1')?.textContent?.trim(), cards: [...document.querySelectorAll('.sc-card .sc-name')].map((e) => e.textContent.trim()) }));
  ok('no JS: headline and product cards are in the DOM', /sealed rounds/.test(texts.h1 ?? '') && texts.cards.length >= 2, JSON.stringify(texts).slice(0, 160));
  ok('no JS: kicker visible', await page.evaluate(() => { const e = document.querySelector('.sc .lp-kicker'); const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && /Robinhood Chain/.test(e.textContent); }));
  ok('no JS: not pinned, ring hidden', await page.evaluate(() => getComputedStyle(document.querySelector('.sc-sticky')).position === 'static' && getComputedStyle(document.querySelector('.sc-ring')).display === 'none'));
  ok('no JS: all cards visible and stacked without overlapping', await noOverlap(page) && await page.evaluate(() => [...document.querySelectorAll('.sc-card')].every((e) => getComputedStyle(e).opacity === '1')));
  ok('marketplace strip shows the five source logos, below the hero', await page.evaluate(() => { const l = [...document.querySelectorAll('.ls-src-list li img')].map((e) => e.alt); const strip = document.querySelector('.ls-src'); const hero = document.querySelector('.sc'); return l.join('|') === 'Google Shopping|Lazada|Shopee|eBay|Best Buy' && !!hero && !!strip && !!(hero.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING) && [...document.querySelectorAll('.ls-src-list img')].every((i) => i.complete && i.naturalWidth > 0); }));
  { const hist = JSON.parse(readFileSync(new URL('../src/data/blindbook-history.json', import.meta.url), 'utf8')); const cnt = (n) => hist.events.filter((e) => e.e === n).length; const bidders = new Set(hist.events.filter((e) => e.e === 'Committed').map((e) => e.a.trader.toLowerCase())).size; const want = [cnt('EpochCleared'), cnt('Committed'), bidders, cnt('Fill')].map((n) => n.toLocaleString('en-US')); const got = await page.evaluate(() => [...document.querySelectorAll('.tr-v')].map((e) => e.dataset.v)); ok('track record: the four counts match the committed on-chain history; the profit is a dollar amount; band is below the logo strip', got.length === 5 && want.every((w, i) => got[i] === w) && /^\$[\d,]+\.\d\d$/.test(got[4]) && await page.evaluate(() => !!(document.querySelector('.ls-src').compareDocumentPosition(document.querySelector('.tr')) & Node.DOCUMENT_POSITION_FOLLOWING)), JSON.stringify({ want, got })); }
  ok('round: seven steps in order, between the logo strip and the vault flow, with no Next tags or legend', await page.evaluate(() => { const st = [...document.querySelectorAll('.rf-step')]; const t = st.map((e) => e.querySelector('b').textContent.trim()).join('|'); const a = document.querySelector('.ls-src'), r = document.querySelector('#round'), f = document.querySelector('#how'); const after = (x, y) => !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING); return t === 'Pick product|Agents find sources|Sealed bids|Round clears|Buyer pays|Delivery confirmed|Seller paid' && after(a, r) && after(r, f) && !r.querySelector('.rf-chip, .rf-key') && !/not built yet|\\bnext\\b/i.test(r.textContent); }));
  ok('flow: seven stages in order, below the logo strip', await page.evaluate(() => { const t = [...document.querySelectorAll('.pf-node b')].map((e) => e.textContent.trim()); const s = document.querySelector('.ls-src'); const f = document.querySelector('#how'); return t.join('|') === 'Owner sets limits|AI agent proposes|Identity gates|Contract checks|Cheats refused|Escrow pays|Settled' && !!(s.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); }));
  { const lit = () => page.evaluate(() => [...document.querySelectorAll('.pf-node')].filter((n) => parseFloat(getComputedStyle(n, '::before').opacity) > 0.5).length); const seen = []; for (let i = 0; i < 14; i++) { seen.push(await lit()); await page.waitForTimeout(450); } ok('flow: one stage lit at a time, and the loop does light stages', Math.max(...seen) === 1 && seen.some((n) => n === 1), JSON.stringify(seen)); }
  await page.setViewportSize({ width: 360, height: 740 });
  ok('flow: no horizontal overflow at 360px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 900 });
  ok('no JS: run link is reachable', await page.evaluate(() => getComputedStyle(document.querySelector('.sc-rec')).visibility === 'visible'));
  await b.close();
}

if (want('nojs')) {
  const b = await launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage(); await page.goto(srv.url + '/');
  ok('round: reduced motion shows the finished drawing (bids revealed, price line on, no animation)', await page.evaluate(() => { const m = [...document.querySelectorAll('.rd-m')]; const line = document.querySelector('.rd-line'); return m.length === 3 && m.every((e) => getComputedStyle(e).animationName === 'none' && getComputedStyle(e.querySelector('.rd-dot')).opacity === '1') && getComputedStyle(line).opacity === '1'; }));
  ok('flow: reduced motion stops the loop', await page.evaluate(() => [...document.querySelectorAll('.pf-node')].every((n) => getComputedStyle(n).animationName === 'none' && getComputedStyle(n, '::before').animationName === 'none')));
  await b.close();
}

if (want('nojs')) {
  const b = await launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { window.__calls = []; window.ethereum = { request: async (a) => { window.__calls.push(a); return null; } }; });
  const page = await ctx.newPage(); await page.goto(srv.url + '/'); await settle(page, 600);
  const f = await page.evaluate(() => ({ cols: [...document.querySelectorAll('.sf h3')].map((h) => h.textContent.trim()), explore: [...document.querySelectorAll('.sf [aria-label="Explore"] a')].map((a) => a.textContent.trim()), ext: [...document.querySelectorAll('.sf [aria-label="On-chain"] a')].every((a) => a.target === '_blank' && /noopener/.test(a.rel) && /^https:\/\/explorer\.testnet\.chain\.robinhood\.com\//.test(a.href)), sentence: /Prices shown are a fixed snapshot until live feeds are connected/.test(document.querySelector('.sf-bar')?.textContent ?? '') }));
  ok('footer: three link groups, the six journey links, explorer links open safely, and the price note stays', f.cols.join('|') === 'Explore|On-chain|Network' && f.explore.length === 6 && f.ext && f.sentence, JSON.stringify(f));
  await page.locator('[data-add-chain]').click(); await settle(page, 200);
  const r = await page.evaluate(() => ({ call: window.__calls[0], note: document.querySelector('.sf-note')?.textContent }));
  ok('footer: "Add Robinhood Chain Testnet" asks the wallet for chain 0xb626 with the explorer URL, then says so', r.call?.method === 'wallet_addEthereumChain' && r.call.params[0].chainId === '0xb626' && r.call.params[0].chainName === 'Robinhood Chain Testnet' && r.call.params[0].blockExplorerUrls[0] === 'https://explorer.testnet.chain.robinhood.com' && r.note === 'Network added.', JSON.stringify(r));
  await b.close();
}
if (want('nojs')) {
  const b = await launch(); const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); await page.goto(srv.url + '/'); await settle(page, 400);
  await page.locator('[data-add-chain]').click(); await settle(page, 200);
  ok('footer: with no wallet installed the button explains what to do', /No wallet found/.test(await page.locator('.sf-note').textContent()));
  await b.close();
}

await srv.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
