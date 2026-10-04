// node --test test/market/keeper-plan.test.ts   (from apps/web)
// The keeper's plan (pure): market rotation, order sizes by lot, the buyer bots' worst-case cash per batch, the seller inventory, the
// markets still to list, and source pins for the listing and cash steps of tools/market-setup.ts. Nothing here talks to a chain or reads a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUY_PRICE_MAX, cashTargetTokens, marketsToList, maxGap, parsePins, quotedMarkets, quotesOf, resolvePins, rotation, sellerUnitsTarget, unitsRange, worstBuyerSpendCents } from '../../tools/market-plan.ts';
import { LOTS } from '../../src/lib/catalog.ts';

const CATALOG = JSON.parse(readFileSync(new URL('../../src/data/catalog.json', import.meta.url), 'utf8')).markets as { id: string; symbol: string; referenceCents: number; lot: 'bulk' | 'unit'; tick: number }[];
const POOL = CATALOG.map((_, i) => i);
const N = CATALOG.length; // 12 main products (unit lot) + 6 phone cases (bulk lot)
const src = (f: string) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

test('rotation: count distinct markets per epoch, every market quoted at least every ceil(n/count) epochs, no market privileged', () => {
  for (const count of [1, 2, 3, 4, 5]) {
    const gap = maxGap(POOL.length, count); const last = new Map<number, number>(); let worst = 0; const hits = new Map<number, number>();
    for (let e = 1000; e < 1600; e++) {
      const r = rotation(e, count, POOL);
      assert.equal(r.length, Math.min(count, POOL.length)); assert.equal(new Set(r).size, r.length);
      for (const i of r) { if (last.has(i)) worst = Math.max(worst, e - last.get(i)!); last.set(i, e); hits.set(i, (hits.get(i) ?? 0) + 1); }
    }
    assert.equal(last.size, POOL.length, `count ${count}: every market is quoted`);
    assert.ok(worst <= gap, `count ${count}: worst gap ${worst} > ${gap}`);
    const h = [...hits.values()]; assert.ok(Math.max(...h) - Math.min(...h) <= 1, `count ${count}: equal shares ${h}`);
  }
  assert.equal(maxGap(12, 1), 12); assert.equal(maxGap(12, 3), 4);
  assert.equal(N, 18); assert.equal(maxGap(N, 1), 18); assert.equal(maxGap(N, 3), 6);
});

test('rotation across all 18 markets at the default 1 per acted epoch: each market is quoted exactly once per 18 acted epochs, cases and products alike', () => {
  const order = Array.from({ length: N }, (_, e) => rotation(4000 + e, 1, POOL)[0]);
  assert.equal(new Set(order).size, N, 'a full cycle quotes every market once');
  const lots = new Set(order.map((i) => CATALOG[i].lot)); assert.deepEqual([...lots].sort(), ['bulk', 'unit'], 'both lot tiers are in the rotation');
  for (let start = 0; start < 40; start++) {
    const seen = new Set<number>(); for (let e = start; e < start + N; e++) seen.add(rotation(e, 1, POOL)[0]);
    assert.equal(seen.size, N, `any ${N} consecutive acted epochs quote all ${N} markets (start ${start})`);
  }
});

test('rotation: only listed markets (the pool) are quoted; small pools and odd counts are safe', () => {
  const pool = [0, 2, 5]; // e.g. only three markets listed on the book yet
  for (let e = 0; e < 50; e++) assert.ok(rotation(e, 1, pool).every((i) => pool.includes(i)));
  assert.deepEqual([0, 1, 2, 3].map((e) => rotation(e, 1, pool)[0]), [0, 2, 5, 0]);
  assert.deepEqual(rotation(7, 3, [4]), [4]);
  assert.deepEqual(rotation(7, 0, POOL), []);
  assert.deepEqual(rotation(7, 3, []), []);
  assert.deepEqual(rotation(NaN, 1, POOL), []);
  assert.equal(rotation(7, 99, POOL).length, POOL.length);
});

