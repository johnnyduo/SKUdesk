// Drives the REAL /show Player in headless Chromium: Walk through -> Pause -> Step to the end -> Back to start.
// The page is served from a fake origin and the RPC is a stub that answers the run's own batch (no network).
// Skipped (loudly) only when no Chromium can be launched on this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { bundle, loadNodeModule } from './helpers/bundle.ts';

const ORIGIN = 'http://app.test';
let browser: Browser | null = null;
let script = '';
let answer: (calls: { id: number; method: string }[]) => unknown[] = () => [];

before(async () => {
  script = await bundle(`
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import Player from './src/components/show/Player.tsx';
    createRoot(document.getElementById('root')!).render(h(Player));
  `, 'iife', 'browser');
  const m = await loadNodeModule<{ input: { rpc: string; txs: { hash: string; block: number; gasUsed: string; status: string }[]; from: string; to: string; mandate: { policy: Record<string, string> } }; fields: string[]; rpc: string; stepCount: number }>(`
    import { RUN_PROOF_INPUT as input } from './src/components/proof/useChainProof.ts';
    import { MANDATE_FIELDS as fields } from './src/lib/chain-proof.ts';
    import { buildScript, run } from './src/components/show/lib.ts';
    export { input, fields };
    export const rpc = input.rpc;
    export const stepCount = buildScript(run).length;
  `);
  // counts come from the run itself, so a fresh agent run does not break this test
  STEPS = m.stepCount;
  MATCH = `${m.input.txs.length} of ${m.input.txs.length} transactions match the chain, according to the public RPC`;
  const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
  answer = (calls) => calls.map((c) => {
    if (c.id === 1) return { jsonrpc: '2.0', id: 1, result: hex(999_999_999) };
    const i = c.id - 2;
    if (i < m.input.txs.length) {
      const t = m.input.txs[i];
      return { jsonrpc: '2.0', id: c.id, result: { status: t.status === 'success' ? '0x1' : '0x0', blockNumber: hex(t.block), gasUsed: hex(BigInt(t.gasUsed)), transactionHash: t.hash, from: m.input.from, to: m.input.to } };
    }
    const f = m.fields[i - m.input.txs.length];
    return { jsonrpc: '2.0', id: c.id, result: '0x' + BigInt(m.input.mandate.policy[f]).toString(16).padStart(64, '0') };
  });
  RPC_URL = m.rpc;
  try { browser = await chromium.launch(); } catch (e) { console.error('SKIP browser tests: chromium unavailable: ' + String(e).split('\n')[0]); }
});
let RPC_URL = '';
after(async () => { await browser?.close(); });

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(3000); // every state here is reached in well under a second; a missing one should fail fast
  const html = '<!doctype html><body style="margin:0"><div id="root"></div><script>' + script.replace(/<\/script/g, '<\\/script') + '</script>';
  // Everything is fulfilled locally: the fake origin serves the page, the real RPC address gets the stub, anything else is refused.
  await page.route('**/*', (r) => {
    const url = r.request().url();
    if (url.startsWith(ORIGIN)) return r.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url === RPC_URL || url.startsWith(RPC_URL)) {
      const calls = JSON.parse(r.request().postData() ?? '[]');
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer(calls)) });
    }
    return r.abort();
  });
  await page.goto(ORIGIN + '/show');
  return page;
}

// Visible text outside the allowed contract vocabulary (the "No replay" gate, the contract's Replay error and its "Replay blocked." message,
// "replays and stale-dated quotes"). Anything else, such as a Replay button or pill, is left over and fails the test.
const replayLeft = (text: string) => text
  .replace(/No replay/gi, '').replace(/Replay blocked\./g, '').replace(/Replay(?=This exact opportunity)/g, '').replace(/replays and stale-dated quotes/gi, '').replace(/the same opportunity/gi, '')
  .match(/.{0,40}replay.{0,40}/gi) ?? [];

