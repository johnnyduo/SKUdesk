// Drives the REAL /app/radar RadarSweep in headless Chromium: armed below the fold, one-time sweep on scroll, "Show all results now"
// by keyboard, focus hand-off, reduced motion and already-on-screen. The page is served from a fake origin and every other request
// is refused: no network. The 7.7 s sweep runs on Playwright's fake clock. Skipped (loudly) only when no Chromium can be launched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { bundle, loadNodeModule } from './helpers/bundle.ts';

const ORIGIN = 'http://app.test';
const FINAL = 'All 10 verdicts shown. They were computed by matchOffer when this page was built.';
let browser: Browser | null = null;
let script = '';
let hydrateScript = '';
let ssr = '';

before(async () => {
  script = await bundle(`
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import RadarSweep from './src/components/commerce/RadarSweep.tsx';
    import { ROWS } from './src/components/commerce/market.ts';
    createRoot(document.getElementById('root')!).render(h(RadarSweep, { rows: ROWS, groups: true }));
  `, 'iife', 'browser');
  hydrateScript = await bundle(`
    import { createElement as h } from 'react';
    import { hydrateRoot } from 'react-dom/client';
    import RadarSweep from './src/components/commerce/RadarSweep.tsx';
    import { ROWS } from './src/components/commerce/market.ts';
    hydrateRoot(document.getElementById('root')!, h(RadarSweep, { rows: ROWS, groups: true }));
  `, 'iife', 'browser');
  ssr = (await loadNodeModule<{ html: string }>(`
    import { createElement as h } from 'react';
    import { renderToString } from 'react-dom/server';
    import RadarSweep from './src/components/commerce/RadarSweep.tsx';
    import { ROWS } from './src/components/commerce/market.ts';
    export const html = renderToString(h(RadarSweep, { rows: ROWS, groups: true }));
  `)).html;
  try { browser = await chromium.launch(); } catch (e) { console.error('SKIP browser tests: chromium unavailable: ' + String(e).split('\n')[0]); }
});
after(async () => { await browser?.close(); });

async function open(o: { above?: number; reduced?: boolean; hydrate?: boolean } = {}): Promise<Page> {
  const ctx = await browser!.newContext({ viewport: { width: 1000, height: 700 }, reducedMotion: o.reduced ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  // content above the list pushes it below the fold; content below keeps the page scrollable past it
  const html = `<!doctype html><style>html{overflow-anchor:none}</style><body style="margin:0"><div style="height:${o.above ?? 0}px"></div><div id="root">${o.hydrate ? ssr : ''}</div><div style="height:1500px"></div><script>`
    + (o.hydrate ? hydrateScript : script).replace(/<\/script/g, '<\\/script') + '</script>';
  // the text of the live region every time it changes (consecutive duplicates collapsed)
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  (page as Page & { errors: string[] }).errors = errors;
  await page.addInitScript(() => {
    const w = window as unknown as { __live: string[] };
    w.__live = [];
    const note = () => { const el = document.getElementById('mk-sweep-status'); if (!el) return; const x = el.textContent ?? ''; if (w.__live[w.__live.length - 1] !== x) w.__live.push(x); };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.clock.install();
  await page.route('**/*', (r) => (r.request().url().startsWith(ORIGIN) ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) : r.abort()));
  await page.goto(ORIGIN + '/app/radar');
  await page.waitForSelector('.mk-row');
  return page;
}
const button = (p: Page) => p.getByRole('button', { name: 'Show all results now' });
const pending = (p: Page) => p.locator('.mk-row.pending').count();
const finalRows = (p: Page) => p.locator('.mk-row.locked, .mk-row.rejected').count();
const status = (p: Page) => p.locator('#mk-sweep-status').textContent();
const focusedIsList = (p: Page) => p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Identity-gate verdicts');
const live = (p: Page) => p.evaluate(() => (window as unknown as { __live: string[] }).__live);
const tick = (p: Page, ms: number) => p.clock.runFor(ms);

test('below the fold the rows wait, the sweep starts when the list is reached, and Show all results now (keyboard) ends it with focus on the list', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const page = await open({ above: 2500 });
  try {
    await button(page).waitFor();
    assert.equal(await pending(page), 9, 'armed: every row but the one about to be checked waits');
    assert.equal(await finalRows(page), 0);
    assert.equal(await page.locator('.mk-row .sr-only', { hasText: /^(LOCKED|REJECTED)$/ }).count(), 10, 'assistive tech has every verdict meanwhile');
    assert.equal(await status(page), '', 'the live region is empty while the sweep runs');
    assert.equal(await page.locator('.mk-sweep-bar p[aria-hidden=true]').textContent(), 'Revealing the stored verdicts, gate by gate.');
    // reaching the list starts the sweep
    await page.evaluate(() => document.querySelector('.mk-rows')!.scrollIntoView());
    await page.waitForSelector('.mk-row.scan');
    await tick(page, 700);
    assert.ok(await finalRows(page) >= 1 && await finalRows(page) < 10, 'the sweep is in progress');
    // the button by keyboard
    await button(page).focus();
    // scrolled past the whole list (the page has room below it): the list is out of view when focus moves to it
    await page.evaluate(() => window.scrollTo(0, document.querySelector('.mk-rows')!.getBoundingClientRect().bottom + window.scrollY + 100));
    assert.ok(await page.evaluate(() => document.querySelector('.mk-rows')!.getBoundingClientRect().bottom < 0));
    const y = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('Enter');
    assert.equal(await finalRows(page), 10);
    assert.equal(await page.evaluate(() => window.scrollY), y, 'moving focus to the list does not scroll the page');
    assert.equal(await pending(page), 0);
    assert.equal(await button(page).count(), 0, 'the control is gone once there is nothing to skip');
    assert.ok(await focusedIsList(page), 'focus moved to the list, not dropped to the page');
    assert.equal(await status(page), FINAL);
    assert.deepEqual(await live(page), [FINAL, '', FINAL], 'empty while sweeping, then the sentence once: one polite announcement');
    // it plays once only: away and back, still final
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.querySelector('.mk-rows')!.scrollIntoView());
    await tick(page, 500);
    assert.equal(await pending(page), 0);
    assert.equal(await button(page).count(), 0);
  } finally { await page.context().close(); }
});

test('skipped before it was ever reached: later scrolling does not start a sweep', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const page = await open({ above: 2500 });
  try {
    await button(page).waitFor();
    await button(page).focus();
    await page.keyboard.press('Enter');
    assert.equal(await finalRows(page), 10);
    await page.evaluate(() => document.querySelector('.mk-rows')!.scrollIntoView());
    await tick(page, 500);
    assert.equal(await pending(page), 0);
    assert.equal(await button(page).count(), 0);
  } finally { await page.context().close(); }
});

