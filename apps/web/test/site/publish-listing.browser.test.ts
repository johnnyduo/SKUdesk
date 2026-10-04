// Drives the REAL PublishListing island in headless Chromium (bundled with esbuild, /api mocked with page.route).
// Skipped (loudly) only when no Chromium can be launched on this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { bundle } from './helpers/bundle.ts';

const ORIGIN = 'http://app.test';
const TOKEN = 't'.repeat(40);
let browser: Browser | null = null;
let script = '';

before(async () => {
  script = await bundle(`
    import { createElement } from 'react';
    import { createRoot } from 'react-dom/client';
    import PublishListing from './src/components/commerce/PublishListing.tsx';
    createRoot(document.getElementById('root')!).render(createElement(PublishListing, {
      lotId: 'LOT-1842', title: 'iPhone 16 Pro Clear MagSafe Case', link: 'https://robinize.agent-dong.workers.dev/p/CASE-IP16PRO-CLEAR-MAG-001/',
      imageLink: 'https://robinize.agent-dong.workers.dev/img/x.png', priceCents: 1099, brand: 'Robinize', gtin: null,
    }));
  `, 'iife', 'browser');
  try { browser = await chromium.launch(); } catch (e) { console.error('SKIP browser tests: chromium unavailable: ' + String(e).split('\n')[0]); }
});
after(async () => { await browser?.close(); });

const json = (data: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });

// Opens the island in live mode with a token and a REAL publish already done, so "Delete listing" is available.
async function ready(): Promise<{ page: Page; deletes: string[] }> {
  const page = await browser!.newPage();
  const deletes: string[] = [];
  await page.route(ORIGIN + '/', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="root"></div><script>' + script.replace(/<\/script/g, '<\\/script') + '</script>' }));
  await page.route(ORIGIN + '/api/**', (r) => {
    const m = r.request().method();
    if (m === 'DELETE') { deletes.push(r.request().url()); return r.fulfill(json({ mode: 'REAL', offerId: 'LOT-1842', status: 'DELETED' })); }
    return r.fulfill(json({ mode: 'REAL', offerId: 'LOT-1842', name: null, status: 'SUBMITTED', idempotent: false, updated: false }, 201));
  });
  await page.goto(ORIGIN + '/');
  await page.getByLabel(/Live publish to Google Merchant/).check();
  await page.locator('#op-token').fill(TOKEN);
  await page.getByRole('button', { name: 'Publish live' }).click();
  await page.getByRole('button', { name: 'Delete listing' }).waitFor();
  return { page, deletes };
}

test('delete: Confirm is disabled right after the first click (a double-click cannot delete), focus moves to Cancel, then it arms', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page, deletes } = await ready();
  try {
    await page.getByRole('button', { name: 'Delete listing' }).click();
    const confirm = page.getByRole('button', { name: 'Confirm delete' });
    await confirm.waitFor();
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
    // A second click at the same spot (double-click) must not complete the delete.
    await confirm.dispatchEvent('click');
    await page.mouse.dblclick((await confirm.boundingBox())!.x + 5, (await confirm.boundingBox())!.y + 5);
    assert.deepEqual(deletes, []);
    await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Confirm delete') as HTMLButtonElement).disabled, null, { timeout: 3000 });
    assert.equal(await confirm.isDisabled(), false);
    await confirm.click();
    await page.getByText('Listing deleted from Google Merchant.').waitFor();
    assert.equal(deletes.length, 1);
  } finally { await page.close(); }
});

test('delete: Cancel dismisses the pending confirmation', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page, deletes } = await ready();
  try {
    await page.getByRole('button', { name: 'Delete listing' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.getByRole('button', { name: 'Confirm delete' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Delete listing' }).count(), 1);
    assert.deepEqual(deletes, []);
  } finally { await page.close(); }
});

test('delete: clearing the token while a confirmation is pending dismisses it (and it does not come back when the token is retyped)', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page, deletes } = await ready();
  try {
    await page.getByRole('button', { name: 'Delete listing' }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).waitFor();
    await page.locator('#op-token').fill('');
    assert.equal(await page.getByText(/Press Confirm delete to continue/).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Cancel' }).count(), 0);
    await page.locator('#op-token').fill(TOKEN);
    assert.equal(await page.getByRole('button', { name: 'Confirm delete' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Delete listing' }).count(), 1);
    assert.deepEqual(deletes, []);
  } finally { await page.close(); }
});

test('delete: unchecking live while a confirmation is pending dismisses it', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page, deletes } = await ready();
  try {
    await page.getByRole('button', { name: 'Delete listing' }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).waitFor();
    await page.getByLabel(/Live publish to Google Merchant/).uncheck();
    assert.equal(await page.getByText(/Press Confirm delete to continue/).count(), 0);
    await page.getByLabel(/Live publish to Google Merchant/).check();
    await page.locator('#op-token').fill(TOKEN);
    assert.equal(await page.getByRole('button', { name: 'Confirm delete' }).count(), 0);
    assert.deepEqual(deletes, []);
  } finally { await page.close(); }
});
