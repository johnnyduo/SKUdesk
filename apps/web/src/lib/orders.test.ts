// Run: cd apps/web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test src/lib/orders.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi, encodeEventTopics, encodeAbiParameters, getAddress } from 'viem';
import {
  CENT, STATUS, WHY, statusName, whyName, isTerminal, fmtAmount, fmtMusdc, fmtPrice, fundedFor, paymentFor, bondFor, fmtTime, fmtDuration, shortHex,
  RELEASE_WHY, serializeEvent, mergeEvents, eventsOfOrder, orderIds, summarize, awaiting, buildTimeline, fetchEscrowEvents, attachTimes, TRUST, WHY_TEXT, STATUS_TEXT, type EscrowEvent,
} from './orders.ts';
import { ORDERS_ABI, ORDER_EVENTS } from './orders-abi.ts';

const BUYER = '0x00000000000000000000000000000000000000b1'; const SELLER = '0x00000000000000000000000000000000000000a1'; const VERIFIER = '0x00000000000000000000000000000000000000e1';
let li = 0; let blk = 100;
const ev = (name: string, args: Record<string, string | number | boolean>, block = blk++): EscrowEvent => ({ name, args, tx: '0x' + (li + 1).toString(16).padStart(64, '0'), block, logIndex: li++ });
const created = (id: number, qty = 1, cap = 1300) => ev('OrderCreated', { id: String(id), buyer: BUYER, qty: String(qty), maxPriceCents: String(cap), shipToHash: '0x' + 'ab'.repeat(32), matchBy: '5000', funded: String(fundedFor(cap, qty)) });
const offered = (id: number, price = 1100) => ev('Offered', { id: String(id), seller: SELLER, epoch: '1790', index: '3', priceCents: String(price), acceptBy: '6000' });
const accepted = (id: number, bond = 2_200_000n) => ev('Accepted', { id: String(id), seller: SELLER, bond: String(bond), shipBy: '7000' });
const shipped = (id: number) => ev('Shipped', { id: String(id), seller: SELLER, shipmentHash: '0x' + 'cd'.repeat(32), verifyBy: '8000' });
const attested = (id: number, delivered = true) => ev('Attested', { id: String(id), delivered, receivedSku: '0x' + '11'.repeat(32), receiptHash: '0x' + 'ee'.repeat(32), releaseAfter: delivered ? '9000' : '0' });
const released = (id: number, price = 1100, cap = 1300, qty = 1, bond = 2_200_000n, why = 0, caller = BUYER) => ev('Released', { id: String(id), seller: SELLER, paid: String(paymentFor(price, qty)), refundedToBuyer: String(fundedFor(cap, qty) - paymentFor(price, qty)), bondReturned: String(bond), why, caller });

test('status and why names follow the contract enums', () => {
  assert.deepEqual([...STATUS], ['NONE', 'FUNDED', 'OFFERED', 'MATCHED', 'SHIPPED', 'DELIVERED', 'RELEASED', 'CANCELLED', 'REFUNDED', 'DISPUTED']);
  assert.deepEqual([...WHY], ['UNACCEPTED', 'REJECTED', 'VERIFIER_RULED', 'UNSHIPPED', 'UNVERIFIED', 'DECLINED']); assert.deepEqual([...RELEASE_WHY], ['BUYER', 'TIMEOUT', 'VERIFIER_RULED', 'UNRESOLVED']);
  assert.equal(statusName(6), 'RELEASED'); assert.equal(statusName(9n), 'DISPUTED'); assert.equal(statusName(99), 'NONE'); assert.equal(whyName(3), 'UNSHIPPED');
  for (const s of STATUS) assert.ok(STATUS_TEXT[s].length > 3, s);
  for (const w of WHY) assert.ok(WHY_TEXT[w].length > 20, w);
  assert.deepEqual(STATUS.filter(isTerminal), ['RELEASED', 'CANCELLED', 'REFUNDED']);
});