test('quotedMarkets: with --every N only every Nth epoch acts, and the rotation advances per ACTED epoch so no market starves', () => {
  for (const every of [1, 2, 3, 4, 6]) for (const count of [1, 2]) {
    const seen = new Set<number>(); let acted = 0; const lastActed = new Map<number, number>(); let worstGap = 0;
    for (let e = 2000; e < 2000 + N * every * 3; e++) {
      const q = quotedMarkets(e, every, count, POOL);
      if (e % every !== 0) { assert.deepEqual(q, [], `every ${every}: epoch ${e} is idle`); continue; }
      acted++; assert.equal(q.length, count); q.forEach((i) => { seen.add(i); if (lastActed.has(i)) worstGap = Math.max(worstGap, acted - lastActed.get(i)!); lastActed.set(i, acted); });
    }
    assert.ok(worstGap <= maxGap(N, count), `every ${every} count ${count}: a market waited ${worstGap} acted epochs, more than ceil(${N}/${count})`);
    assert.equal(seen.size, POOL.length, `every ${every} count ${count}: all ${POOL.length} markets are quoted (rotating on epoch % pool alone would reach only some)`);
    assert.ok(acted > 0);
  }
  assert.deepEqual(quotedMarkets(7, 1, 1, POOL), rotation(7, 1, POOL), 'every 1 is the plain rotation');
  assert.deepEqual(quotedMarkets(7, 0, 1, POOL), rotation(7, 1, POOL), 'a bad --every counts as 1');
});

test('order sizes: bulk keeps the original strategy (the keeper-bots.json fingerprint), unit trades 1-3 devices per order', () => {
  const REG = JSON.parse(readFileSync(new URL('../../src/data/keeper-bots.json', import.meta.url), 'utf8')).bots as { keeperIndex: number; units: [number, number] }[];
  for (const b of REG) assert.deepEqual([...unitsRange('bulk', b.keeperIndex)], b.units, `bot ${b.keeperIndex}`);
  for (let b = 0; b < 6; b++) { const [lo, hi] = unitsRange('unit', b); assert.ok(lo >= 1 && hi <= 3 && lo <= hi); }
  assert.deepEqual(LOTS.unit.maker, [1, 3]);
});

test('plansFor: every order of every market uses its lot size and bids at most BUY_PRICE_MAX times the reference', async () => {
  process.env.ROBINHOOD_RPC ??= 'http://127.0.0.1:9'; // module-level client creation needs a URL; nothing is sent
  const { plansFor, CATALOG: C } = await import('../../tools/market-common.ts');
  assert.equal(C.length, CATALOG.length);
  for (let mi = 0; mi < C.length; mi++) for (let e = 5000; e < 5040; e++) for (const p of plansFor(C[mi], mi, e)) {
    const [lo, hi] = unitsRange(C[mi].lot, p.bot);
    assert.ok(p.units >= lo && p.units <= hi, `${C[mi].symbol} bot ${p.bot} units ${p.units}`);
    if (p.side === 0) assert.ok(p.price <= Math.ceil(C[mi].referenceCents * BUY_PRICE_MAX), `${C[mi].symbol} bid ${p.price}`);
    assert.ok(p.price <= 1_000_000, 'BlindBook.MAX_PRICE_CENTS');
  }
});

