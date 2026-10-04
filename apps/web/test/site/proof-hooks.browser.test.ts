// Drives the REAL useChainProof and useRevealOnce hooks in headless Chromium (bundled with esbuild, the RPC mocked with page.route).
// Skipped (loudly) only when no Chromium can be launched on this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { bundle } from './helpers/bundle.ts';

const ORIGIN = 'http://app.test';
let browser: Browser | null = null;
let script = '';

before(async () => {
  script = await bundle(`
    import { createElement as h, useRef, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { useChainProof } from './src/components/proof/useChainProof.ts';
    import { useRevealOnce } from './src/components/motion/useRevealOnce.ts';
    function Proof() {
      const ref = useRef(null);
      const [n, setN] = useState(0);
      // A NEW but equal input object on every render, as an inline literal would be.
      const proof = useChainProof(ref, { rpc: '${ORIGIN}/rpc', txs: [{ id: 1, hash: '0xaa', block: 1, gasUsed: '1', status: 'success' }], from: '0x1', to: '0x2' });
      return h('div', null,
        h('div', { style: { height: new URLSearchParams(location.search).get('gap') + 'px' } }),
        h('div', { ref, id: 'target' }, 'target'),
        h('button', { id: 'rerender', onClick: () => setN(n + 1) }, 'renders ' + n),
        h('button', { id: 'again', onClick: proof.check }, 'again'),
        h('output', { id: 'status' }, proof.status));
    }
    function Reveal() {
      const ref = useRef(null);
      const state = useRevealOnce(ref, 50);
      return h('div', null,
        h('div', { style: { height: '3000px' } }),
        h('div', { ref, id: 'tall', style: { height: '20000px' } }, 'tall block'),
        h('output', { id: 'reveal', style: { position: 'fixed', top: 0, left: 0 } }, state));
    }
    createRoot(document.getElementById('root')!).render(h(location.pathname === '/reveal' ? Reveal : Proof));
  `, 'iife', 'browser');
  try { browser = await chromium.launch(); } catch (e) { console.error('SKIP browser tests: chromium unavailable: ' + String(e).split('\n')[0]); }
});
after(async () => { await browser?.close(); });

async function open(path: string, opts: { reduced?: boolean } = {}): Promise<{ page: Page; posts: () => number }> {
  const page = await browser!.newPage();
  if (opts.reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
  let posts = 0;
  const html = '<!doctype html><body style="margin:0"><div id="root"></div><script>' + script.replace(/<\/script/g, '<\\/script') + '</script>';
  await page.route(ORIGIN + '/**', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/rpc') { posts++; return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await page.goto(ORIGIN + path);
  return { page, posts: () => posts };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('useChainProof: one request when the target is on screen; re-rendering with an equal inline input does not start another; no polling', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page, posts } = await open('/?gap=0');
  try {
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'done');
    assert.equal(posts(), 1);
    for (let i = 0; i < 3; i++) await page.click('#rerender');
    assert.equal(await page.textContent('#rerender'), 'renders 3');
    await pause(400);
    assert.equal(posts(), 1);
  } finally { await page.close(); }
});

test('useChainProof: nothing is sent while the target is far below the fold; scrolling near it sends exactly one request', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page, posts } = await open('/?gap=6000');
  try {
    await pause(500);
    assert.equal(posts(), 0);
    assert.equal(await page.textContent('#status'), 'idle');
    await page.evaluate(() => document.getElementById('target')!.scrollIntoView());
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'done');
    assert.equal(posts(), 1);
  } finally { await page.close(); }
});

test('useChainProof: Check again sends one more request and ends back at done', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page, posts } = await open('/?gap=0');
  try {
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'done');
    await page.click('#again');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'done');
    assert.equal(posts(), 2);
  } finally { await page.close(); }
});

test('useRevealOnce: a block taller than the viewport and starting below the fold arms, then reveals once it is reached', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page } = await open('/reveal');
  try {
    await page.waitForFunction(() => document.getElementById('reveal')?.textContent === 'armed');
    await page.evaluate(() => window.scrollTo(0, 3000));
    await page.waitForFunction(() => document.getElementById('reveal')?.textContent === 'done', null, { timeout: 3000 });
  } finally { await page.close(); }
});

test('useRevealOnce: with reduced motion the block is never armed', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const { page } = await open('/reveal', { reduced: true });
  try {
    await pause(300);
    assert.equal(await page.textContent('#reveal'), 'off');
  } finally { await page.close(); }
});