test('money: 6 decimals, cents times CENT, two decimals at least', () => {
  assert.equal(CENT, 10_000n);
  assert.equal(fmtAmount(0n), '0.00'); assert.equal(fmtAmount(1_000_000n), '1.00'); assert.equal(fmtAmount(12_340_000n), '12.34'); assert.equal(fmtAmount(2_000n), '0.002'); assert.equal(fmtAmount(1n), '0.000001');
  assert.equal(fmtAmount(12_345_678_900_000n), '12,345,678.90'); assert.equal(fmtAmount('10990000'), '10.99'); assert.equal(fmtAmount(-1_500_000n), '-1.50');
  assert.equal(fmtMusdc(10_990_000), '10.99 mUSDG');
  assert.equal(fmtPrice(1099), '10.99 mUSDG'); assert.equal(fmtPrice(1099n), '10.99 mUSDG');
});
test('funded, payment and bond mirror the contract arithmetic', () => {
  assert.equal(fundedFor(1_000_000, 1000), 10_000_000_000_000n);          // qty 1000 at 1_000_000 cents funds exactly 1e13
  assert.equal(fundedFor(1300, 2), 26_000_000n); assert.equal(paymentFor(1100, 2), 22_000_000n);
  assert.equal(bondFor(1100, 1, 2000), 2_200_000n);                         // 20%
  assert.equal(bondFor(1, 1, 1), 1n);                                       // 10_000 * 1 / 10_000 = 1 exactly
  assert.equal(bondFor(1, 1, 3), 3n);
  assert.equal(bondFor(3, 1, 3333), (3n * 10_000n * 3333n + 9999n) / 10_000n);
  assert.equal(bondFor(1, 3, 1) * 1n, 3n);
  assert.ok(bondFor(7, 1, 1) >= (7n * 10_000n * 1n) / 10_000n);             // never rounds down
});
test('time and hex formatting are fixed', () => { assert.equal(fmtTime(0), '1970-01-01 00:00 UTC'); assert.equal(fmtTime(1_790_000_000), '2026-09-21 14:13 UTC'); assert.equal(shortHex('0x' + 'a'.repeat(64)), '0xaaaaaa…aaaa'); assert.equal(shortHex('0x1234'), '0x1234'); });

test('trust notes carry the agreed wording', () => {
  assert.equal(TRUST.verifier, 'The verifier is one address chosen at deployment; it decides whether goods arrived.');
  assert.match(TRUST.concept, /^A cleared BlindBook sell fill is used only as evidence that this seller offered at or below price P in a round that began at or after the buyer funded\./);
  assert.match(TRUST.concept, /It is not an allocation of goods: those units were already sold to the BlindBook buyer and are not redeemable\./);
  assert.match(TRUST.concept, /The seller’s acceptance, the bond and the named verifier are the only guards on delivery\.$/);
  assert.match(TRUST.concept, /consumed is counted within this escrow contract only/); assert.match(TRUST.verifierAddress, /trusted party/);
  assert.match(TRUST.proof, /script-controlled wallets and operator-issued test units/); assert.match(TRUST.proof, /No physical goods moved/);
  assert.match(TRUST.token, /testnet stand-in/);
  for (const s of Object.values(TRUST)) assert.doesNotMatch(s, /\b(demo|sample|mock|judge)\b/i);
});

test('serializeEvent turns bigints into strings and mergeEvents de-duplicates in chain order', () => {
  const s = serializeEvent({ eventName: 'Offered', args: { id: 1n, seller: SELLER, priceCents: 1100n }, transactionHash: '0xaa', blockNumber: 7n, logIndex: 2 });
  assert.deepEqual(s, { name: 'Offered', args: { id: '1', seller: SELLER, priceCents: '1100' }, tx: '0xaa', block: 7, logIndex: 2 });
  const a: EscrowEvent = { name: 'X', args: {}, tx: '0xAA', block: 9, logIndex: 1 }; const b: EscrowEvent = { name: 'X', args: {}, tx: '0xaa', block: 9, logIndex: 1, time: 55 }; const c: EscrowEvent = { name: 'Y', args: {}, tx: '0xbb', block: 8, logIndex: 4 };
  const m = mergeEvents([a], [b, c]); assert.equal(m.length, 2); assert.equal(m[0].tx, '0xbb'); assert.equal(m[1].time, 55);
});