test('cash: the worst case per buyer bot for one 40-epoch batch at 1 market per epoch fits the target the setup tops up to', () => {
  const w1 = worstBuyerSpendCents(CATALOG, 40, 1), w3 = worstBuyerSpendCents(CATALOG, 40, 3);
  console.log(`  worst buyer spend per 40-epoch batch over ${N} markets: ${(w1 / 100).toFixed(0)} tokens at 1 market/epoch, ${(w3 / 100).toFixed(0)} at 3; targets ${cashTargetTokens(CATALOG, 40, 1)} / ${cashTargetTokens(CATALOG, 40, 3)}`);
  assert.ok(cashTargetTokens(CATALOG, 40, 1) * 100 >= w1 * 1.25);
  assert.ok(cashTargetTokens(CATALOG, 40, 3) >= cashTargetTokens(CATALOG, 40, 1));
  assert.equal(cashTargetTokens([], 40, 1), 50_000);
  // ceil(40 / 18) = 3 quotes of each of the 18 markets; the largest buyer is the maker, bidding its lot's largest order (3 units for a
  // device, 24 for a case) at up to BUY_PRICE_MAX, plus the bond: a bound worked out by hand with both lot tiers
  const hand = CATALOG.reduce((s, m) => s + 3 * ((m.lot === 'unit' ? 3 : 24) * Math.ceil(m.referenceCents * BUY_PRICE_MAX) + 200), 0);
  assert.equal(w1, hand);
  const cases = CATALOG.filter((m) => m.lot === 'bulk'), devices = CATALOG.filter((m) => m.lot === 'unit');
  assert.deepEqual([cases.length, devices.length], [6, 12]);
  assert.ok(worstBuyerSpendCents(cases, 40, 1) < 0.2 * w1, 'six $8-13 cases at the bulk lot add little to the devices\' cash');
  // the 12 main products alone (what the first deploy of the new book lists) fit the same target: the setup never under-funds
  assert.ok(worstBuyerSpendCents(devices, 40, 1) <= cashTargetTokens(CATALOG, 40, 1) * 100, 'twelve listed markets (4 quotes each) still fit the 18-market target');
  // without lot sizes (bulk everywhere) the same batch would need about 8x the cash: the reason for the unit lot
  assert.ok(worstBuyerSpendCents(CATALOG.map((m) => ({ ...m, lot: 'bulk' as const })), 40, 1) > 6 * w1);
});

test('seller inventory: sized from the lot and the batch, never below the floor, covering many batches of the largest sale', () => {
  assert.equal(sellerUnitsTarget('unit', 40, 1, N), 1_000);
  assert.equal(sellerUnitsTarget('bulk', 40, 1, N), 20_000, 'cases keep the original bulk target with 18 markets');
  assert.equal(sellerUnitsTarget('unit', 40, 1, 12), 1_000);
  assert.equal(sellerUnitsTarget('bulk', 40, 1, 12), 20_000, 'the original target for the bulk lot');
  assert.equal(sellerUnitsTarget('unit', 40, 12, 12), 40 * 3 * 50, 'quoting every market every epoch: 50 batches of the largest sale');
  assert.ok(sellerUnitsTarget('unit', 40, 3, 12) >= 50 * Math.ceil((40 * 3) / 12) * LOTS.unit.maker[1]);
  assert.equal(sellerUnitsTarget('unit', 0, 1, 12), 1_000); assert.equal(sellerUnitsTarget('unit', 40, 1, 0), 1_000);
});

test('marketsToList: exactly the catalog markets the book does not list yet, in catalog order', () => {
  const m = CATALOG.slice(0, 4).map((c) => ({ symbol: c.symbol }));
  assert.deepEqual(marketsToList(m, [false, false, false, false]).map((x) => x.symbol), m.map((x) => x.symbol));
  assert.deepEqual(marketsToList(m, [true, false, true, false]).map((x) => x.symbol), [m[1].symbol, m[3].symbol]);
  assert.deepEqual(marketsToList(m, [true, true, true, true]), []);
  assert.throws(() => marketsToList(m, [true]), /one listed flag per market/);
});

test('marketsToList over the real catalog: the six cases already listed by DeployBook are skipped, the twelve products are listed in catalog order', () => {
  const flags = CATALOG.map((m) => m.lot === 'bulk'); // the first book listed exactly the six case markets
  assert.deepEqual(marketsToList(CATALOG, flags).map((m) => m.symbol), CATALOG.slice(0, 12).map((m) => m.symbol));
  assert.deepEqual(marketsToList(CATALOG, CATALOG.map(() => true)), [], 'a second run lists nothing: idempotent');
});

