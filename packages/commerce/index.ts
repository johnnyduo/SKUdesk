// Commerce connector INTERFACE ONLY. No connector is implemented: every entry below is a stub that
// returns no data and reports no latency. The web app uses seeded fixtures (apps/web/src/lib/engine.ts).
export interface CommerceConnector { id: string; mode: 'LIVE' | 'STUB'; search(q: string): Promise<unknown[]>; health(): Promise<{ latencyMs: number | null }> }
const stub = (id: string): CommerceConnector => ({ id, mode: 'STUB', search: async () => [], health: async () => ({ latencyMs: null }) });
export const connectors: CommerceConnector[] = ['serpapi-google', 'shopee', 'lazada', 'supplier-feed'].map(stub);
// Roadmap (not built): a policy-gated settlement hook on a DEX. Nothing of the kind exists in this repo.
