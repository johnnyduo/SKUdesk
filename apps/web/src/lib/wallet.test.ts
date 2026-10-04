// Unit tests for the wallet engine, using fake EIP-1193 providers. Run: node --test apps/web/src/lib/wallet.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeErrorResult } from 'viem';
import { ContractFunctionRevertedError } from 'viem';
import { createWalletEngine, codeOf, isRejected, decodeRevert, WalletError, WALLET_CODE } from './wallet.ts';
import { CORE_ABI } from './owner-abi.ts';
import { explain } from './explain.ts';

const CHAIN = { id: 46630, name: 'Robinhood Chain Testnet', rpc: 'https://rpc.example', explorer: 'https://explorer.example' };
const ACC = '0x6129C88CE91ACdf5c1E42188B1aF88C2166a5501';
const err = (code: number, message = 'x') => Object.assign(new Error(message), { code });

class FakeWin extends EventTarget { ethereum?: any; }
class FakeProvider {
  calls: { method: string; params?: any }[] = []; handlers: Record<string, (p?: any) => any> = {}; listeners: Record<string, Function[]> = {};
  constructor(h: Record<string, (p?: any) => any> = {}) { this.handlers = h; }
  async request(a: { method: string; params?: any }) { this.calls.push(a); const h = this.handlers[a.method]; if (!h) throw err(-32601, 'no handler ' + a.method); return h(a.params); }
  on(e: string, f: Function) { (this.listeners[e] ??= []).push(f); } removeListener(e: string, f: Function) { this.listeners[e] = (this.listeners[e] ?? []).filter((x) => x !== f); }
  emit(e: string, ...a: any[]) { (this.listeners[e] ?? []).forEach((f) => f(...a)); }
  methods() { return this.calls.map((c) => c.method); }
}
const announce = (win: FakeWin, uuid: string, name: string, rdns: string, provider: any) => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, name, icon: 'data:,', rdns }, provider } }));
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };

function setup(over: Record<string, (p?: any) => any> = {}, extra: any = {}) {
  const win = new FakeWin(); const storage = mem();
  const provider = new FakeProvider({ eth_requestAccounts: () => [ACC], eth_accounts: () => [ACC], eth_chainId: () => '0xb626', ...over });
  const pub = { simulateContract: async () => ({}), waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 7n, gasUsed: 21000n }), ...extra.pub };
  const writes: any[] = [];
  const makeWalletClient = () => ({ writeContract: async (a: any) => { writes.push(a); if (extra.signError) throw extra.signError; return '0xabc' as const; } });
  const engine = createWalletEngine({ chain: CHAIN, win: win as any, storage, publicClient: pub, makeWalletClient, restoreTimeoutMs: 120, fallbackDelayMs: 10 });
  engine.discover(); announce(win, 'u1', 'Test Wallet', 'io.test', provider);
  return { engine, win, provider, storage, writes, pub };
}
const tx = { address: '0x0000000000000000000000000000000000000001' as const, abi: CORE_ABI as any, functionName: 'pause', args: [true] };

test('codeOf finds nested codes and isRejected recognises both forms', () => {
  assert.equal(codeOf({ code: 4001 }), 4001); assert.equal(codeOf({ cause: { code: 4902 } }), 4902); assert.equal(codeOf({ data: { originalError: { code: -32002 } } }), -32002); assert.equal(codeOf(new Error('cancelled by user')), undefined);
  assert.ok(isRejected({ code: 4001 })); assert.ok(isRejected({ name: 'UserRejectedRequestError' })); assert.ok(!isRejected(new Error('user cancelled but no code')), 'must not guess from message text');
});

test('discovery lists announced wallets once and falls back to window.ethereum', async () => {
  const { engine, win, provider } = setup(); announce(win, 'u1', 'Test Wallet', 'io.test', provider);
  assert.equal(engine.getState().wallets.length, 1);
  const win2 = new FakeWin(); win2.ethereum = new FakeProvider(); const e2 = createWalletEngine({ chain: CHAIN, win: win2 as any, storage: mem(), fallbackDelayMs: 5 });
  e2.discover(); await new Promise((r) => setTimeout(r, 40)); assert.equal(e2.getState().wallets[0]?.rdns, 'legacy.window.ethereum');
});