test('a full delivered order: ordered steps, one agent-attested step, the rest onchain, amounts match the contract', () => {
  const evs = [created(1), offered(1), accepted(1), shipped(1), attested(1), released(1)];
  const other = [created(2), offered(2)];
  const all = [...other, ...evs].sort((x, y) => x.block - y.block);
  assert.deepEqual(orderIds(all), [1, 2]);
  const t = buildTimeline({ qty: 1 }, all, { id: 1, verifier: VERIFIER });
  assert.deepEqual(t.map((x) => x.key), ['created', 'matched', 'accepted', 'shipped', 'attested', 'released']);
  assert.deepEqual(t.map((x) => x.provenance), ['onchain', 'onchain', 'onchain', 'agent', 'onchain', 'onchain']);
  assert.ok(t.every((x) => /^0x[0-9a-f]{64}$/.test(x.tx))); assert.deepEqual(t.map((x) => x.at), [...t.map((x) => x.at)].sort((a, b) => a - b));
  assert.equal(t[0].detail, 'The buyer locked 13.00 mUSDG for 1 unit, with a cap of 13.00 mUSDG per unit.');
  assert.match(t[1].detail, /Round 1790, order #3, price 11.00 mUSDG per unit for 1 unit\./);
  assert.match(t[2].detail, /Bond 2.20 mUSDG/); assert.equal(t[3].note, TRUST.shipment); assert.equal(t[4].note, TRUST.verifier); assert.equal(t[4].actor, VERIFIER);
  assert.match(t[5].detail, /received 11.00 mUSDG; the buyer got 2.00 mUSDG back \(cap minus price\); the seller’s 2.20 mUSDG bond was returned\. The buyer released the payment\./);
  const s = summarize(1, all)!; assert.equal(s.status, 'RELEASED'); assert.equal(s.payment, 11_000_000n); assert.equal(s.buyerRefund, 2_000_000n); assert.equal(s.seller, SELLER); assert.equal(awaiting(s), null);
  assert.equal(summarize(2, all)!.status, 'OFFERED'); assert.equal(summarize(9, all), null);
  assert.equal(eventsOfOrder(all, 1).length, 6);
});

test('refund paths: unaccepted, unshipped (bond slashed), unverified (bond back) and verifier rejection', () => {
  const unacc = [created(1), offered(1), ev('Refunded', { id: '1', buyer: BUYER, refund: '13000000', bondToBuyer: '0', bondToSeller: '0', why: '0' })];
  const t1 = buildTimeline({ qty: 1 }, unacc, { id: 1 }); assert.equal(t1.at(-1)!.key, 'refunded'); assert.match(t1.at(-1)!.detail, /13.00 mUSDG returned to the buyer\. The buyer withdrew the offer/);
  assert.equal(summarize(1, unacc)!.why, 'UNACCEPTED');
  const unship = [created(1), offered(1), accepted(1), ev('Refunded', { id: '1', buyer: BUYER, refund: '13000000', bondToBuyer: '2200000', bondToSeller: '0', why: '3' })];
  assert.match(buildTimeline({ qty: 1 }, unship, { id: 1 }).at(-1)!.detail, /plus 2.20 mUSDG of the seller’s bond/); assert.equal(summarize(1, unship)!.bondToBuyer, 2_200_000n);
  const unver = [created(1), offered(1), accepted(1), shipped(1), ev('Refunded', { id: '1', buyer: BUYER, refund: '13000000', bondToBuyer: '0', bondToSeller: '2200000', why: '4' })];
  assert.match(buildTimeline({ qty: 1 }, unver, { id: 1 }).at(-1)!.detail, /2.20 mUSDG bond back to the seller/);
  const rej = [created(1), offered(1), accepted(1), shipped(1), attested(1, false), ev('Refunded', { id: '1', buyer: BUYER, refund: '13000000', bondToBuyer: '2200000', bondToSeller: '0', why: '1' })];
  const t = buildTimeline({ qty: 1 }, rej, { id: 1, verifier: VERIFIER }); assert.equal(t.find((x) => x.key === 'attested')!.label, 'Verifier did not confirm delivery'); assert.equal(t.at(-1)!.label, 'Refunded: the verifier did not confirm delivery'); assert.equal(t.at(-1)!.reason, 'REJECTED'); assert.equal(summarize(1, rej)!.status, 'REFUNDED');
});

test('cancel by a stranger is labelled; dispute and open states say what they wait for', () => {
  const c = [created(1), ev('Cancelled', { id: '1', buyer: BUYER, refund: '13000000', caller: SELLER })];
  assert.match(buildTimeline(null, c)[1].detail, /released by another address after the match deadline/); assert.equal(summarize(1, c)!.status, 'CANCELLED');
  const d = [created(1), offered(1), accepted(1), shipped(1), attested(1), ev('Disputed', { id: '1', buyer: BUYER, resolveBy: '9500' })];
  const sd = summarize(1, d)!; assert.equal(sd.status, 'DISPUTED'); assert.deepEqual(awaiting(sd), { text: 'Waiting for the verifier to rule', deadline: 9500 });
  assert.deepEqual(awaiting(summarize(1, [created(1)])!), { text: 'Waiting for the buyer to match this order to a cleared sell fill', deadline: 5000 });
  assert.equal(awaiting(summarize(1, [created(1), offered(1)])!)!.deadline, 6000); assert.equal(awaiting(summarize(1, [created(1), offered(1), accepted(1)])!)!.deadline, 7000);
  assert.equal(awaiting(summarize(1, [created(1), offered(1), accepted(1), shipped(1)])!)!.deadline, 8000); assert.equal(awaiting(summarize(1, [created(1), offered(1), accepted(1), shipped(1), attested(1)])!)!.deadline, 9000);
});

test('the ABI decodes real logs: a Refunded log round-trips through viem and serializeEvent', async () => {
  const { decodeEventLog } = await import('viem');
  const topics = encodeEventTopics({ abi: ORDERS_ABI, eventName: 'Refunded', args: { id: 5n, buyer: getAddress(BUYER) } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }], [13_000_000n, 2_200_000n, 0n, 3]);
  const d = decodeEventLog({ abi: ORDERS_ABI, topics, data }) as any;
  assert.equal(d.eventName, 'Refunded'); const s = serializeEvent({ eventName: d.eventName, args: d.args, transactionHash: '0xaa', blockNumber: 1n, logIndex: 0 });
  assert.equal(s.args.id, '5'); assert.equal(s.args.why, 3); assert.equal(s.args.bondToBuyer, '2200000');
  for (const n of ORDER_EVENTS) assert.ok(ORDERS_ABI.some((i: any) => i.type === 'event' && i.name === n), n);
  assert.ok(ORDERS_ABI.some((i: any) => i.name === 'matchOrder')); assert.ok(!ORDERS_ABI.some((i: any) => i.name === 'match'));
});

