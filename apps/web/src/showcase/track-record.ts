// Counts for the landing's "on-chain track record" band, taken from the committed BlindBook event history
// (src/data/blindbook-history.json, written by tools/market-snapshot.ts from the chain). Nothing here is estimated.
export type HistoryEvent = { e: string; b: number; a?: Record<string, string> };
export type TrackRecord = { rounds: number; bids: number; reveals: number; fills: number; bidders: number; headBlock: number };

export function trackRecord(events: HistoryEvent[], head: number): TrackRecord {
  const count = (name: string) => events.filter((x) => x.e === name).length;
  const bidders = new Set(events.filter((x) => x.e === 'Committed' && x.a?.trader).map((x) => x.a!.trader.toLowerCase()));
  return { rounds: count('EpochCleared'), bids: count('Committed'), reveals: count('Revealed'), fills: count('Fill'), bidders: bidders.size, headBlock: head };
}

/** 1688 -> "1,688" */
export const fmtInt = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
