// Binds the wallet engine to this app's chain and gives React islands a hook. One engine per page: every island
// that imports this module shares the same state, so a connection made in the top bar is seen by the Owner console.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createWalletEngine, type WalletState } from './wallet.ts';
import { CHAIN, DEPLOYMENT, IS_REAL_CHAIN, RUN } from './run';
import { client } from './chain';
import { CORE_ABI, TOKEN_ABI } from './owner-abi.ts';
import { getAddress } from 'viem';

export const walletEngine = createWalletEngine({ chain: { id: CHAIN.id, name: CHAIN.name, rpc: CHAIN.rpc, explorer: CHAIN.explorer } });
export const CORE = DEPLOYMENT.core as `0x${string}`;
export const TOKEN = DEPLOYMENT.token as `0x${string}`;
export const WALLET_ENABLED = IS_REAL_CHAIN;

let started = false;
export function useWallet(): WalletState {
  const s = useSyncExternalStore(walletEngine.subscribe, walletEngine.getState, walletEngine.getState);
  useEffect(() => { if (started) return; started = true; walletEngine.discover(); void walletEngine.restore(); }, []);
  return s;
}

export type Role = 'owner' | 'agent' | 'visitor';
/** The connected account's role on the deployed vault, read from the contract (owner() and agent()). */
export function useRole(account?: string): { role: Role | null; owner?: string; agent?: string } {
  const [r, setR] = useState<{ role: Role | null; owner?: string; agent?: string }>({ role: null });
  useEffect(() => {
    let live = true; setR({ role: null });   // never keep the previous account's role while the new one is read
    (async () => {
      try {
        const [owner, agent] = await Promise.all([client().readContract({ address: getAddress(CORE), abi: CORE_ABI, functionName: 'owner' }), client().readContract({ address: getAddress(CORE), abi: CORE_ABI, functionName: 'agent' })]) as [string, string];
        const role: Role | null = !account ? null : account.toLowerCase() === owner.toLowerCase() ? 'owner' : account.toLowerCase() === agent.toLowerCase() ? 'agent' : 'visitor';
        if (live) setR({ role, owner, agent });
      } catch { if (live) setR({ role: null, owner: RUN.meta.owner, agent: RUN.meta.agent }); }   // unknown, not 'visitor': an RPC hiccup must not demote the real owner
    })();
    return () => { live = false; };
  }, [account]);
  return r;
}

/** Token balance and vault allowance for an account (6-decimal base units). */
export async function readTokenInfo(account: string) {
  const c = client();
  const [balance, allowance, tokenOwner] = await Promise.all([
    c.readContract({ address: getAddress(TOKEN), abi: TOKEN_ABI, functionName: 'balanceOf', args: [getAddress(account)] }),
    c.readContract({ address: getAddress(TOKEN), abi: TOKEN_ABI, functionName: 'allowance', args: [getAddress(account), getAddress(CORE)] }),
    c.readContract({ address: getAddress(TOKEN), abi: TOKEN_ABI, functionName: 'owner' }),
  ]) as [bigint, bigint, string];
  return { balance, allowance, tokenOwner };
}
export { CORE_ABI, TOKEN_ABI };
