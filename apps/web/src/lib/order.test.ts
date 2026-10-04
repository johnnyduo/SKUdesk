// node --test apps/web/src/lib/order.test.ts   (the hash is cross-checked against Foundry's own keccak/abi-encode through `cast`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from 'viem';
import { BOOK_ABI } from './book-abi.ts';
import { commitHash, newSalt, validateOrder, saveOrder, listOrders, indexFromReceipt, type SealedOrder } from './order.ts';

const M = keccak256(toHex('CASE-IP16PRO-CLEAR-MAG-001')) as `0x${string}`;
const o: SealedOrder = { market: M, epoch: 17, trader: '0x6129C88CE91ACdf5c1E42188B1aF88C2166a5501', side: 0, price: 1099, units: 10, salt: ('0x' + '11'.repeat(32)) as `0x${string}` };

test('commit hash equals Foundry abi.encode + keccak256 (the same expression the contract evaluates)', () => {
  const enc = execFileSync('cast', ['abi-encode', 'f(bytes32,uint256,address,uint8,uint256,uint256,bytes32)', o.market, String(o.epoch), o.trader, String(o.side), String(o.price), String(o.units), o.salt], { encoding: 'utf8' }).trim();
  const expected = execFileSync('cast', ['keccak', enc], { encoding: 'utf8' }).trim();
  assert.equal(commitHash(o), expected);
});
test('every field changes the hash (the commitment binds side, price, size, epoch, trader and salt)', () => {
  const base = commitHash(o);
  for (const v of [{ side: 1 as const }, { price: 1100 }, { units: 11 }, { epoch: 18 }, { trader: '0x3EC91B7dfF57403aE298e503FAe4f5815B4C1818' as const }, { salt: ('0x' + '12'.repeat(32)) as `0x${string}` }]) assert.notEqual(commitHash({ ...o, ...v }), base);
});
test('salts are 32 random bytes and never repeat', () => { const a = newSalt(), b = newSalt(); assert.match(a, /^0x[0-9a-f]{64}$/); assert.notEqual(a, b); });
test('validation mirrors the contract and speaks plainly', () => {
  const ctx = { tick: 5, cashBase: 100_000_000n, unitsFree: 20n, bondBase: 2_000_000n };
  assert.equal(validateOrder({ side: 1, price: 1100, units: 10 }, ctx), null);
  assert.match(validateOrder({ side: 1, price: 1101, units: 10 }, ctx)!, /multiple of 5/);
  assert.match(validateOrder({ side: 1, price: 1100, units: 0 }, ctx)!, /whole number/);
  assert.match(validateOrder({ side: 1, price: 1100, units: 21 }, ctx)!, /hold 20 units/);
  assert.match(validateOrder({ side: 0, price: 1100, units: 10 }, ctx)!, /reserves \$1\.10|reserves \$110\.00/);
  assert.match(validateOrder({ side: 0, price: 100, units: 1 }, { ...ctx, cashBase: 1_000_000n })!, /sealing bond/);
  assert.equal(validateOrder({ side: 0, price: 100, units: 1 }, ctx), null);
});
test('stored salts survive a reload and are scoped per book and trader', () => {
  const m = new Map<string, string>(); const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  saveOrder(store, '0xBook', { ...o, createdAt: 1 }); saveOrder(store, '0xBook', { ...o, index: 3, createdAt: 2 });
  const l = listOrders(store, '0xbook', o.trader.toLowerCase()); assert.equal(l.length, 1, 'same order is updated, not duplicated'); assert.equal(l[0].index, 3);
  assert.equal(listOrders(store, '0xOther', o.trader).length, 0); assert.deepEqual(listOrders(undefined, '0xBook', o.trader), []);
});
test('the order index is read from the Committed event in the receipt', () => {
  const topics = encodeEventTopics({ abi: BOOK_ABI, eventName: 'Committed', args: { market: M, epoch: 17n, trader: o.trader } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [7n, commitHash(o)]);
  assert.equal(indexFromReceipt([{ address: '0x0000000000000000000000000000000000000001', topics, data, logIndex: 0, blockNumber: 1n, transactionHash: '0x', transactionIndex: 0, blockHash: '0x', removed: false }], o.trader), 7);
  assert.equal(indexFromReceipt([], o.trader), undefined);
});
