// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test src/lib/market-view.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyReadError, isSettled, loadFailed, pickDefaultMarket, settleSelection, dataSource, refSourceKind, walletLetter, agentLabel, bondTokens, statusWord, bondNote, agentCards, priceSourceLine, PRICE_SCOPE, walletLabel, shortAddr } from './market-view.ts';
import type { AgentRegistry } from './agents.ts';

test('the scope line says test units, not retail, not the v4 pool', () => {
  assert.match(PRICE_SCOPE, /test units/); assert.match(PRICE_SCOPE, /Not a retail price/); assert.match(PRICE_SCOPE, /Uniswap v4 pool/);
  assert.doesNotMatch(PRICE_SCOPE, /USDC|USDG|demo|sample|mock|judge/i);
});

test('dataSource: no chip while loading, ONCHAIN when connected, FIXED SNAPSHOT when the RPC is lost', () => {
  assert.equal(dataSource({ ready: false }), null);
  assert.deepEqual(dataSource({ ready: true }), { kind: 'onchain', note: undefined, history: undefined });
  const a = dataSource({ ready: true, snapshotHead: 128030547 })!;
  assert.equal(a.kind, 'onchain'); assert.match(a.history!, /up to block 128,030,547/);
  const b = dataSource({ ready: true, error: 'timeout', snapshotHead: 5 })!;
  assert.equal(b.kind, 'snapshot'); assert.equal(b.note, 'RPC lost');
});

test('catalog source maps to FIXED SNAPSHOT or TEST DATA', () => {
  assert.equal(refSourceKind('snapshot'), 'snapshot'); assert.equal(refSourceKind('catalog'), 'test'); assert.equal(refSourceKind('anything'), 'test');
});

test('wallet letters run A..Z then AA, AB', () => {
  assert.equal(walletLetter(0), 'A'); assert.equal(walletLetter(25), 'Z'); assert.equal(walletLetter(26), 'AA'); assert.equal(walletLetter(27), 'AB'); assert.equal(walletLetter(51), 'AZ'); assert.equal(walletLetter(52), 'BA');
  assert.equal(agentLabel('0xBEEF', ['0xaaaa', '0xbeef']), 'Agent B'); assert.equal(agentLabel('0xcccc', ['0xaaaa']), 'Agent ?');
});

test('bond is formatted from 6-decimal token units', () => {
  assert.equal(bondTokens(2_000_000), '2.00'); assert.equal(bondTokens(1_500_000), '1.50'); assert.equal(bondTokens(0), '0.00');
});

test('status wording is committed / revealed / matched / not matched', () => {
  assert.deepEqual((['sealed', 'revealed', 'filled', 'partial', 'unmatched', 'forfeited'] as const).map(statusWord), ['committed', 'revealed', 'matched', 'matched', 'not matched', 'not matched']);
  assert.equal(bondNote('sealed', 2_000_000), 'bond locked 2.00 mUSDG');
  assert.equal(bondNote('forfeited', 2_000_000), 'bond forfeited 2.00 mUSDG');
  assert.equal(bondNote('filled', 2_000_000), 'bond returned at reveal');
  assert.equal(bondNote('sealed', 0), 'bond locked');
});

test('agentCards: one card per wallet, ordered by first-seen wallet, hidden fields stay hidden', () => {
  const traders = ['0xaa', '0xbb', '0xcc'];
  const cards = agentCards([
    { index: 0, trader: '0xBB', state: 'sealed' },
    { index: 1, trader: '0xAA', state: 'filled', side: 0, price: 1100, units: 5, filled: 5 },
    { index: 2, trader: '0xcc', state: 'forfeited' },
    { index: 3, trader: '0xaa', state: 'unmatched', side: 1, price: 1200, units: 3, filled: 0 },
  ], traders, 2_000_000);
  assert.deepEqual(cards.map((c) => c.label), ['Agent A', 'Agent B', 'Agent C']);
  assert.equal(cards[0].orders.length, 2);
  assert.equal(cards[0].orders[0].word, 'matched'); assert.equal(cards[0].orders[1].word, 'not matched');
  assert.equal(cards[1].orders[0].price, undefined); assert.equal(cards[1].orders[0].word, 'committed'); assert.equal(cards[1].orders[0].bond, 'bond locked 2.00 mUSDG');
  assert.equal(cards[2].orders[0].bond, 'bond forfeited 2.00 mUSDG');
  assert.deepEqual(agentCards([], traders, 0), []);
});

