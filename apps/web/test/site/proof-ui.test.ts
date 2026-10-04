// node --test test/site/proof-ui.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNodeModule } from './helpers/bundle.ts';

type Line = { tone: string; icon: string; text: string; state: string };
type Mod = {
  badgeLine(p: unknown, status: string): Line | null;
  summaryLine(r: unknown, status: string, total: number, chain: string): Line & { sub: string; again: boolean };
  pillLine(r: unknown, status: string): Line | null;
  mandateLine(m: unknown, status: string): Line | null;
  revealPlan(o: { reduced: boolean; hasIO: boolean; top: number; viewport: number; height?: number }): 'skip' | 'arm';
  elementRevealPlan(el: unknown, env: unknown): 'skip' | 'arm';
  render(name: string, props: unknown): string;
};
const mod = await loadNodeModule<Mod>(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { badgeLine, summaryLine, pillLine, mandateLine, ProofBadge, ProofSummary, ProofPill, MandateNow, VerifyList } from './src/components/proof/Proof.tsx';
  import { revealPlan, elementRevealPlan } from './src/components/motion/useRevealOnce.ts';
  export { badgeLine, summaryLine, pillLine, mandateLine, revealPlan, elementRevealPlan };
  const C = { ProofBadge, ProofSummary, ProofPill, MandateNow, VerifyList };
  export const render = (name, props) => renderToStaticMarkup(createElement(C[name], props));
`);
const CHAIN = 'Robinhood Chain Testnet';
const H = '0xdf9dbe6f13931a361018ddbeb6edf045d7266b70b9f7dd2489acb8b23008132a';
const tx = (over: Record<string, unknown> = {}) => ({ id: 14, hash: H, state: 'confirmed', block: 127660264, gasUsed: '213954', confirmations: 550165, diffs: [], ...over });
const counts = (over: Record<string, number> = {}) => ({ total: 9, confirmed: 8, reverted: 1, mismatch: 0, notFound: 0, unknown: 0, ...over });
const report = (over: Record<string, unknown> = {}) => ({ reachable: true, head: 128210428, checkedAt: Date.UTC(2026, 9, 3, 14, 54, 36), txs: [tx()], counts: counts(), mandate: null, ...over });
const down = () => report({ reachable: false, head: null, counts: counts({ confirmed: 0, reverted: 0, unknown: 9 }) });
const proof = (status: string, r: unknown = null) => ({ status, report: r, check: () => {} });
const F = (field: string, run: string, chain: string) => ({ field, run, chain });
const RPC = 'according to the public RPC';

test('badge: nothing before a check (without JavaScript only the links show), a neutral line while checking', () => {
  assert.equal(mod.badgeLine(tx(), 'idle'), null);
  assert.equal(mod.badgeLine(tx(), 'unavailable'), null);
  assert.equal(mod.badgeLine(undefined, 'done'), null);
  assert.deepEqual(mod.badgeLine(undefined, 'checking'), { tone: 'wait', icon: '…', text: 'Checking the chain…', state: 'checking' });
});

test('badge: confirmed and expected revert both read as a match, with block and confirmations, always "according to the public RPC"', () => {
  assert.equal(mod.badgeLine(tx(), 'done')!.text, `Confirmed on chain, ${RPC} · block 127,660,264 · 550,165 confirmations`);
  assert.equal(mod.badgeLine(tx({ confirmations: 1 }), 'done')!.text, `Confirmed on chain, ${RPC} · block 127,660,264 · 1 confirmation`);
  assert.equal(mod.badgeLine(tx({ confirmations: null }), 'done')!.text, `Confirmed on chain, ${RPC} · block 127,660,264`);
  const rv = mod.badgeLine(tx({ state: 'reverted' }), 'done')!;
  assert.deepEqual([rv.tone, rv.icon, rv.text], ['ok', '✓', `Reverted on chain, as in the run, ${RPC} · block 127,660,264 · 550,165 confirmations`]);
});

test('badge: a mismatch says plainly what differs, run value next to chain value', () => {
  const l = mod.badgeLine(tx({ state: 'mismatch', diffs: [F('gasUsed', '57198', '57200'), F('from', '0x3ec91b7dff57403ae298e503fae4f5815b4c1818', 'none')] }), 'done')!;
  assert.deepEqual([l.tone, l.icon], ['bad', '✕']);
  assert.equal(l.text, `Differs from the run, ${RPC}: gas used 57,198 in the run, 57,200 on chain; sender 0x3ec91b…1818 in the run, none on chain`);
});

test('badge: not-found is a problem; unknown is "not checked", never a failure', () => {
  assert.equal(mod.badgeLine(tx({ state: 'not-found' }), 'done')!.text, 'The public RPC has no receipt for this hash');
  const u = mod.badgeLine(tx({ state: 'unknown', reason: 'timeout' }), 'done')!;
  assert.deepEqual([u.tone, u.icon, u.text], ['na', '?', 'Not checked: the chain did not answer']);
  assert.doesNotMatch(u.text, /fail|invalid|wrong/i);
});

test('summary: honest copy for every state', () => {
  assert.equal(mod.summaryLine(null, 'unavailable', 9, CHAIN).text, 'This run is from a local chain, so there is no public chain to check it against.');
  const idle = mod.summaryLine(null, 'idle', 9, CHAIN);
  assert.deepEqual([idle.text, idle.sub, idle.again], ['These 9 transactions were sent to Robinhood Chain Testnet.', 'The links open the explorer; the check reads them from the public RPC.', false]);
  assert.equal(mod.summaryLine(null, 'checking', 9, CHAIN).text, 'Checking 9 transactions of this run against Robinhood Chain Testnet…');
  const all = mod.summaryLine(report(), 'done', 9, CHAIN);
  assert.deepEqual([all.text, all.tone, all.state], [`9 of 9 transactions match the chain, ${RPC}`, 'ok', 'match']);
  assert.equal(all.sub, 'Robinhood Chain Testnet · 8 succeeded and 1 reverted, as in the run · latest block 128,210,428 · checked at 14:54:36 UTC');
  const off = mod.summaryLine(down(), 'done', 9, CHAIN);
  assert.equal(off.text, 'Could not reach Robinhood Chain Testnet just now, so nothing was checked.');
  assert.equal(off.sub, 'That says nothing about the run itself: the explorer links still work.');
  assert.deepEqual([off.tone, off.again, off.state], ['na', true, 'unknown']);
  const one = mod.summaryLine(report({ counts: counts({ confirmed: 7, mismatch: 1 }) }), 'done', 9, CHAIN);
  assert.deepEqual([one.text, one.tone, one.state, one.sub], [`8 of 9 transactions match the chain, ${RPC}.`, 'bad', 'differs', '1 differs from the run · checked at 14:54:36 UTC']);
  const two = mod.summaryLine(report({ counts: counts({ confirmed: 5, mismatch: 2, notFound: 1 }) }), 'done', 9, CHAIN);
  assert.equal(two.sub, '2 differ from the run · 1 has no receipt on the public RPC · checked at 14:54:36 UTC');
  const part = mod.summaryLine(report({ counts: counts({ confirmed: 7, unknown: 1 }) }), 'done', 9, CHAIN);
  assert.deepEqual([part.tone, part.state, part.text, part.sub], ['na', 'partial', `8 of 9 transactions match the chain, ${RPC}. 1 could not be checked.`, 'The explorer links still work · checked at 14:54:36 UTC']);
  assert.doesNotMatch(part.text + part.sub, /differ/);
  const mixed = mod.summaryLine(report({ counts: counts({ confirmed: 6, mismatch: 1, unknown: 1 }) }), 'done', 9, CHAIN);
  assert.deepEqual([mixed.tone, mixed.state, mixed.sub], ['bad', 'differs', '1 differs from the run · 1 could not be checked right now · checked at 14:54:36 UTC']);
  assert.equal(mod.summaryLine(report({ counts: counts({ confirmed: 9, reverted: 0 }) }), 'done', 9, CHAIN).sub.split(' · ')[1], '9 succeeded, as in the run');
  assert.equal(mod.summaryLine(report({ head: null }), 'done', 9, CHAIN).sub, 'Robinhood Chain Testnet · 8 succeeded and 1 reverted, as in the run · checked at 14:54:36 UTC');
});

test('ProofSummary: a polite live region; Check again only after a check, still focusable while a re-check runs', () => {
  const idle = mod.render('ProofSummary', { proof: proof('idle'), total: 9, chain: CHAIN });
  assert.match(idle, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.doesNotMatch(idle, /<button/);
  assert.match(idle, /data-testid="proof-summary" data-state="idle"/);
  const done = mod.render('ProofSummary', { proof: proof('done', report()), total: 9, chain: CHAIN, id: 'proof' });
  assert.match(done, /id="proof"/);
  assert.match(done, /<button type="button" class="btn ghost pf-again">Check again<\/button>/);
  const again = mod.render('ProofSummary', { proof: proof('checking', report()), total: 9, chain: CHAIN });
  assert.match(again, /<button type="button" class="btn ghost pf-again" aria-disabled="true">Checking…<\/button>/);
  assert.doesNotMatch(again, / disabled=""/);
  assert.doesNotMatch(mod.render('ProofSummary', { proof: proof('checking'), total: 9, chain: CHAIN }), /<button/);
});

test('pill and mandate lines', () => {
  assert.equal(mod.pillLine(null, 'idle'), null);
  assert.equal(mod.pillLine(null, 'unavailable'), null);
  assert.equal(mod.pillLine(null, 'checking')!.text, 'Checking the chain');
  assert.equal(mod.pillLine(report(), 'done')!.text, '9/9 on chain (public RPC)');
  assert.equal(mod.pillLine(down(), 'done')!.text, 'Chain not reachable');
  assert.equal(mod.pillLine(report({ counts: counts({ confirmed: 7, mismatch: 1 }) }), 'done')!.text, '8/9 match the chain (public RPC)');
  assert.match(mod.render('ProofPill', { proof: proof('done', report()) }), /data-testid="proof-pill"/);
  assert.match(mod.render('ProofPill', { proof: proof('done', report()) }), /title="Each transaction of this run is read from the public RPC and compared with the run"/);
  assert.equal(mod.render('ProofPill', { proof: proof('idle') }), '');
  const same = { state: 'same', fields: [F('maxExec', '250000', '250000'), F('dailySpendCap', '500000', '500000'), F('minMarginBps', '1800', '1800'), F('quoteTTL', '180', '180')] };
  assert.equal(mod.mandateLine(same, 'done')!.text, `On chain now, ${RPC}: the same four limits as in the run.`);
  const changed = { state: 'changed', fields: [F('maxExec', '250000', '300000'), F('dailySpendCap', '500000', '500000'), F('minMarginBps', '1800', '2000'), F('quoteTTL', '180', '180')] };
  assert.equal(mod.mandateLine(changed, 'done')!.text, `The owner has changed the mandate since the run, ${RPC}: per-run cap $2,500.00 in the run, $3,000.00 now; margin floor 18% in the run, 20% now.`);
  assert.equal(mod.mandateLine({ state: 'unknown', fields: [] }, 'done'), null);
  assert.equal(mod.mandateLine(same, 'checking'), null);
  assert.equal(mod.mandateLine(null, 'done'), null);
  assert.match(mod.render('MandateNow', { mandate: same, status: 'done' }), /data-testid="mandate-now" data-state="same"/);
});

test('VerifyList: addresses and transactions open the explorer in a new tab, with a spoken hint; badges only after a check', () => {
  const html = mod.render('VerifyList', { proof: proof('idle'), txs: [{ id: 14, title: 'commitOpportunity: contract re-derives economics and accepts', hash: H }], addresses: [{ label: 'Vault contract (SKUdeskCore)', address: '0xa452161B75b7B79B3021639b73C0F5E3A529a1bb' }] });
  const hid = /<h3 id="([^"]+)">Verify it yourself<\/h3>/.exec(html)?.[1];
  assert.ok(hid, 'heading has an id');
  assert.match(html, new RegExp('aria-labelledby="' + hid + '"'));
  assert.match(html, /<ol class="pf-txs" role="list">/);
  assert.match(html, /Each link opens the public block explorer in a new tab\. The explorer does not depend on this website\./);
  assert.doesNotMatch(html, /Nothing in this list/);
  assert.match(html, /href="https:\/\/explorer\.testnet\.chain\.robinhood\.com\/address\/0xa452161B75b7B79B3021639b73C0F5E3A529a1bb" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, new RegExp('href="https://explorer\\.testnet\\.chain\\.robinhood\\.com/tx/' + H + '"'));
  assert.equal((html.match(/opens the block explorer in a new tab/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-testid="proof-badge"/);
  const done = mod.render('VerifyList', { proof: proof('done', report()), txs: [{ id: 14, title: 't', hash: H }], addresses: [] });
  assert.match(done, /data-testid="proof-badge" data-proof="confirmed"/);
  const other = mod.render('VerifyList', { proof: proof('idle'), txs: [], addresses: [] });
  assert.notEqual(/<h3 id="([^"]+)"/.exec(other)?.[1], undefined);
});

test('layout is reserved: a badge slot in every transaction row', () => {
  const idle = mod.render('VerifyList', { proof: proof('idle'), txs: [{ id: 14, title: 't', hash: H }], addresses: [] });
  assert.match(idle, /<span class="pf-slot"><\/span>/);
  const done = mod.render('VerifyList', { proof: proof('done', report()), txs: [{ id: 14, title: 't', hash: H }], addresses: [] });
  assert.match(done, /<span class="pf-slot"><span class="pf-badge ok"/);
});

test('ProofPill reuses the global pill tones (good / warn / bad), not its own colours', () => {
  assert.match(mod.render('ProofPill', { proof: proof('done', report()) }), /class="pill pf-pill hide-sm good"/);
  assert.match(mod.render('ProofPill', { proof: proof('done', down()) }), /class="pill pf-pill hide-sm warn"/);
  assert.match(mod.render('ProofPill', { proof: proof('done', report({ counts: counts({ confirmed: 7, mismatch: 1 }) })) }), /class="pill pf-pill hide-sm bad"/);
  assert.match(mod.render('ProofPill', { proof: proof('checking') }), /class="pill pf-pill hide-sm"/);
});

test('no proof copy, in any state, uses an owner-rule word, "replay" or "live"; no absolute "verified/proven by the chain"', () => {
  const lines: (Line & { sub?: string })[] = [];
  for (const s of ['idle', 'checking', 'done', 'unavailable']) {
    for (const t of [tx(), tx({ state: 'reverted' }), tx({ state: 'unknown' }), tx({ state: 'not-found' }), tx({ state: 'mismatch', diffs: [F('block', '1', '2')] })]) { const l = mod.badgeLine(t, s); if (l) lines.push(l); }
    lines.push(mod.summaryLine(report(), s, 9, CHAIN), mod.summaryLine(down(), s, 9, CHAIN));
    const p = mod.pillLine(report(), s); if (p) lines.push(p);
  }
  const m = mod.mandateLine({ state: 'same', fields: [] }, 'done'); if (m) lines.push(m);
  for (const l of lines) {
    const all = l.text + ' ' + (l.sub ?? '');
    assert.doesNotMatch(all, /\b(recorded|recording|demo|simulated|sample|mock|replay|live)\b/i, l.text);
    assert.doesNotMatch(all, /\b(verified|proven|proof) by the (chain|blockchain)\b/i, l.text);
  }
});

test('every claim that the chain agrees with the run names the public RPC', () => {
  for (const l of [mod.badgeLine(tx(), 'done'), mod.badgeLine(tx({ state: 'reverted' }), 'done'), mod.badgeLine(tx({ state: 'mismatch', diffs: [F('block', '1', '2')] }), 'done'), mod.summaryLine(report(), 'done', 9, CHAIN), mod.summaryLine(report({ counts: counts({ confirmed: 7, mismatch: 1 }) }), 'done', 9, CHAIN), mod.pillLine(report(), 'done'), mod.mandateLine({ state: 'same', fields: [] }, 'done')]) {
    assert.match(l!.text, /public RPC/, l!.text);
  }
});

test('revealPlan: animate only when the block starts below the fold, motion is allowed and IntersectionObserver exists', () => {
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 1200, viewport: 800 }), 'arm');
  // the boundary is 1.1 x the viewport (see the next test); 800 on an 800px viewport used to arm and no longer does
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 900, viewport: 800 }), 'arm');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 800, viewport: 800 }), 'skip');
  assert.equal(mod.revealPlan({ reduced: true, hasIO: true, top: 1200, viewport: 800 }), 'skip');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: false, top: 1200, viewport: 800 }), 'skip');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 300, viewport: 800 }), 'skip');
});

test('revealPlan: a block shorter than ~10% of the viewport could never meet the -10% bottom edge at the end of a page, so it is not armed', () => {
  // useRevealOnce observes with rootMargin '0px 0px -10% 0px'. The viewport is 800 here, so the bottom 80px never count.
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 1200, viewport: 800, height: 60 }), 'skip');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 1200, viewport: 800, height: 159 }), 'skip');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 1200, viewport: 800, height: 160 }), 'arm');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 1200, viewport: 800, height: 5000 }), 'arm');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 1200, viewport: 800 }), 'arm', 'height is optional');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 100, viewport: 800, height: 5000 }), 'skip', 'already on screen');
});

test('revealPlan: a block whose top is inside the 10% bottom margin is not armed (it would sit half-hidden while on screen)', () => {
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 1.05 * 800, viewport: 800 }), 'skip');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 1.2 * 800, viewport: 800 }), 'arm');
  assert.equal(mod.revealPlan({ reduced: false, hasIO: true, top: 799, viewport: 800 }), 'skip');
});

test('revealPlan: an unusable height (0, NaN, negative, or a 0-height viewport) skips; no height at all skips nothing', () => {
  const base = { reduced: false, hasIO: true, top: 5000, viewport: 800 };
  for (const h of [0, NaN, -5, Infinity * 0]) assert.equal(mod.revealPlan({ ...base, height: h }), 'skip', String(h));
  assert.equal(mod.revealPlan({ ...base, viewport: 0, height: 500, top: 5000 }), 'arm', 'a 0 viewport has no minimum');
  assert.equal(mod.revealPlan({ ...base, viewport: 0, height: 0, top: 5000 }), 'arm', '0 >= 0');
  assert.equal(mod.revealPlan({ ...base, viewport: NaN, height: 500 }), 'skip', 'NaN viewport');
  assert.equal(mod.revealPlan(base), 'arm');
});

test('elementRevealPlan (what the hook calls) reads the element height, the viewport, motion and IntersectionObserver', () => {
  const el = (top: number, height: number) => ({ getBoundingClientRect: () => ({ top, height }) });
  const env = (o: Record<string, unknown> = {}) => ({ innerHeight: 800, hasIO: true, reducedMotion: () => false, ...o });
  assert.equal(mod.elementRevealPlan(el(2000, 1000), env()), 'arm');
  assert.equal(mod.elementRevealPlan(el(2000, 40), env()), 'skip', 'too short: the height is passed on');
  assert.equal(mod.elementRevealPlan(el(2000, 0), env()), 'skip');
  assert.equal(mod.elementRevealPlan(el(500, 1000), env()), 'skip', 'on screen');
  assert.equal(mod.elementRevealPlan(el(2000, 1000), env({ reducedMotion: () => true })), 'skip');
  assert.equal(mod.elementRevealPlan(el(2000, 1000), env({ hasIO: false })), 'skip');
});