test('fetchEscrowEvents splits a too-large range, retries other errors, and gives up after the retries', async () => {
  const log = (n: number) => ({ eventName: 'BondDeposited', args: { amount: BigInt(n) }, transactionHash: '0x' + n.toString(16), blockNumber: BigInt(n), logIndex: 0 });
  const calls: [bigint, bigint][] = [];
  const big = { async getContractEvents(a: any) { calls.push([a.fromBlock, a.toBlock]); if (a.toBlock - a.fromBlock > 3n) throw new Error('query returned more than 10000 results'); const out = []; for (let b = a.fromBlock; b <= a.toBlock; b++) out.push(log(Number(b))); return out; } };
  const r = await fetchEscrowEvents(big, { address: '0x1', abi: ORDERS_ABI, from: 1n, to: 10n });
  assert.deepEqual(r.map((e) => e.block), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); assert.ok(calls.length > 1);
  let n = 0; const flaky = { async getContractEvents() { if (n++ < 2) throw new Error('503'); return [log(5)]; } };
  assert.equal((await fetchEscrowEvents(flaky, { address: '0x1', abi: ORDERS_ABI, from: 1n, to: 9n, backoffMs: 1 })).length, 1);
  const dead = { async getContractEvents() { throw new Error('down'); } };
  await assert.rejects(() => fetchEscrowEvents(dead, { address: '0x1', abi: ORDERS_ABI, from: 1n, to: 9n, retries: 1, backoffMs: 1 }), /down/);
});
test('attachTimes reads each distinct block once and keeps known times', async () => {
  let reads = 0; const c = { async getContractEvents() { return []; }, async getBlock(a: any) { reads++; return { timestamp: a.blockNumber * 10n }; } };
  const out = await attachTimes(c, [{ name: 'a', args: {}, tx: '0x1', block: 5, logIndex: 0 }, { name: 'b', args: {}, tx: '0x2', block: 5, logIndex: 1 }, { name: 'c', args: {}, tx: '0x3', block: 6, logIndex: 0, time: 1 }]);
  assert.equal(reads, 1); assert.deepEqual(out.map((e) => e.time), [50, 50, 1]);
});

