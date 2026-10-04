// The /market catalog contract (src/data/catalog.json): what every market entry holds and the checks that keep every market
// distinct, honest about its reference price, URL-safe and decodable by the deploy script. Pure (no imports). Used by market.ts
// (types), the asset switcher and asset list (categories), products.ts, the keeper tools (lot sizes) and test/market/catalog.test.ts.

/**
 * Display categories, in the order the switcher groups them. A new category must be added here (and get a 3D kind in product3d/specs.ts).
 * 'Accessories' is the secondary category (the six phone cases of the first book) and always comes last, after the main products.
 */
export const CATEGORIES = ['Phones', 'Audio', 'Gaming', 'Computing', 'Wearables', 'Accessories'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Order sizes (units per order) by bot role. 'bulk' is the original strategy (cheap items; the keeper-bots.json fingerprint of the first
 * book was taken with it); 'unit' keeps the cash a bot locks per order bounded for devices that cost hundreds of dollars.
 */
export const LOTS = {
  bulk: { maker: [8, 24], taker: [4, 14], noise: [3, 12] },
  unit: { maker: [1, 3], taker: [1, 2], noise: [1, 2] },
} as const satisfies Record<string, Record<'maker' | 'taker' | 'noise', readonly [number, number]>>;
export type Lot = keyof typeof LOTS;
/** The largest order a maker may place, in cents of reference value: above it a market must use the 'unit' lot. */
export const MAX_ORDER_CENTS = 500_000;
/** The lot a reference price requires: 'bulk' while its largest maker order stays within MAX_ORDER_CENTS, 'unit' otherwise. */
export const lotFor = (referenceCents: number): Lot => (LOTS.bulk.maker[1] * referenceCents <= MAX_ORDER_CENTS ? 'bulk' : 'unit');

/**
 * One catalog market. `subtitle` is the second line every UI shows under the name ("Apple smartphone"; for an Accessory what it is and
 * what it fits: "Clear MagSafe case for iPhone 16 Pro"). `referenceCents` is the manufacturer's US list price on the date `priceBasis`
 * names ("US list price, as of Oct 2026"), or for an Accessory a fixed catalog reference (ACCESSORY_PRICE_BASIS): a fixed reference the
 * bots quote around, never a live or current price.
 */
export type CatalogEntry = {
  id: string; symbol: string; name: string; category: Category; subtitle: string;
  referenceCents: number; priceBasis: string; lot: Lot; tick: number; accent: string; source: string;
};

/** Every entry has exactly these keys. packages/contracts/script/DeployBook.s.sol decodes them in this (alphabetical) order. */
export const CATALOG_KEYS = ['accent', 'category', 'id', 'lot', 'name', 'priceBasis', 'referenceCents', 'source', 'subtitle', 'symbol', 'tick'] as const;
/** The URL hash is the symbol (#IP18P): upper-case letters and digits in hyphen-separated groups, 3-12 characters, never percent-encoded. */
export const SYMBOL_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const ID_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const ACCENT_RE = /^#[0-9a-f]{6}$/;
/** "US list price, as of Oct 2026": the only accepted price basis (a fixed US list price, with the month it was read). */
export const PRICE_BASIS_RE = /^US list price, as of (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 20\d\d$/;
/** Main categories list devices, never accessories for them: no main-category name or subtitle mentions a case or cover. Accessories must. */
export const ACCESSORY_RE = /\b(case|cases|cover|covers)\b/i;
/** The category whose entries are cases or covers; the only one allowed (and required) to name one. */
export const ACCESSORY_CATEGORY = 'Accessories';
/** An Accessory's subtitle says what it is and the device it fits: "Clear MagSafe case for iPhone 16 Pro". */
export const ACCESSORY_SUBTITLE_RE = /\b(case|cases|cover|covers)\b.* for [A-Za-z0-9]/i;
/** The only price basis an Accessory may carry: the case prices were never a manufacturer list price. */
export const ACCESSORY_PRICE_BASIS = 'Catalog reference price (fixed snapshot, not a live feed)';
/** BlindBook.MAX_PRICE_CENTS: a reveal above it reverts, so a reference price must stay well below. */
export const MAX_REFERENCE_CENTS = 1_000_000;
/** validateSnapshot's LIMITS.markets. */
export const MAX_MARKETS = 64;
const SOURCES = ['snapshot', 'catalog'];

export const isCategory = (c: unknown): c is Category => typeof c === 'string' && (CATEGORIES as readonly string[]).includes(c);
export const isLot = (l: unknown): l is Lot => typeof l === 'string' && Object.prototype.hasOwnProperty.call(LOTS, l);

/** Problems with a catalog's market list (empty = valid). Messages name the market so a failing test points at the line. */
export function validateCatalog(markets: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(markets) || markets.length === 0) return ['markets must be a non-empty array'];
  if (markets.length > MAX_MARKETS) out.push(`at most ${MAX_MARKETS} markets (snapshot validation limit), got ${markets.length}`);
  const seen = { id: new Set<string>(), symbol: new Set<string>(), accent: new Set<string>() };
  // accents are unique within a category: the six cases keep the accents they had on the first book, which the first six products share
  const accentKey = (m: any) => `${m.category}|${String(m.accent).toLowerCase()}`;
  markets.forEach((m: any, i: number) => {
    const at = `market ${i} (${typeof m?.symbol === 'string' ? m.symbol : '?'})`;
    if (!m || typeof m !== 'object') { out.push(`${at}: not an object`); return; }
    const keys = Object.keys(m).sort().join(',');
    if (keys !== [...CATALOG_KEYS].sort().join(',')) out.push(`${at}: keys must be exactly ${CATALOG_KEYS.join(',')} (got ${keys})`);
    if (typeof m.id !== 'string' || !ID_RE.test(m.id) || m.id.length > 48) out.push(`${at}: id must match ${ID_RE} (<= 48 chars)`);
    if (typeof m.symbol !== 'string' || !SYMBOL_RE.test(m.symbol) || m.symbol.length < 3 || m.symbol.length > 12 || encodeURIComponent(m.symbol) !== m.symbol) out.push(`${at}: symbol must match ${SYMBOL_RE}, 3-12 chars, URL-safe`);
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80) out.push(`${at}: name must be 1-80 chars`);
    if (!isCategory(m.category)) out.push(`${at}: unknown category ${JSON.stringify(m.category)}`);
    if (typeof m.subtitle !== 'string' || !m.subtitle.trim() || m.subtitle.length > 48) out.push(`${at}: subtitle must be 1-48 chars`);
    const accessory = m.category === ACCESSORY_CATEGORY;
    if (accessory) {
      if (typeof m.name === 'string' && !ACCESSORY_RE.test(m.name)) out.push(`${at}: name must say case or cover (an Accessory is never presented as the device)`);
      if (typeof m.subtitle === 'string' && !ACCESSORY_SUBTITLE_RE.test(m.subtitle)) out.push(`${at}: subtitle must say what it is and what it fits, like "Clear MagSafe case for iPhone 16 Pro"`);
      if (m.priceBasis !== ACCESSORY_PRICE_BASIS) out.push(`${at}: priceBasis must read "${ACCESSORY_PRICE_BASIS}"`);
    } else {
      for (const k of ['name', 'subtitle'] as const) if (typeof m[k] === 'string' && ACCESSORY_RE.test(m[k])) out.push(`${at}: ${k} names an accessory (case/cover); only the ${ACCESSORY_CATEGORY} category lists those`);
      if (typeof m.priceBasis !== 'string' || !PRICE_BASIS_RE.test(m.priceBasis)) out.push(`${at}: priceBasis must read "US list price, as of <Mon> <year>"`);
    }
    if (!Number.isSafeInteger(m.tick) || m.tick < 1) out.push(`${at}: tick must be a positive integer`);
    if (!Number.isSafeInteger(m.referenceCents) || m.referenceCents <= 0 || m.referenceCents > MAX_REFERENCE_CENTS) out.push(`${at}: referenceCents must be a positive integer <= ${MAX_REFERENCE_CENTS}`);
    else {
      if (Number.isSafeInteger(m.tick) && m.tick >= 1 && m.referenceCents % m.tick !== 0) out.push(`${at}: referenceCents must be a multiple of tick`);
      if (!isLot(m.lot)) out.push(`${at}: lot must be one of ${Object.keys(LOTS).join(', ')}`);
      else if (m.lot !== lotFor(m.referenceCents)) out.push(`${at}: lot must be ${lotFor(m.referenceCents)} for a ${m.referenceCents}-cent reference (largest maker order <= ${MAX_ORDER_CENTS} cents)`);
    }
    if (typeof m.accent !== 'string' || !ACCENT_RE.test(m.accent)) out.push(`${at}: accent must be #rrggbb (lower case)`);
    if (!SOURCES.includes(m.source)) out.push(`${at}: source must be one of ${SOURCES.join(', ')}`);
    for (const k of ['id', 'symbol', 'accent'] as const) {
      if (typeof m[k] !== 'string') continue;
      const v = k === 'accent' ? accentKey(m) : m[k].toLowerCase();
      if (seen[k].has(v)) out.push(`${at}: duplicate ${k} ${m[k]}`); else seen[k].add(v);
    }
  });
  return out;
}

/** Categories present in a market list, in CATEGORIES order (the switcher's groups and the asset list's chips). */
export function categoriesOf(markets: readonly { category: string }[]): Category[] {
  const present = new Set(markets.map((m) => m.category));
  return CATEGORIES.filter((c) => present.has(c));
}
