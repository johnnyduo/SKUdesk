// Unit tests for the simulator routine (the sell-price range handling) against a mock JSON-RPC transport. Run: node --test apps/web/src/lib/sim.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, custom, encodeErrorResult, parseAbi, getAddress, keccak256, toHex } from 'viem';
import { simulateCommitWith, SimOutOfRange, RANGE_MESSAGE, type SimDeps, type SimInput } from './sim.ts';
import { economics } from '../../../../packages/economics/index.ts';

const ERRORS = parseAbi(['error OutOfBounds(bytes32 field,uint256 value)', 'error MathMismatch(int256 claimedNet,int256 derivedNet,uint256 claimedBps,uint256 derivedBps)']);
const QUOTE = '(uint256 purchaseCents,uint256 shipCents,uint256 dutyCents,uint256 taxCents,uint256 procFeeCents,uint256 payFeeCents,uint256 sellCents,uint256 mktFeeBps,uint256 fulfillCents,uint256 retBps,uint256 chainCents)';
const ABI = parseAbi([`function commitOpportunity(bytes32 productHash,bytes32 quoteHash,bytes32 snapshotHash,uint256 observedAt,uint256 units,${QUOTE} q,int256 agentNet,uint256 agentMarginBps) returns (bytes32,uint256,int256)`, ...ERRORS.map((e) => 'error ' + e.name + '(' + e.inputs.map((x) => x.type + ' ' + x.name).join(',') + ')')]);
const CORE = getAddress('0x1111111111111111111111111111111111111111');
const AGENT = getAddress('0x2222222222222222222222222222222222222222');
const block = { number: '0x10', hash: keccak256('0x01'), parentHash: keccak256('0x02'), timestamp: toHex(1_800_000_000), nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1000000', gasUsed: '0x0', miner: AGENT, extraData: '0x', transactions: [], uncles: [], size: '0x1', logsBloom: '0x' + '00'.repeat(256), sha3Uncles: keccak256('0x03'), stateRoot: keccak256('0x04'), receiptsRoot: keccak256('0x05'), transactionsRoot: keccak256('0x06'), totalDifficulty: '0x0', mixHash: keccak256('0x07') };

// A mock chain: records every RPC method, answers getBlock, and answers eth_call by reverting like the contract (bounds first, then math).
function mock(revert: 'bounds' | 'none' | 'rpcdown' = 'bounds') {
  const calls: string[] = [];
  let lastCall: any;
  const client = createPublicClient({ transport: custom({ async request({ method, params }: any) {
    calls.push(method);
    if (method === 'eth_getBlockByNumber') return block;
    if (method === 'eth_call') {
      lastCall = params[0];
      if (revert === 'rpcdown') throw Object.assign(new Error('fetch failed'), { code: -32603 });
      if (revert === 'bounds') throw Object.assign(new Error('execution reverted'), { code: 3, data: encodeErrorResult({ abi: ERRORS, errorName: 'OutOfBounds', args: [toHex('sellCents', { size: 32 }) as any, 10n ** 12n + 1n] }) });
      return '0x' + '00'.repeat(96);
    }
    throw new Error('unexpected rpc ' + method);
  } }) });
  const deps: SimDeps = { economics, client: client as any, core: CORE, agent: AGENT, abi: ABI };
  return { deps, calls, lastCall: () => lastCall };
}
const base: SimInput = { buyCents: 590, shipCents: 42, sellCents: 1099, units: 350 };

test('sell = 9e11 is evaluated as before: mirror runs, eth_call issued, derived figures returned', async () => {
  const m = mock('none');
  const r = await simulateCommitWith(m.deps, { ...base, sellCents: 9e11 });
  assert.equal(r.accepted, true);
  assert.ok(r.accepted && r.derived.net === economics({ purchaseCents: 590, inboundShipCents: 42, importDutyCents: 12, taxCents: 8, procurementFeeCents: 5, paymentFeeCents: 2, sellCents: 9e11, marketplaceFeeBps: 800, fulfillmentCents: 65, returnReserveBps: 200, chainCostCents: 4, units: 350, fixedBatchCents: 0 }).netCents);
  assert.ok(m.calls.includes('eth_call'));
});

test('honest ordinary trade still gets a normal verdict', async () => {
  const m = mock('bounds');
  const r = await simulateCommitWith(m.deps, base);
  assert.equal(r.accepted, false);
  assert.ok(!r.accepted && r.derived && r.derived.landed === 659);
});

test('sell = 9e11 + 1 -> distinct range result with the honest message, no eth_call', async () => {
  const m = mock('none');
  await assert.rejects(simulateCommitWith(m.deps, { ...base, sellCents: 9e11 + 1 }), (e: any) => {
    assert.ok(e instanceof SimOutOfRange);
    assert.equal(e.code, 'range');
    assert.equal(e.message, RANGE_MESSAGE);
    assert.match(e.message, /Outside the range this page can check exactly \(above \$9,000,000,000\)/);
    assert.doesNotMatch(e.message, /RPC unreachable/i);
    return true;
  });
  assert.ok(!m.calls.includes('eth_call'), 'the range case answers locally');
});

test('sell = 1e12 is still inside the contract bound: range result, not an OutOfBounds call', async () => {
  const m = mock('none');
  await assert.rejects(simulateCommitWith(m.deps, { ...base, sellCents: 1e12 }), SimOutOfRange);
});

test('sell = 1e12 + 1 skips the mirror, issues the eth_call and surfaces the contract OutOfBounds verdict', async () => {
  const m = mock('bounds');
  const r = await simulateCommitWith(m.deps, { ...base, sellCents: 1e12 + 1 });
  assert.ok(m.calls.includes('eth_call'));
  assert.equal(r.accepted, false);
  if (r.accepted) return;
  assert.equal(r.error, 'OutOfBounds');
  assert.match(r.sentence, /sellCents/);
  assert.match(r.sentence, /outside the allowed bounds/);
  assert.equal(r.derived, undefined, 'no TS figures are invented for an input the library cannot compute');
});

test('a huge user-typed sell (1e13) also reaches the contract', async () => {
  const m = mock('bounds');
  const r = await simulateCommitWith(m.deps, { ...base, sellCents: 1e13 });
  assert.ok(!r.accepted && r.error === 'OutOfBounds');
});

test('a RangeError from the mirror is never an RPC error; a real RPC failure stays a plain Error', async () => {
  const m = mock('none');
  const boom = { ...m.deps, economics: () => { throw new RangeError('anything'); } };
  await assert.rejects(simulateCommitWith(boom, base), (e: any) => e instanceof SimOutOfRange && !(e instanceof RangeError) && !/RPC unreachable/i.test(e.message));
  const down = mock('rpcdown');
  await assert.rejects(simulateCommitWith(down.deps, base), (e: any) => !(e instanceof SimOutOfRange));
});
