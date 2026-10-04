// One vocabulary for "where does this number come from", used by every page that shows a price, a status or a proof.
// Keep the labels exactly as written: the submission docs quote them.
export type Provenance = 'onchain' | 'live' | 'snapshot' | 'test' | 'agent';
export const PROVENANCE: Record<Provenance, { label: string; tip: string }> = {
  onchain: { label: 'ONCHAIN', tip: 'On Robinhood Chain Testnet: read from a contract, or a saved transaction you can open on the block explorer.' },
  live: { label: 'LIVE SOURCE', tip: 'Fetched from a live data source by the Worker, with the time it was seen.' },
  snapshot: { label: 'FIXED SNAPSHOT', tip: 'Values saved at one point in time. They do not update.' },
  test: { label: 'TEST DATA', tip: 'Placeholder values: the real source is not connected yet.' },
  agent: { label: 'AGENT ATTESTED', tip: 'Reported by the agent. The contract does not verify it.' },
};
