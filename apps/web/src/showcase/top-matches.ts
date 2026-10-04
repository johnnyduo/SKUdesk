// Which products the hero ring shows, and which one (if any) is the recorded on-chain run.
// Pure on purpose: no engine import, so Node can test it.

export type MatchOpp = {
  id: string; productId: string; title: string; buy: string; sell: string;
  buyCents: number; sellCents: number; netCents: number; marginBps: number;
};
export type RecordedRun = { productId: string; buyCents: number; sellCents: number; netCents: number; marginBps: number };
export type ShowcaseItem<T extends MatchOpp = MatchOpp> = T & { rank: number; recorded: boolean };

export function topMatches<T extends MatchOpp>(opps: T[], recorded: RecordedRun | null, n: number): ShowcaseItem<T>[] {
  const limit = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  if (!limit) return [];
  const best = new Map<string, T>(); // one entry per product, best margin wins
  for (const o of opps) {
    const cur = best.get(o.productId);
    if (!cur || o.marginBps > cur.marginBps) best.set(o.productId, o);
  }
  const isRecorded = (o: T) => !!recorded && o.productId === recorded.productId && o.buyCents === recorded.buyCents && o.sellCents === recorded.sellCents
    && o.netCents === recorded.netCents && o.marginBps === recorded.marginBps;
  const ranked = [...best.values()].sort((a, b) => Number(isRecorded(b)) - Number(isRecorded(a)) || b.marginBps - a.marginBps || a.id.localeCompare(b.id));
  return ranked.slice(0, limit).map((o, i) => ({ ...o, rank: i + 1, recorded: isRecorded(o) }));
}