test('left alone, the sweep finishes by itself; focus on the control moves to the list instead of being lost', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const page = await open({ above: 2500 });
  try {
    await page.evaluate(() => document.querySelector('.mk-rows')!.scrollIntoView());
    await button(page).waitFor();
    await page.waitForSelector('.mk-row.scan');
    await button(page).focus();
    await tick(page, 9000);
    assert.equal(await finalRows(page), 10);
    assert.equal(await button(page).count(), 0);
    assert.ok(await focusedIsList(page));
    assert.equal(await status(page), FINAL);
    assert.deepEqual(await live(page), [FINAL, '', FINAL]);
    // finished by itself: away and back, it stays final (no second sweep)
    await page.evaluate(() => window.scrollTo(0, 0));
    await tick(page, 300);
    await page.evaluate(() => document.querySelector('.mk-rows')!.scrollIntoView());
    await tick(page, 500);
    assert.equal(await pending(page), 0);
    assert.equal(await finalRows(page), 10);
    assert.equal(await button(page).count(), 0);
    assert.deepEqual(await live(page), [FINAL, '', FINAL]);
  } finally { await page.context().close(); }
});

test('nothing is hidden when the list is on screen at load, or with reduced motion', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  for (const o of [{ above: 0 }, { above: 2500, reduced: true }]) {
    const page = await open(o);
    try {
      await tick(page, 500);
      assert.equal(await pending(page), 0, JSON.stringify(o));
      assert.equal(await finalRows(page), 10, JSON.stringify(o));
      assert.equal(await button(page).count(), 0, JSON.stringify(o));
      assert.deepEqual(await live(page), [FINAL], 'the sentence is static text here: the live region never changes');
    } finally { await page.context().close(); }
  }
});

test('hydrating the server markup: the final state becomes armed below the fold without a mismatch, then the sweep runs once', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const page = await open({ above: 2500, hydrate: true });
  try {
    assert.match(ssr, /class="mk-row locked/);
    assert.doesNotMatch(ssr, /pending|<button/);
    await button(page).waitFor();
    assert.equal(await pending(page), 9);
    assert.deepEqual((page as Page & { errors: string[] }).errors, [], 'no hydration or page errors');
    await page.evaluate(() => document.querySelector('.mk-rows')!.scrollIntoView());
    await page.waitForSelector('.mk-row.scan');
    await tick(page, 9000);
    assert.equal(await finalRows(page), 10);
    assert.deepEqual(await live(page), [FINAL, '', FINAL]);
    assert.deepEqual((page as Page & { errors: string[] }).errors, []);
  } finally { await page.context().close(); }
});
