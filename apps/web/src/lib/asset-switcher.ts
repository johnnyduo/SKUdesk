// Pure logic of the /market asset switcher (no React, no imports): market order and category groups from the catalog, display strings,
// keyboard index moves, typeahead, the screen-reader announcement, the sparkline polyline and the URL-hash rule. Used by
// components/market/AssetSwitcher.tsx and lib/market-app.ts; tested by test/market/asset-switcher.test.ts.

export type Dir = 'up' | 'down' | 'flat';
/** Formatting is injected so the switcher shows exactly the strings the rest of the terminal shows (mk-fmt usd / pctStr). */
export type Fmt = { usd: (cents: number) => string; pct: (fraction: number) => string };
/** The fields of a store market (MarketInfo) the switcher reads. */
export type SwitcherMarket = { symbol: string; name: string; subtitle: string; category: string; accent: string; marketId: string; last: number; change: number; prices: number[] };
/** What the price cell says: still loading (no price, no claim), loaded with no trade, or a last cleared price. */
export type PriceState = 'loading' | 'none' | 'traded';
export type SwitcherItem = {
  /** catalog index: the argument of selectMarket(i) and the position in the URL-hash lookup */
  index: number; symbol: string; name: string; subtitle: string; category: string; accent: string; marketId: string;
  state: PriceState; last: number; points: number; priceText: string; changeText: string; dir: Dir; spark: string;
};
/** One category group of the listbox: its label, the flat position of its first option and its options. */
export type SwitcherGroup = { category: string; start: number; items: SwitcherItem[] };

export const NO_TRADE = 'no trade yet';
export const PRICE_LOADING = '...';
export const SPARK_W = 52;
export const SPARK_H = 20;
export const TYPEAHEAD_RESET_MS = 500;
/** PageUp / PageDown move this many options (WAI-ARIA APG listbox). */
export const PAGE_STEP = 10;

export const dirOf = (f: number): Dir => (f > 0 ? 'up' : f < 0 ? 'down' : 'flat');

/** The small tag a category earns next to the symbol: Accessories (phone cases) are never mistaken for the phones. */
export const tagOf = (category: string): string => (category === 'Accessories' ? 'Accessory' : '');

/** Store markets in catalog order, each with its catalog index. A catalog entry missing from the store is skipped, never invented. */
export function orderedMarkets<M extends { symbol: string }>(catalog: readonly { symbol: string }[], markets: readonly M[]): { index: number; market: M }[] {
  const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
  const out: { index: number; market: M }[] = [];
  catalog.forEach((c, index) => { const market = bySymbol.get(c.symbol); if (market) out.push({ index, market }); });
  return out;
}

/** Same polyline as the asset list's sparkline (2 px inset, 3 px top/bottom room). Fewer than two prices: '' (draw a flat dash). */
export function sparkPoints(prices: readonly number[], w = SPARK_W, h = SPARK_H): string {
  if (prices.length < 2) return '';
  const lo = Math.min(...prices), hi = Math.max(...prices), sp = hi - lo || 1;
  return prices.map((p, i) => `${(2 + (i / (prices.length - 1)) * (w - 4)).toFixed(1)},${(h - 3 - ((p - lo) / sp) * (h - 6)).toFixed(1)}`).join(' ');
}

/** Change text with the asset list's rule: two or more trades -> signed %, one trade -> 0.00%, no trade -> ''. */
export function changeText(m: Pick<SwitcherMarket, 'last' | 'change' | 'prices'>, fmt: Fmt): string {
  const traded = m.last > 0;
  return traded && m.prices.length > 1 ? fmt.pct(m.change) : traded ? fmt.pct(0) : '';
}

/**
 * Everything one trigger or option row shows, for every catalog market, ordered by category group (first appearance in the catalog,
 * the catalog's own order when its categories are contiguous). `loaded` is the terminal's own rule (ready and no total load failure):
 * until then no market shows a price or a "no trade" claim. `pointsOf(marketId)` = traded clear points of that market.
 */
export function toItems(catalog: readonly { symbol: string; category: string }[], markets: readonly SwitcherMarket[], pointsOf: (marketId: string) => number, fmt: Fmt, loaded: boolean): SwitcherItem[] {
  const rank = new Map<string, number>(); catalog.forEach((c) => { if (!rank.has(c.category)) rank.set(c.category, rank.size); });
  return orderedMarkets(catalog, markets)
    .map(({ index, market: m }) => {
      const state: PriceState = !loaded ? 'loading' : m.last > 0 ? 'traded' : 'none';
      return {
        index, symbol: m.symbol, name: m.name, subtitle: m.subtitle, category: catalog[index].category, accent: m.accent, marketId: m.marketId,
        state, last: m.last, points: pointsOf(m.marketId),
        priceText: state === 'loading' ? PRICE_LOADING : state === 'traded' ? fmt.usd(m.last) : NO_TRADE,
        changeText: state === 'traded' ? changeText(m, fmt) : '', dir: state === 'traded' ? dirOf(m.change) : 'flat', spark: state === 'traded' ? sparkPoints(m.prices) : '',
      } satisfies SwitcherItem;
    })
    .sort((a, b) => (rank.get(a.category) ?? 0) - (rank.get(b.category) ?? 0) || a.index - b.index);
}