// keeper-bot registry names (the registry file itself is tested in test/market/agents.test.ts)
const BOT = '0x269afaf16c8d2d31c30dca433b8c1495028dbb6f';
const BOTS: AgentRegistry = { note: 'scripted bots', derivedAt: '2026-10-03', bots: [{ address: BOT, name: 'Bot 1', keeperIndex: 0, side: 'buy', role: 'buys, limit 0.2-0.6% under the reference', units: [8, 24] }] };

test('walletLabel: a registry bot is "Bot N" with its role (any letter case); every other wallet keeps its first-seen letter', () => {
  const traders = [BOT, '0x00000000000000000000000000000000000000aa'];
  assert.deepEqual(walletLabel(BOT.toUpperCase().replace('0X', '0x'), traders, BOTS), { address: BOT, name: 'Bot 1', short: '0x269a…bb6f', bot: true, role: 'buys, limit 0.2-0.6% under the reference' });
  assert.deepEqual(walletLabel('0x00000000000000000000000000000000000000AA', traders, BOTS), { address: '0x00000000000000000000000000000000000000aa', name: 'Agent A', short: '0x0000…00aa', bot: false });
  assert.equal(walletLabel(BOT, traders).name, 'Agent A', 'without the registry the letter rule applies to every wallet');
  assert.equal(walletLabel('0x' + 'f'.repeat(40), traders, BOTS).name, 'Agent ?');
  // letters count non-registry wallets only: six bots first in `traders` must not push the first other wallet to "Agent G"
  const six = Array.from({ length: 6 }, (_, i) => '0x' + String(i + 1).repeat(40));
  const many: AgentRegistry = { ...BOTS, bots: six.map((address, i) => ({ ...BOTS.bots[0], address, name: `Bot ${i + 1}` })) };
  const wallets = [...six.slice(0, 3), '0x' + 'a'.repeat(40), ...six.slice(3), '0x' + 'b'.repeat(40)];
  assert.equal(walletLabel('0x' + 'a'.repeat(40), wallets, many).name, 'Agent A');
  assert.equal(walletLabel('0x' + 'b'.repeat(40), wallets, many).name, 'Agent B');
  assert.equal(agentLabel('0x' + 'b'.repeat(40), wallets, many), 'Agent B'); assert.equal(agentLabel('0x' + 'b'.repeat(40), wallets), 'Agent H');
  assert.equal(shortAddr('0xabc'), '0xabc');
});

test('agentCards with the registry: bots carry name and role, other wallets keep main\'s letter; order and orders unchanged', () => {
  const traders = ['0xaa', BOT];
  const chips = [{ index: 0, trader: BOT, state: 'sealed' as const }, { index: 1, trader: '0xAA', state: 'sealed' as const }];
  const cards = agentCards(chips, traders, 2_000_000, BOTS);
  assert.deepEqual(cards.map((c) => [c.label, c.bot, c.role]), [['Agent A', false, undefined], ['Bot 1', true, 'buys, limit 0.2-0.6% under the reference']]);
  assert.deepEqual(agentCards(chips, traders, 2_000_000).map((c) => c.label), ['Agent A', 'Agent B']);
});

test('loadFailed: only an error with nothing loaded at all (then panels keep skeletons instead of "no trade yet")', () => {
  const none = { markets: [{ last: 0 }, { last: 0 }], clears: {} };
  assert.equal(loadFailed({ ...none, error: 'timeout' }), true);
  assert.equal(loadFailed(none), false, 'no error: an empty market really has no trade yet');
  assert.equal(loadFailed({ ...none, error: 'x', clears: { m: [] } }), false, 'some history loaded: show it, stale banner on top');
  assert.equal(loadFailed({ markets: [{ last: 1099 }], clears: {}, error: 'x' }), false);
});

const MK = (lasts: number[]) => lasts.map((last, i) => ({ symbol: 'S' + i, last }));
test('pickDefaultMarket: a valid #hash symbol always wins, else the first market with a last price, else index 0', () => {
  assert.equal(pickDefaultMarket(MK([0, 0, 500, 700]), 'S3'), 3, 'explicit hash beats a traded market');
  assert.equal(pickDefaultMarket(MK([0, 0, 500, 700]), 'S1'), 1, 'explicit hash on an untraded market is kept');
  assert.equal(pickDefaultMarket(MK([0, 0, 500, 700]), ''), 2, 'first in catalog order that cleared');
  assert.equal(pickDefaultMarket(MK([0, 0, 500, 700]), 'NOPE'), 2, 'an unknown hash is no choice');
  assert.equal(pickDefaultMarket(MK([300, 0, 500]), ''), 0);
  assert.equal(pickDefaultMarket(MK([0, 0]), ''), 0, 'nothing traded: index 0');
  assert.equal(pickDefaultMarket([], ''), 0);
});

