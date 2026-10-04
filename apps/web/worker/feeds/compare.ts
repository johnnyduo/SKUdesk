// Identity gating + per-source best price + cross-source spread. Pure; integer cents only.
// Only offers that pass the hard identity gates (packages/matching) and the GTIN/condition checks count.
import { matchOffer, normalize } from '../../../../packages/matching/index.ts';
import type { CacheState, CompareFlag, CompareResult, GatedOffer, SourceSummary, Spread } from '../api-types.ts';
import { sameGtin } from '../gtin.ts';
import type { ManifestEntry } from '../manifest.ts';
import type { FeedMode, FeedOffer, FeedQuery } from './types.ts';

export type Canon = {
  brand: string;
  model: string;
  compatibility: string;
  color: string;
  packCount: number;
  gtin: string | undefined;
  attributes: { magsafe: 'Yes' | 'No' };
};
export type SourceRun = {
  id: string;
  label: string;
  attribution: string;
  configured: boolean;
  mode: FeedMode;
  cache: CacheState;
  offers: FeedOffer[];
  error: string | null;
  quotaRemaining: number | null;
};

export function canonFromEntry(e: ManifestEntry): Canon {
  return { brand: e.brand, model: e.title, compatibility: e.compat, color: e.color, packCount: e.pack, gtin: e.gtin ?? undefined, attributes: { magsafe: e.magSafe ? 'Yes' : 'No' } };
}

// Keyword-sourced offers (SerpApi/SearchApi titles, no exact GTIN) have no identity evidence beyond the title, and
// packages/matching lets a title with NO colour word pass its colour gate. So for those offers we additionally need
// POSITIVE colour evidence and no obvious different form factor. GTIN-matched offers are never screened this way.
const CLEAR_WORDS = ['clear', 'transparent', 'translucent', 'crystal', 'see through'];
const FORM_CONFLICTS: { label: string; re: RegExp }[] = [
  { label: 'hard-shell', re: /(?:^| )(?:hard shell|hardshell)(?: |$)/ },
  { label: 'silicone', re: /(?:^| )silicone(?: |$)/ },
  { label: 'leather', re: /(?:^| )leather(?: |$)/ },
  { label: 'wallet', re: /(?:^| )wallet(?: |$)/ },
  { label: 'folio', re: /(?:^| )folio(?: |$)/ },
  { label: 'battery', re: /(?:^| )(?:battery|batteries)(?: |$)/ },
  { label: 'kickstand', re: /(?:^| )kickstand(?: |$)/ },
  { label: 'rugged', re: /(?:^| )rugged(?: |$)/ },
  { label: 'armor', re: /(?:^| )(?:armor|armour)(?: |$)/ },
  { label: 'glitter', re: /(?:^| )glitter(?: |$)/ },
  { label: 'liquid', re: /(?:^| )liquid(?: |$)/ },
  // Grip / stand / accessory bundles (a PopSockets PopCase is a case with a built-in swappable grip, not a plain clear TPU case).
  { label: 'popsockets', re: /(?:^| )popsockets?(?: |$)/ },
  { label: 'popcase', re: /(?:^| )popcase(?: |$)/ },
  { label: 'popgrip', re: /(?:^| )popgrip(?: |$)/ },
  { label: 'pop socket', re: /(?:^| )pop socket(?: |$)/ },
  { label: 'grip', re: /(?:^| )grip(?: |$)/ },
  { label: 'ring holder', re: /(?:^| )ring holder(?: |$)/ },
  { label: 'stand', re: /(?:^| )stand(?: |$)/ },
  { label: 'lanyard', re: /(?:^| )lanyard(?: |$)/ },
  { label: 'strap', re: /(?:^| )strap(?: |$)/ },
  { label: 'charm', re: /(?:^| )charm(?: |$)/ },
  { label: 'customizable', re: /(?:^| )customiz\w*(?: |$)/ },
  // "Package" only as a leading bundle marker ("Package - PopSockets - ..."), never mid-title ("... Retail Package").
  { label: 'package', re: /^package(?: |$)/ },
];
const hasWord = (hay: string, w: string) => (' ' + hay + ' ').includes(' ' + w + ' ');

function keywordEvidenceReasons(canon: Canon, title: string): string[] {
  const reasons: string[] = [];
  const t = normalize(title);
  const color = normalize(canon.color);
  if (color) {
    const isClear = color === 'clear';
    const words = isClear ? CLEAR_WORDS : [color];
    if (!words.some((w) => hasWord(t, w))) reasons.push('color: title does not show ' + (isClear ? 'clear/transparent' : canon.color.toLowerCase()));
  }
  const model = normalize(canon.model);
  for (const f of FORM_CONFLICTS) {
    if (f.re.test(t) && !f.re.test(model)) reasons.push('form: title says ' + f.label + ' but the canonical product is not');
  }
  return reasons;
}

