// Injected-wallet engine (EIP-6963 discovery + EIP-1193 requests) on top of viem. No React, no app config: everything
// environment-specific is injected, so the whole thing is unit-testable with fake providers.
//
// Lessons deliberately applied (from a survey of the cats.fund wallet layer):
//  - classify wallet errors by numeric code (4001 rejected, 4902 unknown chain, -32002 request pending), never by message regex
//  - pin chainId on every write and refuse to sign on the wrong network
//  - add the chain to the wallet on 4902 (the chain is not a wallet default)
//  - simulate before asking the user to sign, so a doomed transaction never reaches the wallet
//  - a silent reconnect must time out: a locked wallet can leave eth_accounts hanging forever
import { createPublicClient, createWalletClient, custom, http, defineChain, BaseError, ContractFunctionRevertedError, type Abi } from 'viem';
import { explain } from './explain.ts';

export type Eip1193 = { request(a: { method: string; params?: any }): Promise<any>; on?(e: string, h: (...a: any[]) => void): void; removeListener?(e: string, h: (...a: any[]) => void): void };
export type DiscoveredWallet = { uuid: string; name: string; icon: string; rdns: string; provider: Eip1193 };
export type ChainConfig = { id: number; name: string; rpc: string; explorer: string };
export type WalletState = {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  wallets: Pick<DiscoveredWallet, 'uuid' | 'name' | 'icon' | 'rdns'>[];
  wallet?: { name: string; rdns: string; icon: string };
  account?: `0x${string}`;
  chainId?: number;
  onTargetChain: boolean;
  restoring: boolean;
  error?: string;
};
export type TxStep = 'switching' | 'simulating' | 'signing' | 'pending' | 'confirmed';
export type TxSpec = { address: `0x${string}`; abi: Abi; functionName: string; args?: any[]; value?: bigint; onStep?: (s: TxStep) => void };
export type TxResult = { hash: `0x${string}`; block: bigint; gasUsed: bigint };
export type WalletErrorKind = 'no-wallet' | 'not-connected' | 'rejected' | 'wrong-network' | 'simulation' | 'reverted' | 'pending-request' | 'rpc';
export class WalletError extends Error {
  kind: WalletErrorKind; errorName?: string; errorArgs?: any[];
  constructor(kind: WalletErrorKind, message: string, extra?: { errorName?: string; errorArgs?: any[] }) { super(message); this.name = 'WalletError'; this.kind = kind; this.errorName = extra?.errorName; this.errorArgs = extra?.errorArgs; }
}

export const WALLET_CODE = { USER_REJECTED: 4001, UNAUTHORIZED: 4100, DISCONNECTED: 4900, UNRECOGNIZED_CHAIN: 4902, REQUEST_PENDING: -32002 } as const;
/** Numeric EIP-1193 / JSON-RPC error code, wherever the wallet or viem put it. */
export function codeOf(e: any): number | undefined {
  for (const c of [e?.code, e?.cause?.code, e?.data?.originalError?.code, e?.cause?.cause?.code]) if (typeof c === 'number') return c;
  return undefined;
}
export const isRejected = (e: any) => codeOf(e) === WALLET_CODE.USER_REJECTED || e?.name === 'UserRejectedRequestError' || e?.cause?.name === 'UserRejectedRequestError';

export function decodeRevert(e: unknown): { name: string; args: any[]; sentence: string } | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data) { const args = [...(r.data.args ?? [])]; return { name: r.data.errorName, args, sentence: explain(r.data.errorName, args) }; }
  }
  return null;
}

const STORE_KEY = 'robinize.wallet.rdns';
const hexChain = (id: number) => '0x' + id.toString(16);
const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type EngineDeps = {
  chain: ChainConfig;
  win?: { addEventListener: Function; removeEventListener: Function; dispatchEvent: Function; ethereum?: Eip1193 };
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  publicClient?: any;                                              // injectable for tests; defaults to a viem public client on chain.rpc
  makeWalletClient?: (provider: Eip1193, account: `0x${string}`) => any; // injectable for tests
  restoreTimeoutMs?: number; receiptTimeoutMs?: number; fallbackDelayMs?: number;
};