test('connect shares the account, records the chain and persists the wallet', async () => {
  const { engine, storage } = setup(); await engine.connect();
  const s = engine.getState(); assert.equal(s.status, 'connected'); assert.equal(s.account, ACC); assert.equal(s.chainId, 46630); assert.equal(s.onTargetChain, true); assert.equal(storage.m.get('robinize.wallet.rdns'), 'io.test');
});

test('connect on the wrong network is flagged, not hidden', async () => {
  const { engine } = setup({ eth_chainId: () => '0x1' }); await engine.connect(); assert.equal(engine.getState().onTargetChain, false); assert.equal(engine.getState().chainId, 1);
});

test('connect rejected (4001) sets a friendly error and throws kind=rejected', async () => {
  const { engine } = setup({ eth_requestAccounts: () => { throw err(4001); } });
  await assert.rejects(engine.connect(), (e: any) => e instanceof WalletError && e.kind === 'rejected');
  assert.match(engine.getState().error!, /declined/i); assert.equal(engine.getState().status, 'error');
});

test('the agent-account and faucet refusals read as sentences', () => {
  assert.match(explain('SelectorNotAllowed', ['0x2e1a7d4d']), /owner-only/); assert.match(explain('TargetNotAllowed', ['0xabc']), /only call its own vault/);
  assert.match(explain('ValueNotAllowed', [1n]), /may not send ETH/); assert.match(explain('BadMargin', [50n]), /0\.50%/); assert.match(explain('Empty', []), /faucet is empty/);
});

test('connect with no wallet installed explains what to do', async () => {
  const engine = createWalletEngine({ chain: CHAIN, win: new FakeWin() as any, storage: mem(), fallbackDelayMs: 5 });
  await assert.rejects(engine.connect(), (e: any) => e.kind === 'no-wallet'); assert.match(engine.getState().error!, /No browser wallet/);
});

test('unknown chain (4902): adds the chain with exact params, then confirms the switch', async () => {
  let chainHex = '0x1'; let added: any;
  const { engine, provider } = setup({
    eth_chainId: () => chainHex,
    wallet_switchEthereumChain: () => { throw err(WALLET_CODE.UNRECOGNIZED_CHAIN, 'Unrecognized chain ID'); },
    wallet_addEthereumChain: (p) => { added = p[0]; chainHex = '0xb626'; return null; },
  });
  await engine.connect(); await engine.switchToTargetChain();
  assert.deepEqual(added, { chainId: '0xb626', chainName: CHAIN.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] });
  assert.equal(engine.getState().onTargetChain, true); assert.ok(provider.methods().includes('wallet_addEthereumChain'));
});

test('declining the switch throws rejected and never tries to add the chain', async () => {
  const { engine, provider } = setup({ eth_chainId: () => '0x1', wallet_switchEthereumChain: () => { throw err(4001); } });
  await engine.connect(); await assert.rejects(engine.switchToTargetChain(), (e: any) => e.kind === 'rejected'); assert.ok(!provider.methods().includes('wallet_addEthereumChain'));
});

test('send runs simulate then sign then wait, in order, and reports each step', async () => {
  const order: string[] = []; const { engine } = setup({}, { pub: { simulateContract: async () => { order.push('simulate'); return {}; }, waitForTransactionReceipt: async () => { order.push('wait'); return { status: 'success', blockNumber: 9n, gasUsed: 50000n }; } } });
  await engine.connect(); const steps: string[] = [];
  const r = await engine.send({ ...tx, onStep: (s) => { steps.push(s); if (s === 'signing') order.push('sign'); } });
  assert.deepEqual(order, ['simulate', 'sign', 'wait']); assert.deepEqual(steps, ['simulating', 'signing', 'pending', 'confirmed']); assert.equal(r.hash, '0xabc'); assert.equal(r.block, 9n);
});

test('ETH value is simulated and signed with the same amount', async () => {
  const seen: any[] = []; const { engine, writes } = setup({}, { pub: { simulateContract: async (a: any) => { seen.push(a); return {}; } } });
  await engine.connect(); await engine.send({ ...tx, value: 500_000_000_000_000n });
  assert.equal(seen[0].value, 500_000_000_000_000n); assert.equal(writes[0].value, 500_000_000_000_000n);
  await engine.send(tx); assert.equal(seen[1].value, undefined, 'no value when none is given');
});

