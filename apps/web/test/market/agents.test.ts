// node --test test/market/agents.test.ts   (from apps/web)
// The keeper-bot registry (src/data/keeper-bots.json): shape, roles against the open strategy, and the public on-chain fingerprint
// on the captured fixture (old book) AND on the redeployed book's baked history (src/data/blindbook-history.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unitsRange } from '../../tools/market-plan.ts';
import { applyEvents, decodeLogs, newLedger, type RawLog } from '../../src/lib/market-core.ts';
import { botFor, type AgentRegistry } from '../../src/lib/agents.ts';

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const FX = json('./fixtures/chain-logs.json') as { logs: RawLog[] };
const REG = json('../../src/data/keeper-bots.json') as AgentRegistry;
const BOOK = json('../../src/data/blindbook.json') as { book: string };
const BAKED = json('../../src/data/blindbook-history.json') as { book: string; events: { e: string; a: Record<string, string | number> }[] };
const PLANS = readFileSync(new URL('../../tools/market-common.ts', import.meta.url), 'utf8');
const SCHED = { t0: 1790958692, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2_000_000 };
const LEDGER = (() => { const l = newLedger(); applyEvents(l, decodeLogs(FX.logs), SCHED); return l; })();

test('registry: six keeper bots, lower-case addresses, names Bot 1..6 in keeper order, copy says scripted bots', () => {
  assert.equal(REG.bots.length, 6);
  REG.bots.forEach((b, i) => { assert.match(b.address, /^0x[0-9a-f]{40}$/); assert.equal(b.keeperIndex, i); assert.equal(b.name, `Bot ${i + 1}`); assert.equal(b.side, i < 3 ? 'buy' : 'sell'); });
  assert.match(REG.note, /scripted bots/); assert.match(REG.note, /not people/); assert.match(REG.note, /No private key/);
});

test('registry roles match the open strategy (tools/market-common.ts plansFor): side, BULK-lot unit range and the pricing rule', () => {
  // The registry's `units` are the BULK lot ranges (unitsRange('bulk', bot)): the lot of the markets the fixture books traded. A market with the other lot (`unit`) sizes its orders differently.
  // plansFor prices each bot from the script's reference price (fairCents): this is the rule each role sentence states
  const RULE: Record<number, [string, RegExp]> = {
    0: ["px(0, 1 - (0.002 + r(0, 'p') * 0.004))", /^buys, limit 0\.2-0\.6% under the reference$/],
    1: ["px(1, 1 + (0.003 + r(1, 'p') * 0.012))", /^buys, limit 0\.3-1\.5% over the reference$/],
    2: ["if (r(2, 'on') < 0.75)", /^buys in 3 of 4 epochs, limit within 1\.5% of the reference$/],
    3: ["px(3, 1 + (0.002 + r(3, 'p') * 0.004))", /^sells, limit 0\.2-0\.6% over the reference$/],
    4: ["px(4, 1 - (0.003 + r(4, 'p') * 0.012))", /^sells, limit 0\.3-1\.5% under the reference$/],
    5: ["if (r(5, 'on') < 0.75)", /^sells in 3 of 4 epochs, limit within 1\.5% of the reference$/],
  };
  for (const b of REG.bots) {
    assert.ok(PLANS.includes(`bot: ${b.keeperIndex}, marketIdx: mIdx, side: ${b.side === 'buy' ? 0 : 1}`), `plansFor side of bot ${b.keeperIndex}`);
    assert.deepEqual([...unitsRange('bulk', b.keeperIndex)], b.units, `bulk-lot units of bot ${b.keeperIndex} (the fixture book traded with them)`);
    const [code, role] = RULE[b.keeperIndex];
    assert.ok(PLANS.includes(code), `plansFor rule of bot ${b.keeperIndex}: ${code}`); assert.match(b.role, role);
  }
  assert.ok(PLANS.includes('unitsRange(m.lot, bot)'), 'plansFor sizes every order from the market lot');
  for (const k of [2, 5]) assert.ok(PLANS.includes(`px(${k}, 1 + (r(${k}, 'p') - 0.5) * 0.03)`), `plansFor bot ${k}: within 1.5% of the reference`);
});

test('roles use sealed-auction words: no continuous order-book jargon, no banned copy words', () => {
  for (const b of REG.bots) assert.doesNotMatch(b.role, /maker|taker|spread|patient|aggressive|noise|recorded|demo|sample|fixture|simulated|mock/i, b.name);
  assert.match(REG.note, /clearing price/);
});

test('registry matches the public on-chain fingerprint of the captured fixture: every trader is a registry bot with its side and BULK-lot unit range (the fixture market is a bulk-lot market)', () => {
  const seen = new Set<string>();
  for (const b of LEDGER.books.values()) for (const o of b.orders) {
    const e = REG.bots.find((x) => x.address === o.trader); assert.ok(e, `unknown trader ${o.trader}`); seen.add(o.trader);
    if (o.price === undefined) continue;
    assert.equal(o.side, e.side === 'buy' ? 0 : 1, `${e.name} side`);
    assert.ok(o.units! >= e.units[0] && o.units! <= e.units[1], `${e.name} units ${o.units}`);
  }
  assert.equal(seen.size, 6);
});

test('the registry still names the keeper bots of the REDEPLOYED book (baked history of src/data/blindbook.json)', () => {
  // Unit ranges are the BULK lot's (registry `units`); this passes only because the baked history holds bulk-lot trades. Once the baked history has orders on a `unit`-lot market (units 1-3), compare against that market's lot instead.
  // Re-keyed bots would make the registry bots vanish from the new book's history: then re-derive keeper-bots.json (same method).
  assert.equal(BAKED.book.toLowerCase(), BOOK.book.toLowerCase(), 'the baked history belongs to the current book');
  const traderOf = new Map<string, string>(); const seen = new Set<string>();
  const key = (a: Record<string, string | number>) => `${a.market}:${a.epoch}:${a.index}`;
  for (const ev of BAKED.events) if (ev.e === 'Committed') traderOf.set(key(ev.a), String(ev.a.trader).toLowerCase());
  for (const ev of BAKED.events) {
    if (ev.e !== 'Revealed') continue;
    const e = botFor(traderOf.get(key(ev.a)) ?? '', REG); if (!e) continue; // other wallets may trade too; they just get no bot name
    seen.add(e.address);
    assert.equal(Number(ev.a.side), e.side === 'buy' ? 0 : 1, `${e.name} side on the new book`);
    assert.ok(Number(ev.a.units) >= e.units[0] && Number(ev.a.units) <= e.units[1], `${e.name} units ${ev.a.units} on the new book`);
  }
  assert.ok(seen.size >= 4, `only ${seen.size} registry bots revealed an order on the new book`);
});

test('botFor: registry bots by address in any case, undefined for anyone else, frozen copies', () => {
  assert.equal(botFor('0x269AFAF16C8D2D31C30DCA433B8C1495028DBB6F', REG)?.name, 'Bot 1');
  assert.equal(botFor('0x1234567890abcdef1234567890abcdef12345678', REG), undefined);
  const e = botFor(REG.bots[1].address, REG)!;
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.units));
  assert.throws(() => { (e as { name: string }).name = 'x'; }, TypeError);
  assert.equal(REG.bots[1].name, 'Bot 2', 'the shared registry is untouched');
});
