// Drives the REAL /app/agent AgentDesk in headless Chromium with the keyboard: slider arrows, Home/End, Previous/Next.
// The page is served from a fake origin and every other request (the public RPC included) is refused: no network.
// Skipped (loudly) only when no Chromium can be launched on this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { bundle } from './helpers/bundle.ts';

// Event counts and numbers come from run.json, so a fresh agent run does not break this test.
const RUN = JSON.parse(readFileSync(new URL('../../src/data/run.json', import.meta.url), 'utf8'));
const N: number = RUN.events.length;
const ATTACK: number = RUN.events.find((e: any) => e.kind === 'revert').id;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const vt = (i: number, title = '') => new RegExp('^event ' + i + ' of ' + N + ': ' + esc(title));

const ORIGIN = 'http://app.test';
let browser: Browser | null = null;
let script = '';

before(async () => {
  script = await bundle(`
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import AgentDesk from './src/components/flow/AgentDesk.tsx';
    createRoot(document.getElementById('root')!).render(h(AgentDesk));
  `, 'iife', 'browser');
  try { browser = await chromium.launch(); } catch (e) { console.error('SKIP browser tests: chromium unavailable: ' + String(e).split('\n')[0]); }
});
after(async () => { await browser?.close(); });

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1200, height: 900 } });
  const html = '<!doctype html><body style="margin:0"><div id="root"></div><script>' + script.replace(/<\/script/g, '<\\/script') + '</script>';
  await page.route('**/*', (r) => (r.request().url().startsWith(ORIGIN) ? r.fulfill({ status: 200, contentType: 'text/html', body: html }) : r.abort()));
  await page.goto(ORIGIN + '/app/agent');
  await page.waitForSelector('.dk-row');
  return page;
}

const slider = (p: Page) => p.locator('input[type=range]');
const current = (p: Page) => p.locator('li[aria-current="true"]').getAttribute('data-i');
const stageOn = (p: Page) => p.locator('.dk-stage.on').innerText();
const focused = (p: Page) => p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '');

test('/app/agent desk by keyboard: the selected row, aria-valuetext and explanation follow; focus stays on the pressed control at both ends', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const page = await open();
  try {
    // first paint: whole run, last event selected
    assert.equal(await page.locator('li.dk-row').count(), N);
    assert.equal(await current(page), String(N));
    assert.match((await slider(page).getAttribute('aria-valuetext'))!, vt(N));
    assert.match(await stageOn(page), /Settlement/);

    // slider arrows
    await slider(page).focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await current(page), String(N - 1));
    assert.match((await slider(page).getAttribute('aria-valuetext'))!, vt(N - 1));
    await page.keyboard.press('ArrowRight');
    assert.equal(await current(page), String(N));
    await page.keyboard.press('Home');
    assert.equal(await current(page), '1');
    assert.match((await slider(page).getAttribute('aria-valuetext'))!, vt(1, 'Mandate read from chain'));
    assert.match(await stageOn(page), /Mandate/);
    assert.equal(await page.locator('.dk-count').innerText(), `Event 1 of ${N}`);

    // Previous at the start: stays focused, nothing changes
    const prev = page.getByRole('button', { name: 'Previous event' });
    const next = page.getByRole('button', { name: 'Next event' });
    await prev.focus();
    assert.equal(await prev.getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('Enter');
    assert.equal(await current(page), '1');
    assert.equal(await focused(page), 'Previous event');
    // Next from there moves on and Previous becomes enabled
    await next.focus();
    await page.keyboard.press('Enter');
    assert.equal(await current(page), '2');
    assert.equal(await prev.getAttribute('aria-disabled'), null);

    // an attack row changes the explanation: stage rail and the row's name carry the kind
    await page.locator(`[data-i="${ATTACK}"] .dk-row-btn`).click();
    assert.equal(await current(page), String(ATTACK));
    assert.match(await stageOn(page), /Refusals/);
    assert.match((await slider(page).getAttribute('aria-valuetext'))!, vt(ATTACK, 'The agent inflates its profit claim'));
    assert.ok((await page.locator(`[data-i="${ATTACK}"] .dk-row-btn`).getAttribute('aria-label'))!.startsWith(`Explain event ${ATTACK}, refused: `));

    // Next at the end: stays focused and disabled for AT, nothing changes
    await slider(page).focus();
    await page.keyboard.press('End');
    assert.equal(await current(page), String(N));
    await next.focus();
    assert.equal(await next.getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('Enter');
    assert.equal(await current(page), String(N));
    assert.equal(await focused(page), 'Next event');
    await prev.focus();
    await page.keyboard.press('Enter');
    assert.equal(await current(page), String(N - 1));
    assert.equal(await next.getAttribute('aria-disabled'), null);
  } finally { await page.close(); }
});