test('a transaction that would revert never reaches the wallet and is explained in words', async () => {
  const data = encodeErrorResult({ abi: CORE_ABI, errorName: 'Paused' });
  const revert = new ContractFunctionRevertedError({ abi: CORE_ABI, data, functionName: 'deposit' });
  const { engine, writes } = setup({}, { pub: { simulateContract: async () => { throw revert; } } });
  await engine.connect();
  await assert.rejects(engine.send(tx), (e: any) => e.kind === 'simulation' && e.errorName === 'Paused' && /paused the vault/.test(e.message));
  assert.equal(writes.length, 0, 'wallet must not be asked to sign a doomed tx');
});

test('decodeRevert turns custom errors with arguments into sentences', () => {
  const data = encodeErrorResult({ abi: CORE_ABI, errorName: 'InsufficientFree', args: [100_000_000n, 1_581_600_000n] });
  const d = decodeRevert(new ContractFunctionRevertedError({ abi: CORE_ABI, data, functionName: 'withdraw' }))!;
  assert.equal(d.name, 'InsufficientFree'); assert.match(d.sentence, /\$100\.00 is free.*\$1581\.60 is needed/); assert.equal(decodeRevert(new Error('plain')), null);
});

test('declining the signature is reported as rejected', async () => {
  const { engine } = setup({}, { signError: err(4001) }); await engine.connect(); await assert.rejects(engine.send(tx), (e: any) => e.kind === 'rejected');
});

test('a mined-but-reverted receipt is an error, not a success', async () => {
  const { engine } = setup({}, { pub: { waitForTransactionReceipt: async () => ({ status: 'reverted', blockNumber: 1n, gasUsed: 1n }) } }); await engine.connect();
  await assert.rejects(engine.send(tx), (e: any) => e.kind === 'reverted');
});

test('sending on the wrong network switches first and never simulates or signs if the user declines', async () => {
  const sim: string[] = []; const { engine, writes } = setup({ eth_chainId: () => '0x1', wallet_switchEthereumChain: () => { throw err(4001); } }, { pub: { simulateContract: async () => { sim.push('x'); return {}; } } });
  await engine.connect(); await assert.rejects(engine.send(tx), (e: any) => e.kind === 'rejected'); assert.equal(sim.length, 0); assert.equal(writes.length, 0);
});

test('send without a connection fails clearly', async () => { const { engine } = setup(); await assert.rejects(engine.send(tx), (e: any) => e.kind === 'not-connected'); });

test('silent restore: nothing remembered -> no wallet requests at all', async () => { const { engine, provider } = setup(); await engine.restore(); assert.equal(engine.getState().status, 'idle'); assert.equal(provider.calls.length, 0); });

test('silent restore reconnects a remembered wallet without prompting', async () => {
  const { engine, provider, storage } = setup(); storage.setItem('robinize.wallet.rdns', 'io.test'); await engine.restore();
  assert.equal(engine.getState().status, 'connected'); assert.ok(!provider.methods().includes('eth_requestAccounts'), 'restore must never open a prompt'); assert.equal(engine.getState().restoring, false);
});

test('a locked wallet that never answers cannot hang the restore', async () => {
  const { engine, storage } = setup({ eth_accounts: () => new Promise(() => {}) }); storage.setItem('robinize.wallet.rdns', 'io.test');
  const t0 = Date.now(); await engine.restore(); assert.ok(Date.now() - t0 < 1000); assert.equal(engine.getState().status, 'idle'); assert.equal(engine.getState().restoring, false);
});

test('accountsChanged and chainChanged keep the state live; an empty account list disconnects', async () => {
  const { engine, provider } = setup(); await engine.connect();
  provider.emit('chainChanged', '0x1'); assert.equal(engine.getState().onTargetChain, false); provider.emit('chainChanged', '0xb626'); assert.equal(engine.getState().onTargetChain, true);
  provider.emit('accountsChanged', ['0x0000000000000000000000000000000000000002']); assert.equal(engine.getState().account, '0x0000000000000000000000000000000000000002');
  provider.emit('accountsChanged', []); assert.equal(engine.getState().status, 'idle'); assert.equal(engine.getState().account, undefined); assert.equal(engine.getState().onTargetChain, false);
});

test('explain covers owner-console errors in plain language', () => {
  assert.match(explain('Unauthorized'), /owner wallet/); assert.match(explain('PayeeNotAllowed', ['0xabc']), /allowlist/); assert.match(explain('OutOfBounds', ['0x6d696e4d617267696e4270730000000000000000000000000000000000000000', 50n]), /minMarginBps = 50/);
  assert.match(explain('Allowance'), /approved/);
});