test('release reasons: a silent verifier after a dispute reads as a default, not a ruling; the caller is shown', () => {
  const base = [created(1), offered(1), accepted(1), shipped(1), attested(1), ev('Disputed', { id: '1', buyer: BUYER, resolveBy: '9500' })];
  const un = buildTimeline({ qty: 1 }, [...base, released(1, 1100, 1300, 1, 2_200_000n, 3, SELLER)], { id: 1 }).at(-1)!;
  assert.equal(un.label, 'Payment released by default: the verifier did not rule in time'); assert.equal(un.reason, 'UNRESOLVED'); assert.equal(un.actor, SELLER); assert.match(un.note!, /not a ruling/); assert.match(un.detail, /did not rule in time/);
  const ruled = buildTimeline({ qty: 1 }, [...base, released(1, 1100, 1300, 1, 2_200_000n, 2, VERIFIER)], { id: 1 }).at(-1)!; assert.equal(ruled.label, 'Verifier ruled for the seller: payment released'); assert.equal(ruled.note, undefined);
  const to = buildTimeline({ qty: 1 }, [created(1), offered(1), accepted(1), shipped(1), attested(1), released(1, 1100, 1300, 1, 2_200_000n, 1, SELLER)], { id: 1 }).at(-1)!; assert.equal(to.label, 'Payment released after the dispute window');
  assert.equal(summarize(1, [...base, released(1, 1100, 1300, 1, 2_200_000n, 3)])!.releaseWhy, 'UNRESOLVED');
  const dec = buildTimeline({ qty: 1 }, [created(1), offered(1), ev('Refunded', { id: '1', buyer: BUYER, refund: '13000000', bondToBuyer: '0', bondToSeller: '0', why: '5' })], { id: 1 }).at(-1)!;
  assert.equal(dec.label, 'Refunded: the seller declined the offer'); assert.equal(summarize(1, [created(1), offered(1), ev('Refunded', { id: '1', buyer: BUYER, refund: '13000000', bondToBuyer: '0', bondToSeller: '0', why: '5' })])!.why, 'DECLINED');
});

test('durations are short and plain', () => { assert.equal(fmtDuration(60), '60 s'); assert.equal(fmtDuration(900), '15 min'); assert.equal(fmtDuration(1800), '30 min'); assert.equal(fmtDuration(7200), '2 h'); assert.equal(fmtDuration(86400 * 3), '3 days'); });