export function gateOffer(canon: Canon | null, q: FeedQuery, o: FeedOffer): GatedOffer {
  const reasons: string[] = [];
  if (o.condition === 'USED' || o.condition === 'REFURB') reasons.push('condition: expected NEW, observed ' + o.condition);
  if (!(o.priceCents > 0)) reasons.push('price: non-positive price ' + o.priceCents);
  if (q.gtin && o.gtin && !sameGtin(q.gtin, o.gtin)) reasons.push('gtin: expected ' + q.gtin + ', observed ' + o.gtin);
  if (canon) {
    // packages/matching's compatibility gate only distinguishes iPhone 16 variants, so the title must also name the device.
    if (!normalize(o.title).includes(normalize(canon.compatibility))) reasons.push('compatibility: title does not name ' + canon.compatibility);
    // GTIN is compared above as GTIN-14, so matchOffer runs title/attribute gates only.
    reasons.push(...matchOffer(canon, { title: o.title, attributes: {} }).rejectReasons);
    if (!(q.gtin && o.gtinMatched)) reasons.push(...keywordEvidenceReasons(canon, o.title));
  } else if (!(q.gtin && o.gtinMatched)) {
    reasons.push('identity: no catalog product and no exact GTIN match');
  }
  return { ...o, locked: reasons.length === 0, rejectReasons: reasons, totalCents: o.priceCents + (o.shipCents ?? 0) };
}

export function summarize(run: SourceRun, gated: GatedOffer[]): SourceSummary {
  const locked = gated.filter((g) => g.locked).sort((a, b) => a.totalCents - b.totalCents);
  const best = locked[0] ?? null;
  return {
    id: run.id, label: run.label, attribution: run.attribution, configured: run.configured, mode: run.mode, cache: run.cache,
    offers: gated.length, locked: locked.length, bestCents: best ? best.totalCents : null, bestUrl: best && best.url ? best.url : null,
    observedAt: best ? best.observedAt : null, error: run.error, quotaRemaining: run.quotaRemaining,
  };
}

// Spread is computed within one honesty class: real-data sources if any have a best price, else test-data sources.
export function spreadOf(sources: SourceSummary[]): Spread | null {
  const real = sources.filter((s) => s.mode !== 'MOCK' && s.bestCents !== null);
  const basis: 'REAL' | 'MOCK' = real.length ? 'REAL' : 'MOCK';
  const pool = (real.length ? real : sources.filter((s) => s.mode === 'MOCK' && s.bestCents !== null)).map((s) => s.bestCents as number);
  if (pool.length < 2) return null;
  const minCents = Math.min(...pool);
  const maxCents = Math.max(...pool);
  const deltaCents = maxCents - minCents;
  return { minCents, maxCents, deltaCents, deltaBps: minCents > 0 ? Math.floor((deltaCents * 10000) / minCents) : 0, basis, sources: pool.length };
}

export function buildCompare(q: FeedQuery, entry: ManifestEntry | null, runs: SourceRun[], nowMs: number): CompareResult {
  const canon = entry ? canonFromEntry(entry) : null;
  const sources: SourceSummary[] = [];
  const offers: GatedOffer[] = [];
  for (const run of runs) {
    const gated = run.offers.map((o) => gateOffer(canon, q, o));
    sources.push(summarize(run, gated));
    offers.push(...gated.sort((a, b) => Number(b.locked) - Number(a.locked) || a.totalCents - b.totalCents).slice(0, 5));
  }
  const spread = spreadOf(sources);
  const flags: CompareFlag[] = [];
  if (!q.gtin) flags.push('gtin_unavailable');
  if (!entry) flags.push('no_canonical');
  if (!spread) flags.push('single_source');
  if (sources.some((s) => s.cache === 'STALE')) flags.push('stale_cache');
  if (sources.some((s) => s.error === 'quota_exhausted')) flags.push('quota_exhausted');
  if (sources.every((s) => s.mode === 'MOCK')) flags.push('all_mock');
  if (sources.every((s) => s.locked === 0)) flags.push('no_locked_offers');
  return {
    query: q,
    canonical: entry ? { sku: entry.sku, title: entry.title, priceCents: entry.priceCents } : null,
    sources, spread, flags, offers, generatedAt: new Date(nowMs).toISOString(),
  };
}
