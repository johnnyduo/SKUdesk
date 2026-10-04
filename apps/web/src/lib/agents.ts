// Keeper-bot registry: the public addresses of the six scripted SKUdesk keeper wallets (src/data/keeper-bots.json), each matched to
// its keeper role from public on-chain behaviour only (side, order sizes) against the open script (tools/market-common.ts plansFor).
// A registry name labels a wallet; it does not prove who controls it, and the UI says so. Display names: market-view.ts walletLabel.
// Pure: no React, no I/O.
export type AgentEntry = { address: string; name: string; keeperIndex: number; side: 'buy' | 'sell'; role: string; units: [number, number] };
export type AgentRegistry = { note: string; derivedAt: string; bots: AgentEntry[] };

/** The registry entry for `address` (any letter case) as a frozen copy, or undefined for every other wallet. */
export function botFor(address: string, reg: AgentRegistry): Readonly<AgentEntry> | undefined {
  const a = address.toLowerCase(); const e = reg.bots.find((b) => b.address.toLowerCase() === a);
  // Registry data is shared module state: hand out frozen copies so a UI mutation can never corrupt it.
  return e ? Object.freeze({ ...e, units: Object.freeze([...e.units]) as unknown as [number, number] }) : undefined;
}