test('market-setup lists every catalog market before issuing units, idempotently, and sizes book cash and inventory from the plan', () => {
  const common = src('tools/market-common.ts'), keeper = src('tools/keeper.ts'), setup = src('tools/market-setup.ts'), sup = src('tools/keeper-supervisor.ts'), abi = src('src/lib/book-abi.ts');
  assert.ok(common.includes('return quotedMarkets(epoch, every, count, pool, pinned);'));
  assert.ok(keeper.includes('activeMarkets(ep, MKTS, LISTED, EVERY, PINNED)') && keeper.includes('LISTED = await listedPool();'));
  assert.ok(keeper.includes("const MKTS = Number(arg('markets', '1'));"), 'one market per epoch by default (bot gas)');
  assert.ok(sup.includes("arg('markets', '1')"), 'the supervisor passes the same default');
  assert.equal((sup.match(/\.\.\.PIN_ARGS/g) ?? []).length, 2, 'the supervisor forwards --pin to market-setup and to the keeper');
  assert.ok(setup.includes('cashTargetTokens(CATALOG, BATCH, MKTS, PINNED)') && setup.includes('PINNED.includes(idx)'), 'cash and inventory are sized for the pins');
  assert.ok(abi.includes("'function listMarket(bytes32 id, uint256 tick)'"));
  const list = setup.indexOf("'listMarket'"), issue = setup.indexOf("'issue'");
  assert.ok(list > 0 && issue > list, 'listing comes before the units are issued');
  assert.ok(setup.indexOf("functionName: 'markets'") < list, 'listing is idempotent (reads markets(id) first)');
  assert.ok(setup.includes('marketsToList(CATALOG, flags)'), 'only unlisted markets are listed');
  assert.ok(setup.includes('cashTargetTokens(CATALOG, BATCH, MKTS, PINNED)'), 'book cash follows the catalog prices');
  assert.ok(setup.includes('sellerUnitsTarget('), 'seller inventory follows the lot');
  assert.doesNotMatch(setup, /UNITS_TARGET = 20_000n/, 'no flat 20,000-unit target any more');
});

// --pin (keeper option)
const SYM = CATALOG.map((m) => ({ symbol: m.symbol }));
const IP16 = CATALOG.findIndex((m) => m.symbol === 'IP16P-CLR');

test('parsePins: repeatable and comma lists, no value or a following flag is ignored', () => {
  assert.deepEqual(parsePins(['node', 'keeper.ts', '--pin', 'A', '--pin', 'B,C', '--markets', '2']), ['A', 'B', 'C']);
  assert.deepEqual(parsePins(['--pin', ' A , ,B ']), ['A', 'B']);
  assert.deepEqual(parsePins(['--markets', '1']), []);
  assert.deepEqual(parsePins(['--pin']), []);
  assert.deepEqual(parsePins(['--pin', '--markets', '1']), []);
});

test('resolvePins: case-insensitive, deduplicated, unknown symbol is a clear error, unlisted pins are reported', () => {
  assert.ok(IP16 >= 0, 'the demo market exists in the catalog');
  assert.deepEqual(resolvePins(['ip16p-clr', 'IP16P-CLR'], SYM).pinned, [IP16]);
  assert.deepEqual(resolvePins([], SYM), { pinned: [], unlisted: [] });
  assert.throws(() => resolvePins(['IP16P-CLR', 'NOPE', 'ALSO-NOPE'], SYM), /unknown --pin symbol NOPE, ALSO-NOPE .*catalog symbols: .*IP16P-CLR/);
  const pool = POOL.filter((i) => i !== IP16);
  assert.deepEqual(resolvePins(['IP16P-CLR'], SYM, pool), { pinned: [IP16], unlisted: ['IP16P-CLR'] });
  assert.deepEqual(resolvePins(['IP16P-CLR'], SYM, POOL).unlisted, []);
});

test('pin: a pinned market is in EVERY acted epoch; --markets 1 --pin X is that market only', () => {
  for (let e = 3000; e < 3200; e++) assert.deepEqual(quotedMarkets(e, 1, 1, POOL, [IP16]), [IP16]);
  for (const count of [1, 2, 3]) for (let e = 3000; e < 3200; e++) assert.ok(quotedMarkets(e, 1, count, POOL, [IP16]).includes(IP16));
  assert.deepEqual(quotedMarkets(3001, 1, 1, POOL, [IP16]).length, 1);
});