test('settleSelection: decides once on the first ready state with a traded market, never flips later, waits while nothing traded', () => {
  const open = { index: 0, locked: false };
  assert.deepEqual(settleSelection(open, MK([0, 0, 500]), false), open, 'not ready: no decision');
  assert.deepEqual(settleSelection(open, MK([0, 0, 500]), true), { index: 2, locked: true }, 'first ready state with a clear');
  assert.deepEqual(settleSelection(open, MK([0, 0, 0]), true), open, 'ready but nothing traded: stay on 0, decide later');
  const later = settleSelection(open, MK([0, 0, 0]), true);
  assert.deepEqual(settleSelection(later, MK([0, 400, 500]), true), { index: 1, locked: true }, 'data arrives later, user has not chosen');
  const locked = { index: 2, locked: true };
  assert.deepEqual(settleSelection(locked, MK([100, 400, 500]), true), locked, 'once decided (or chosen / hash) a later state changes nothing');
});

test('isSettled: an explicit #hash settles at once; otherwise the selection settles when it is locked or the store is ready', () => {
  const open = { index: 0, locked: false };
  assert.equal(isSettled(open, false, false), false, 'default pick, store still loading: neutral skeleton');
  assert.equal(isSettled(open, false, true), true, 'explicit valid #hash: settled immediately, even before the store is ready');
  assert.equal(isSettled({ index: 3, locked: true }, false, false), true, 'a user choice or a decided pick');
  assert.equal(isSettled(open, true, false), true, 'ready with nothing traded anywhere: index 0 is the honest answer');
  assert.equal(isSettled(settleSelection(open, [{ symbol: 'A', last: 0 }, { symbol: 'B', last: 500 }], true), true, false), true);
  assert.equal(isSettled(settleSelection(open, [{ symbol: 'A', last: 0 }, { symbol: 'B', last: 500 }], false), false, false), false, 'the first traded market is not known yet');
});

test('historyReadError: the poll error only counts as "could not read the history" when nothing is loaded (an empty but loaded market with failed polls is just empty)', () => {
  const loaded = { error: 'fetch failed', markets: [{ last: 0 }], clears: {} };   // synced, nothing ever cleared, two failed polls
  assert.equal(loadFailed(loaded), true, 'same data as a failed first load: loadFailed cannot tell them apart, so the empty-market case is told by ready+history');
  assert.equal(historyReadError({ ...loaded, ready: true, historyComplete: true }), undefined);
  assert.equal(historyReadError({ ...loaded, ready: true, historyComplete: false }), 'fetch failed');
  assert.equal(historyReadError({ error: 'fetch failed', ready: true, historyComplete: true, markets: [{ last: 1100 }], clears: {} }), undefined, 'prices loaded');
  assert.equal(historyReadError({ ready: true, historyComplete: false, markets: [{ last: 0 }], clears: {} }), undefined, 'no error');
});

test('priceSourceLine: a dated US list price reads as a parenthesised basis', () => {
  const l = priceSourceLine({ referenceCents: 79900, priceBasis: 'US list price, as of Oct 2026' });
  assert.equal(l, 'Price set by scripted bots around a $799.00 reference (US list price, as of Oct 2026). Test token (mUSDG), not a live market price.');
});
test('priceSourceLine: the accessory basis is rephrased so there are no nested brackets and it still reads naturally', () => {
  const l = priceSourceLine({ referenceCents: 4900, priceBasis: 'Catalog reference price (fixed snapshot, not a live feed)' });
  assert.equal(l, 'Price set by scripted bots around a $49.00 catalog reference price (fixed snapshot, not a live feed). Test token (mUSDG), not a live market price.');
  assert.doesNotMatch(l, /\([^)]*\(/);
});
test('priceSourceLine: token naming and no banned words', () => {
  for (const b of ['US list price, as of Oct 2026', 'Catalog reference price (fixed snapshot, not a live feed)']) {
    const l = priceSourceLine({ referenceCents: 123456, priceBasis: b });
    assert.match(l, /\$1,234\.56/); assert.match(l, /mUSDG/); assert.doesNotMatch(l, /USDC|order book|recorded|demo|simulated|sample|mock/i);
  }
});