export function createWalletEngine(deps: EngineDeps) {
  const { chain } = deps;
  const win = deps.win ?? (typeof window !== 'undefined' ? (window as any) : undefined);
  const storage = deps.storage ?? (() => { try { return typeof localStorage !== 'undefined' ? localStorage : undefined; } catch { return undefined; } })();
  const restoreTimeoutMs = deps.restoreTimeoutMs ?? 1500;
  const viemChain = defineChain({ id: chain.id, name: chain.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chain.rpc] } }, blockExplorers: { default: { name: 'Blockscout', url: chain.explorer } } });
  let pub = deps.publicClient;
  const publicClient = () => (pub ??= createPublicClient({ chain: viemChain, transport: http(chain.rpc, { timeout: 12_000 }) }));
  const makeWalletClient = deps.makeWalletClient ?? ((provider: Eip1193, account: `0x${string}`) => createWalletClient({ account, chain: viemChain, transport: custom(provider as any) }));

  const found = new Map<string, DiscoveredWallet>();
  let current: DiscoveredWallet | undefined;
  let state: WalletState = { status: 'idle', wallets: [], onTargetChain: false, restoring: false };
  const subs = new Set<() => void>();
  const set = (patch: Partial<WalletState>) => { const next = { ...state, ...patch }; state = { ...next, onTargetChain: next.chainId === chain.id }; subs.forEach((f) => f()); };
  const publicWallets = () => [...found.values()].map(({ uuid, name, icon, rdns }) => ({ uuid, name, icon, rdns }));

  // discovery (EIP-6963, with a window.ethereum fallback)
  let discovering = false;
  function discover() {
    if (!win || discovering) return; discovering = true;
    win.addEventListener('eip6963:announceProvider', (ev: any) => {
      const d = ev?.detail; if (!d?.info?.uuid || !d?.provider) return;
      found.set(d.info.uuid, { uuid: d.info.uuid, name: d.info.name, icon: d.info.icon, rdns: d.info.rdns, provider: d.provider });
      set({ wallets: publicWallets() });
    });
    win.dispatchEvent(typeof CustomEvent !== 'undefined' ? new CustomEvent('eip6963:requestProvider') : ({ type: 'eip6963:requestProvider' } as any));
    setTimeout(() => { // legacy single-provider wallets that never announce
      if (found.size === 0 && win.ethereum) { found.set('legacy', { uuid: 'legacy', name: 'Browser wallet', icon: '', rdns: 'legacy.window.ethereum', provider: win.ethereum }); set({ wallets: publicWallets() }); }
    }, deps.fallbackDelayMs ?? 400);
  }

  // provider events
  let detach: (() => void) | undefined;
  function attach(w: DiscoveredWallet) {
    detach?.();
    const onAccounts = (accts: string[]) => { if (!accts?.length) { disconnect(); return; } set({ account: accts[0] as `0x${string}` }); };
    const onChain = (id: string) => set({ chainId: Number.parseInt(id, 16) });
    w.provider.on?.('accountsChanged', onAccounts); w.provider.on?.('chainChanged', onChain);
    detach = () => { w.provider.removeListener?.('accountsChanged', onAccounts); w.provider.removeListener?.('chainChanged', onChain); };
  }

  const describe = (e: any): string => {
    switch (codeOf(e)) {
      case WALLET_CODE.USER_REJECTED: return 'You declined the request in your wallet.';
      case WALLET_CODE.REQUEST_PENDING: return 'Your wallet already has a request open. Open it and approve or reject it first.';
      case WALLET_CODE.UNAUTHORIZED: return 'Your wallet has not authorised this site yet.';
      case WALLET_CODE.DISCONNECTED: return 'Your wallet lost its connection. Reopen it and try again.';
      default: return e?.shortMessage || e?.message || 'The wallet returned an error.';
    }
  };

  async function activate(w: DiscoveredWallet, accounts: string[]) {
    current = w; attach(w);
    let chainId: number | undefined;
    try { chainId = Number.parseInt(await w.provider.request({ method: 'eth_chainId' }), 16); } catch { /* shown as unknown */ }
    try { storage?.setItem(STORE_KEY, w.rdns); } catch { /* private mode */ }
    set({ status: 'connected', wallet: { name: w.name, rdns: w.rdns, icon: w.icon }, account: accounts[0] as `0x${string}`, chainId, error: undefined });
  }

  async function connect(rdns?: string) {
    discover();
    const list = [...found.values()];
    const w = rdns ? list.find((x) => x.rdns === rdns) : list[0];
    if (!w) { set({ status: 'error', error: 'No browser wallet found. Install one (for example MetaMask, Rabby or Coinbase Wallet) and reload.' }); throw new WalletError('no-wallet', state.error!); }
    set({ status: 'connecting', error: undefined });
    try { const accts: string[] = await w.provider.request({ method: 'eth_requestAccounts' }); if (!accts?.length) throw new WalletError('rejected', 'No account was shared.'); await activate(w, accts); }
    catch (e: any) {
      const kind: WalletErrorKind = isRejected(e) ? 'rejected' : codeOf(e) === WALLET_CODE.REQUEST_PENDING ? 'pending-request' : 'rpc';
      set({ status: 'error', error: describe(e) }); throw new WalletError(kind, describe(e));
    }
  }

  /** Silent reconnect after a page load. Never prompts, and gives up after a timeout so a locked wallet cannot hang the UI. */
  async function restore() {
    discover(); let rdns: string | null = null; try { rdns = storage?.getItem(STORE_KEY) ?? null; } catch { /* */ }
    if (!rdns) return;
    set({ restoring: true });
    try {
      // wallets announce asynchronously: wait briefly for the remembered one
      const t0 = Date.now(); while (![...found.values()].some((w) => w.rdns === rdns) && Date.now() - t0 < restoreTimeoutMs) await new Promise((r) => setTimeout(r, 25));
      const w = [...found.values()].find((x) => x.rdns === rdns); if (!w) return;
      const accts: string[] = await Promise.race([w.provider.request({ method: 'eth_accounts' }), new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('restore timeout')), restoreTimeoutMs))]);
      if (accts?.length) await activate(w, accts);
    } catch { /* stay disconnected */ } finally { set({ restoring: false }); }
  }

  function disconnect() {
    detach?.(); detach = undefined; current = undefined;
    try { storage?.removeItem(STORE_KEY); } catch { /* */ }
    set({ status: 'idle', wallet: undefined, account: undefined, chainId: undefined, error: undefined });
  }

  async function switchToTargetChain() {
    if (!current) throw new WalletError('not-connected', 'Connect a wallet first.');
    const p = current.provider; const params = [{ chainId: hexChain(chain.id) }];
    try { await p.request({ method: 'wallet_switchEthereumChain', params }); }
    catch (e: any) {
      if (isRejected(e)) throw new WalletError('rejected', describe(e));
      if (codeOf(e) === WALLET_CODE.UNRECOGNIZED_CHAIN || /unrecognized chain|not added|unknown chain/i.test(String(e?.message))) {
        try { await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hexChain(chain.id), chainName: chain.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [chain.rpc], blockExplorerUrls: [chain.explorer] }] }); }
        catch (e2: any) { throw new WalletError(isRejected(e2) ? 'rejected' : 'wrong-network', isRejected(e2) ? describe(e2) : `Could not add ${chain.name} to your wallet.`); }
      } else throw new WalletError('wrong-network', describe(e));
    }
    // wallets usually emit chainChanged, but re-read so the state is right even if they do not
    try { set({ chainId: Number.parseInt(await p.request({ method: 'eth_chainId' }), 16) }); } catch { /* */ }
    if (state.chainId !== chain.id) throw new WalletError('wrong-network', `Your wallet is still on another network. Switch to ${chain.name}.`);
  }

  /** simulate -> sign -> wait. A transaction that would revert never reaches the wallet. */
  async function send(spec: TxSpec): Promise<TxResult> {
    if (!current || !state.account) throw new WalletError('not-connected', 'Connect a wallet first.');
    const step = (s: TxStep) => spec.onStep?.(s);
    if (state.chainId !== chain.id) { step('switching'); await switchToTargetChain(); }
    step('simulating');
    try { await publicClient().simulateContract({ address: spec.address, abi: spec.abi, functionName: spec.functionName, args: spec.args ?? [], value: spec.value, account: state.account }); }
    catch (e) { const d = decodeRevert(e); throw new WalletError('simulation', d ? d.sentence : (e as any)?.shortMessage ?? 'The transaction would fail.', d ? { errorName: d.name, errorArgs: d.args } : undefined); }
    step('signing');
    let hash: `0x${string}`;
    try { hash = await makeWalletClient(current.provider, state.account).writeContract({ address: spec.address, abi: spec.abi, functionName: spec.functionName, args: spec.args ?? [], value: spec.value, chain: viemChain, account: state.account }); }
    catch (e: any) { throw new WalletError(isRejected(e) ? 'rejected' : codeOf(e) === WALLET_CODE.REQUEST_PENDING ? 'pending-request' : 'rpc', describe(e)); }
    step('pending');
    let rc: any;
    try { rc = await publicClient().waitForTransactionReceipt({ hash, timeout: deps.receiptTimeoutMs ?? 60_000 }); }
    catch (e: any) { throw new WalletError('rpc', `Sent (${hash}) but no confirmation yet: ${e?.shortMessage ?? e?.message}`); }
    if (rc.status === 'reverted') throw new WalletError('reverted', 'The transaction was mined but reverted.');
    step('confirmed');
    return { hash, block: rc.blockNumber, gasUsed: rc.gasUsed };
  }

  return { getState: () => state, subscribe: (f: () => void) => { subs.add(f); return () => subs.delete(f); }, discover, connect, restore, disconnect, switchToTargetChain, send, isAccount: (a?: string) => sameAddr(a, state.account), chain };
}
export type WalletEngine = ReturnType<typeof createWalletEngine>;