test('pin: the remaining slots rotate fairly over the rest of the pool (never the pinned market twice)', () => {
  for (const [count, pins] of [[2, [IP16]], [3, [IP16]], [3, [IP16, 0]], [4, [IP16, 0]]] as const) {
    const slots = count - pins.length, rest = POOL.filter((i) => !pins.includes(i)); const hits = new Map<number, number>(); const last = new Map<number, number>(); let worst = 0;
    for (let e = 100; e < 100 + rest.length * 10; e++) {
      const q = quotedMarkets(e, 1, count, POOL, pins);
      assert.equal(q.length, count); assert.equal(new Set(q).size, count, 'distinct markets'); assert.deepEqual(q.slice(0, pins.length), [...pins]);
      for (const i of q.slice(pins.length)) { assert.ok(rest.includes(i)); hits.set(i, (hits.get(i) ?? 0) + 1); if (last.has(i)) worst = Math.max(worst, e - last.get(i)!); last.set(i, e); }
    }
    assert.equal(hits.size, rest.length, `count ${count} pins ${pins.length}: every other market is quoted`);
    const h = [...hits.values()]; assert.ok(Math.max(...h) - Math.min(...h) <= 1, `count ${count}: equal shares ${h}`);
    assert.ok(worst <= maxGap(N, count, pins.length) && maxGap(N, count, pins.length) === Math.ceil(rest.length / slots), `count ${count}: worst gap ${worst}`);
  }
  assert.equal(maxGap(N, 2, 1), 17); assert.equal(maxGap(N, 1, 1), Infinity, 'one slot, one pin: nothing else rotates'); assert.equal(maxGap(N, 1), 18, 'no pin: unchanged');
});

test('pin: without --pin (or with an empty list) the plain rotation is unchanged', () => {
  for (const count of [1, 2, 3]) for (const every of [1, 2, 3]) for (let e = 0; e < 120; e++) {
    assert.deepEqual(quotedMarkets(e, every, count, POOL, []), quotedMarkets(e, every, count, POOL));
    assert.deepEqual(quotedMarkets(e, every, count, POOL, []), e % every === 0 ? rotation(e / every, count, POOL) : []);
  }
});

test('pin: a pin outside the listed pool is ignored (the rotation runs as if there were no pin)', () => {
  const pool = POOL.filter((i) => i !== IP16);
  for (let e = 0; e < 60; e++) { assert.deepEqual(quotedMarkets(e, 1, 2, pool, [IP16]), rotation(e, 2, pool)); assert.ok(!quotedMarkets(e, 1, 2, pool, [IP16]).includes(IP16)); }
  const q = quotedMarkets(5, 1, 3, pool, [IP16, pool[2]]); assert.deepEqual(q.slice(0, 1), [pool[2]], 'the listed pin stays, the unlisted one is dropped'); assert.equal(q.length, 3);
});

test('pin: more pins than --markets quotes every pin and nothing rotates; bad inputs quote nothing', () => {
  assert.deepEqual(quotedMarkets(9, 1, 1, POOL, [3, 5]), [3, 5]);
  assert.deepEqual(quotedMarkets(9, 1, 2, POOL, [3, 5]), [3, 5]);
  assert.deepEqual(quotedMarkets(9, 1, 0, POOL, [3]), []);
  assert.deepEqual(quotedMarkets(NaN, 1, 1, POOL, [3]), []);
  assert.deepEqual(quotedMarkets(9, 1, 3, [4], [4]), [4], 'a one-market pool pinned to itself');
});

test('pin x --every: pins are quoted in every ACTED epoch only, and the rest of the rotation still advances per acted epoch', () => {
  for (const every of [2, 3, 4]) {
    const seen = new Set<number>(); let acted = 0;
    for (let e = 2000; e < 2000 + N * every * 3; e++) {
      const q = quotedMarkets(e, every, 2, POOL, [IP16]);
      if (e % every !== 0) { assert.deepEqual(q, [], `every ${every}: epoch ${e} idle`); continue; }
      acted++; assert.equal(q[0], IP16); q.slice(1).forEach((i) => seen.add(i));
    }
    assert.equal(seen.size, N - 1, `every ${every}: all other markets still rotate through the second slot (rotating on epoch % pool would alias)`);
    assert.ok(acted >= N * 3);
  }
});

