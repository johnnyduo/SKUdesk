import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintCopy } from './lib/copy-lint-core.mjs';

const page = (body) => `<html><body>${body}</body></html>`;
const GOOD = 'Robinize trades identical products. Starting with phone cases. A lot settled in test tokens on Robinhood Chain testnet. Prices shown are a fixed snapshot until live feeds are connected.';

test('a short, honest page passes', () => {
  const r = lintCopy(page(`<p>${GOOD}</p>`));
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('banned words fail, case-insensitively', () => {
  for (const bad of ['Sample data', 'DEMO mode', 'a recorded run', 'Simulated prices', 'test fixtures', 'a Uniswap hook', 'USDG swap', 'LOT-1842', 'OP-2041', 'zero trust', 'autonomous agent']) {
    const r = lintCopy(page(`<p>${GOOD} ${bad}</p>`));
    assert.equal(r.ok, false, `should reject: ${bad}`);
  }
});

test('"simulated" and "recorded" are banned everywhere', () => {
  assert.equal(lintCopy(page(`<p>${GOOD}</p>`)).ok, true);
  assert.equal(lintCopy(page(`<p>${GOOD} All prices are simulated.</p>`)).ok, false);
});

test('required phrases must appear outside the product cards', () => {
  assert.equal(lintCopy(page('<p>Robinize trades products. Starting with phone cases.</p><article class="sc-card"><p>Identical match</p></article>')).ok, false);
  assert.equal(lintCopy(page('<h2>Fine heading</h2><p>' + GOOD + '</p>')).ok, true);
});

test('headings over 10 words fail', () => {
  assert.equal(lintCopy(page(`<h2>${Array.from({ length: 11 }, () => 'word').join(' ')}</h2><p>${GOOD}</p>`)).ok, false);
});

test('missing required phrases fail', () => {
  assert.equal(lintCopy(page('<p>Robinize trades products. Starting with phone cases.</p>')).ok, false);
  assert.equal(lintCopy(page('<p>Robinize trades identical products.</p>')).ok, false);
});

test('scripts, styles and svg text are ignored', () => {
  const r = lintCopy(page(`<p>${GOOD}</p><script>const demo = 1</script><style>.sample{}</style><svg><text>mock</text></svg>`));
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('word budget excludes product cards but banned words in cards still fail', () => {
  const long = Array.from({ length: 400 }, (_, i) => 'w' + i).join(' ');
  const cards = `<article class="sc-card"><p>${long}</p></article>`;
  assert.equal(lintCopy(page(`<p>${GOOD}</p>${cards}`)).ok, true);
  const over = lintCopy(page(`<p>${GOOD} ${long}</p>`));
  assert.equal(over.ok, false);
  assert.ok(over.words > 250);
  assert.equal(lintCopy(page(`<p>${GOOD}</p><article class="sc-card"><p>mock</p></article>`)).ok, false);
});

test('the meta description is scanned for banned strings', () => {
  const head = (d) => `<html><head><meta name="description" content="${d}"/></head><body><p>${GOOD}</p></body></html>`;
  assert.equal(lintCopy(head('Robinize trades identical products. Testnet demo.')).ok, false);
  assert.equal(lintCopy(head('Robinize trades identical products. Starting with phone cases.')).ok, true);
  assert.equal(lintCopy(head('A &quot;sample&quot; page')).ok, false);
});

test('the footer disclosure must be present (it is the only disclosure that example tiles are not live prices)', () => {
  const NO_FOOTER = 'Robinize trades identical products. Starting with phone cases.';
  const r = lintCopy(page(`<p>${NO_FOOTER}</p>`));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /footer/i.test(p)), r.problems.join('; '));
  assert.equal(lintCopy(page(`<p>${GOOD}</p>`)).ok, true);
});

test('the testnet disclosures (a test token, Robinhood Chain testnet) must stay on the page', () => {
  const base = 'Robinize trades identical products. Starting with phone cases. Prices shown are a fixed snapshot until live feeds are connected.';
  for (const [drop, text] of [['test token', `${base} Robinhood Chain testnet.`], ['robinhood chain testnet', `${base} Settled in test tokens.`]]) {
    const r = lintCopy(page(`<p>${text}</p>`));
    assert.equal(r.ok, false, drop);
    assert.ok(r.problems.some((p) => p.includes(drop)), r.problems.join('; '));
  }
  assert.equal(lintCopy(page(`<p>${GOOD}</p>`)).ok, true);
});

test('USDG is allowed only as mUSDG or test USDG', () => {
  assert.equal(lintCopy(page(`<p>${GOOD} Settled in mUSDG, a test token.</p>`)).ok, true);
  assert.equal(lintCopy(page(`<p>${GOOD} Paid in test USDG.</p>`)).ok, true);
  assert.equal(lintCopy(page(`<p>${GOOD} Paid in USDG.</p>`)).ok, false);
  assert.equal(lintCopy(page(`<p>${GOOD} A USDG swap.</p>`)).ok, false);
});

test('the footer is outside the word budget, but banned words are still caught inside it', () => {
  const long = Array.from({ length: 300 }, () => 'link').join(' ');
  assert.equal(lintCopy(page(`<p>${GOOD}</p><footer>${long}</footer>`)).ok, true);
  assert.equal(lintCopy(page(`<p>${GOOD}</p><footer>a demo link</footer>`)).ok, false);
  assert.equal(lintCopy(page(`<p>${GOOD} ${long}</p>`)).ok, false);
});