// Direct DOM clicks: no actionability waits, no scrolling, no animation settling. The controls are plain buttons, so a dispatched click is what a real one does.
const press = (loc: ReturnType<Page['locator']>) => loc.dispatchEvent('click');
let MATCH = '';
let STEPS = 0;

test('/show: Walk through -> Pause -> Step to the end -> Back to start returns to the opening view; no replay control; the stub RPC gives a real "match" proof', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const page = await open();
  try {
    const main = page.locator('button.btn').first();
    const mandateNow = page.locator('[data-testid="mandate-now"]');
    const summary = page.locator('[data-testid="proof-summary"]');
    // the stub RPC answers the run's own batch: wait for the REAL ok state, not just "not idle"
    await page.waitForFunction(() => document.querySelector('[data-testid="proof-summary"]')?.getAttribute('data-state') === 'match', undefined, { timeout: 5000 });
    assert.match((await summary.locator('.pf-sum-head').textContent())!, new RegExp(MATCH));
    assert.equal(await mandateNow.getAttribute('data-state'), 'same');
    // opening view: the finished result and the evidence, a walkthrough button, a progress text
    assert.equal(await main.getAttribute('aria-label'), 'Walk through the run');
    assert.equal(await page.textContent('.sh-prog'), `${STEPS} events`);
    assert.equal(await page.locator('#final').isVisible(), true);
    assert.deepEqual(replayLeft(await page.innerText('body')), []);
    assert.equal(await mandateNow.count(), 1, 'opening view: the mandate line renders exactly once');
    assert.equal(await page.locator('.sh-card .pill:text-is("read from chain")').count(), 0);

    await press(main);
    assert.equal(await main.getAttribute('aria-label'), 'Pause');
    await press(main);
    assert.equal(await main.getAttribute('aria-label'), 'Resume');
    assert.equal(await mandateNow.count(), 1, 'mid-walkthrough (paused): the mandate line renders exactly once');
    assert.equal(await page.locator('[aria-label="On-chain mandate"] h3 .pill').first().textContent(), 'set by the owner');

    const step = page.getByRole('button', { name: 'Step to the next event' });
    for (let i = 0; i < STEPS + 10 && (await main.getAttribute('aria-label')) !== 'Back to start'; i++) await press(step);
    assert.equal(await main.getAttribute('aria-label'), 'Back to start');
    assert.equal(await page.textContent('.sh-prog'), `${STEPS}/${STEPS}`);
    assert.equal(await page.locator('#final').isVisible(), true);
    assert.equal(await mandateNow.count(), 1, 'done state: the mandate line renders exactly once');
    assert.deepEqual(replayLeft(await page.innerText('body')), []);

    await press(main);
    assert.equal(await main.getAttribute('aria-label'), 'Walk through the run');
    assert.equal(await page.textContent('.sh-prog'), `${STEPS} events`);
    assert.equal(await page.locator('#final').isVisible(), true);
    assert.equal(await mandateNow.count(), 1, 'back at the start: the mandate line renders exactly once');
    assert.deepEqual(replayLeft(await page.innerText('body')), []);
  } finally { await page.close(); }
});

test('/show: the connection diagram is closed on the opening view, opens when the walkthrough starts, then stays as the visitor leaves it', async (t) => {
  if (!browser) return t.skip('chromium unavailable');
  const page = await open();
  try {
    const open = () => page.$eval('details.sh-map', (d) => (d as HTMLDetailsElement).open);
    assert.equal(await open(), false);
    const main = page.locator('button.btn').first();
    await main.click();
    assert.equal(await open(), true);
    await page.click('details.sh-map > summary'); // the visitor closes it mid-walkthrough
    assert.equal(await open(), false);
    await page.getByRole('button', { name: 'Step to the next event' }).click();
    assert.equal(await open(), false, 'a later step does not reopen what the visitor closed');
  } finally { await page.close(); }
});