test('pin: cash and inventory sizing, pinned markets are quoted in every epoch (numbers printed)', () => {
  assert.equal(quotesOf(40, 1, N), 3); assert.equal(quotesOf(40, 1, N, 1, true), 40); assert.equal(quotesOf(40, 1, N, 1, false), 0); assert.equal(quotesOf(40, 2, N, 1, false), Math.ceil(40 / 17));
  assert.equal(worstBuyerSpendCents(CATALOG, 40, 1, []), worstBuyerSpendCents(CATALOG, 40, 1), 'no pin: unchanged');
  const free = worstBuyerSpendCents(CATALOG, 40, 1), p1 = worstBuyerSpendCents(CATALOG, 40, 1, [IP16]), p2 = worstBuyerSpendCents(CATALOG, 40, 2, [IP16]);
  const m = CATALOG[IP16]; const hand1 = 40 * ((m.lot === 'unit' ? 3 : 24) * Math.ceil(m.referenceCents * BUY_PRICE_MAX) + 200);
  assert.equal(p1, hand1, '--markets 1 --pin X: only X is ever quoted, 40 quotes');
  assert.ok(p2 > p1);
  console.log(`  worst buyer spend per 40-epoch batch: ${(free / 100).toFixed(0)} tokens (no pin, 1/epoch), ${(p1 / 100).toFixed(0)} (--pin ${m.symbol}, 1/epoch), ${(p2 / 100).toFixed(0)} (--pin ${m.symbol}, 2/epoch); targets ${cashTargetTokens(CATALOG, 40, 1)} / ${cashTargetTokens(CATALOG, 40, 1, [IP16])} / ${cashTargetTokens(CATALOG, 40, 2, [IP16])}`);
  for (const [bat, per, pins] of [[40, 1, [IP16]], [40, 2, [IP16]], [40, 3, [IP16, 0]], [300, 2, [IP16]]] as const)
    assert.ok(cashTargetTokens(CATALOG, bat, per, pins) * 100 >= worstBuyerSpendCents(CATALOG, bat, per, pins) * 1.25, 'target covers the worst case');
  assert.ok(cashTargetTokens(CATALOG, 40, 1, [IP16]) >= 50_000);
  assert.equal(sellerUnitsTarget('unit', 40, 1, N, 0, false), 1_000, 'no pin: unchanged');
  assert.equal(sellerUnitsTarget('unit', 40, 1, N, 1, true), 40 * 3 * 50, 'a pinned device market: 40 quotes x 3 units x 50 batches');
  assert.equal(sellerUnitsTarget('unit', 40, 1, N, 1, false), 1_000, 'an unpinned market under --markets 1 --pin X keeps the floor');
});

test('keeper and market-setup read --pin once, validated against the catalog before any chain call', () => {
  const keeper = src('tools/keeper.ts'), setup = src('tools/market-setup.ts'), common = src('tools/market-common.ts'), sup = src('tools/keeper-supervisor.ts');
  assert.ok(keeper.indexOf('pinsFromArgs()') > 0 && keeper.indexOf('pinsFromArgs()') < keeper.indexOf('async function main'), 'unknown pin fails at start-up');
  assert.ok(keeper.includes('pinsFromArgs(LISTED).unlisted') && keeper.includes('is not listed on this book'), 'an unlisted pin is warned about and ignored');
  assert.ok(keeper.includes('--pin SYMBOL') && setup.includes('--pin SYMBOL') && sup.includes('--pin SYMBOL'), 'usage text mentions --pin');
  assert.ok(common.includes('resolvePins(parsePins(process.argv), CATALOG, pool)'));
  assert.ok(sup.indexOf('pinsFromArgs();') > 0, 'the supervisor validates the pin too, instead of failing every batch');
});