/** The listbox groups: items (already ordered by toItems) split by category, each with the flat position of its first option. */
export function groupItems(items: readonly SwitcherItem[]): SwitcherGroup[] {
  const out: SwitcherGroup[] = [];
  items.forEach((it, pos) => {
    const g = out[out.length - 1];
    if (g && g.category === it.category) g.items.push(it); else out.push({ category: it.category, start: pos, items: [it] });
  });
  return out;
}

/** Listbox navigation (WAI-ARIA select-only combobox): Down/Up move one and stop at the ends, Home/End jump, PageUp/PageDown move a page. Other keys: null. */
export function moveIndex(current: number, key: string, n: number): number | null {
  if (n <= 0) return null;
  switch (key) {
    case 'ArrowDown': return Math.min(n - 1, current + 1);
    case 'ArrowUp': return Math.max(0, current - 1);
    case 'PageDown': return Math.min(n - 1, current + PAGE_STEP);
    case 'PageUp': return Math.max(0, current - PAGE_STEP);
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

type Matchable = { symbol: string; name: string; subtitle?: string };
const startsWith = (it: Matchable, needle: string) =>
  it.symbol.toLowerCase().startsWith(needle) || it.name.toLowerCase().startsWith(needle) || (it.subtitle ?? '').toLowerCase().startsWith(needle);

/**
 * Typeahead over symbol, name and subtitle prefixes (case-insensitive), across all groups. Characters typed within `resetMs` of each
 * other form one search string; repeating a single character cycles through the matches (APG). `now` is injected for tests.
 */
export function createTypeahead(resetMs = TYPEAHEAD_RESET_MS, now: () => number = () => Date.now()) {
  let buf = ''; let at = -Infinity;
  return {
    /** Feeds one printable key; returns the position to make active, or null when nothing matches. */
    key(ch: string, items: readonly Matchable[], current: number): number | null {
      const t = now(); if (t - at > resetMs) buf = ''; at = t;
      const c = ch.toLowerCase(); buf += c;
      const n = items.length; if (!n) return null;
      const repeated = buf.length > 1 && [...buf].every((x) => x === c);
      const needle = repeated ? c : buf;
      const start = buf.length === 1 || repeated ? current + 1 : current;
      for (let k = 0; k < n; k++) { const i = (((start + k) % n) + n) % n; if (startsWith(items[i], needle)) return i; }
      return null;
    },
    /** True while a search string is being typed (Space then belongs to the search, not to "select"). */
    typing(): boolean { return buf !== '' && now() - at <= resetMs; },
    reset(): void { buf = ''; at = -Infinity; },
  };
}

/** The one polite announcement after a switch, e.g. "Selected IP18P, last price $10.59" or "Selected PX9-CLR, no trade yet". */
export function announceText(m: { symbol: string; last: number }, loaded: boolean, fmt: Pick<Fmt, 'usd'>): string {
  if (!loaded) return `Selected ${m.symbol}, price loading`;
  return m.last > 0 ? `Selected ${m.symbol}, last price ${fmt.usd(m.last)}` : `Selected ${m.symbol}, ${NO_TRADE}`;
}

/**
 * The text to put into the aria-live region. A live region only speaks when its text node changes, so choosing the market that is
 * already selected (same sentence) alternates a trailing no-break space: the node mutates, the sentence stays the same for readers
 * and for text matching (\s covers U+00A0).
 */
export function nextAnnouncement(prev: string, text: string): string {
  return prev === text ? text + '\u00a0' : text;
}

/** URL hash -> the symbol it names, percent-decoded. '' when empty or malformed (a bad percent-escape used to throw in market-app). */
export function symbolFromHash(hash: string): string {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  try { return decodeURIComponent(h); } catch { return ''; }
}

/** URL hash -> catalog index. Unknown, empty or malformed hashes fall back to the first market. */
export function indexFromHash(hash: string, symbols: readonly string[]): number {
  const i = symbols.indexOf(symbolFromHash(hash));
  return i >= 0 ? i : 0;
}
