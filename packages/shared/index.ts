// packages/shared — canonical types. Single source of truth for chain + commerce config.
export type CanonicalProduct = {
  id: string; brand: string; model: string; category: string;
  gtin?: string; mpn?: string; compatibility?: string; color?: string;
  size?: string; material?: string; packCount?: number;
  attributes: Record<string, string>;
};
export type ConnectorMode = 'LIVE' | 'FIXTURE' | 'DEGRADED' | 'OFFLINE';
export type MarketOffer = {
  id: string; source: 'google' | 'shopee' | 'lazada' | 'supplier' | 'fixture';
  sourceProductId: string; title: string; url: string; image?: string;
  priceCents: number; currency: string; shippingCents: number; stock?: number;
  seller?: string; gtin?: string; mpn?: string;
  attributes: Record<string, string>;
  observedTick: number; connectorMode: ConnectorMode; provenance: string;
};
export type AgentEvent = {
  id: string; runId: string;
  type: 'discover' | 'normalize' | 'match' | 'reject' | 'quote' | 'policy' | 'execute' | 'card' | 'order' | 'lot' | 'chain' | 'settle' | 'error';
  status: 'started' | 'progress' | 'completed' | 'failed';
  message: string; metadata: Record<string, unknown>; createdAt: string;
};
// Reference data only. The vault settles in its own MockUSDC (testnet stand-in token), not in the `usdg` addresses below.
export const CHAINS = {
  robinhood: { id: 46630, name: 'Robinhood Chain Testnet', rpc: 'https://rpc.testnet.chain.robinhood.com', usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F' },
  arbitrumSepolia: { id: 421614, name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc', usdg: '0xFFC95faa3d63Cde504a05B567C600B78C0b41892' },
} as const;
// Deterministic PRNG (mulberry32). Same seed -> same data on every reload, every machine.
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

