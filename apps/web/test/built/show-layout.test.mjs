// The built /show page in real Chromium: the evidence is near the top and the explorer links are touch-sized.
// Serves dist/ from a fake origin (no network; the chain RPC is refused, so the check ends "could not check", which does not move the layout).
// Skipped loudly when dist/ is missing or no Chromium can be launched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const ORIGIN = 'http://app.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let browser = null;

before(async () => {
  if (!existsSync(DIST + 'show/index.html')) return console.error('SKIP show-layout: dist/show/index.html missing (run npm run build)');
  try { browser = await chromium.launch(); } catch (e) { console.error('SKIP show-layout: chromium unavailable: ' + String(e).split('\n')[0]); }
});
after(async () => { await browser?.close(); });

async function open(viewport, hasTouch) {
  const page = await browser.newPage({ viewport, hasTouch, isMobile: hasTouch });
  await page.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.origin !== ORIGIN) return r.abort();
    let f = normalize(join(DIST, decodeURIComponent(u.pathname)));
    if (!f.startsWith(DIST)) return r.abort();
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) return r.fulfill({ status: 404, body: 'not found' });
    return r.fulfill({ status: 200, contentType: TYPES[extname(f)] ?? 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto(ORIGIN + '/show/');
  await page.waitForSelector('[data-testid="verify-list"]');
  await page.waitForTimeout(400);
  return page;
}

test('/show at 1280x900: the Realized profit card and the proof summary start within the first 800 px', async (t) => {
  if (!browser) return t.skip('no browser or no dist');
  const page = await open({ width: 1280, height: 900 }, false);
  try {
    const top = await page.$eval('#final', (e) => e.getBoundingClientRect().top + window.scrollY);
    const sum = await page.$eval('[data-testid="proof-summary"]', (e) => e.getBoundingClientRect().top + window.scrollY);
    const verify = await page.$eval('[data-testid="verify-list"]', (e) => e.getBoundingClientRect().top + window.scrollY);
    console.log(`1280x900: #final top ${Math.round(top)} px, proof summary top ${Math.round(sum)} px, verify list top ${Math.round(verify)} px`);
    assert.ok(top < 800, '#final top ' + top);
    assert.ok(sum < 800, 'proof summary top ' + sum);
  } finally { await page.close(); }
});

test('/show on a 390 px touch screen: every explorer link in the verify list has a 44 px hit area and the page does not scroll sideways', async (t) => {
  if (!browser) return t.skip('no browser or no dist');
  const page = await open({ width: 390, height: 844 }, true);
  try {
    const hs = await page.$$eval('[data-testid="verify-list"] a.pf-link', (as) => as.map((a) => a.getBoundingClientRect().height));
    assert.equal(hs.length, 12);
    for (const h of hs) assert.ok(h >= 43.5, 'link height ' + h);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
    const top = await page.$eval('#final', (e) => e.getBoundingClientRect().top + window.scrollY);
    console.log(`390x844: #final top ${Math.round(top)} px`);
  } finally { await page.close(); }
});
