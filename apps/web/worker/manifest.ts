// Build manifest of static landing pages (/p/<sku>/), emitted by Astro at /p/manifest.json.
// The Worker refuses to publish listings whose link/image/price do not match a page in this manifest.
import { sameGtin } from './gtin.ts';

export type ManifestEntry = {
  sku: string;
  path: string;
  imagePath: string;
  title: string;
  brand: string;
  gtin: string | null;
  priceCents: number;
  currency: 'USD';
  availability: 'IN_STOCK';
  compat: string;
  color: string;
  magSafe: boolean;
  pack: number;
};
export type SkuManifest = { version: 1; origin: string; entries: ManifestEntry[] };
export type ManifestCheck = { ok: true; entry: ManifestEntry } | { ok: false; reason: string };
export type AssetsFetcher = { fetch(req: Request): Promise<Response> };

export const MANIFEST_PATH = '/p/manifest.json';

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

function isEntry(e: unknown): e is ManifestEntry {
  const o = e as Record<string, unknown>;
  return typeof o === 'object' && o !== null
    && typeof o.sku === 'string' && typeof o.path === 'string' && typeof o.imagePath === 'string'
    && typeof o.title === 'string' && typeof o.brand === 'string' && (o.gtin === null || typeof o.gtin === 'string')
    && typeof o.priceCents === 'number' && Number.isSafeInteger(o.priceCents) && o.currency === 'USD'
    && o.availability === 'IN_STOCK' && typeof o.compat === 'string' && typeof o.color === 'string'
    && typeof o.magSafe === 'boolean' && typeof o.pack === 'number';
}

export function parseManifest(raw: unknown): SkuManifest | null {
  const o = raw as Record<string, unknown>;
  if (typeof o !== 'object' || o === null || o.version !== 1 || typeof o.origin !== 'string' || !Array.isArray(o.entries)) return null;
  if (!o.entries.every(isEntry)) return null;
  return { version: 1, origin: o.origin, entries: o.entries as ManifestEntry[] };
}

export function findByPath(m: SkuManifest, pathname: string): ManifestEntry | undefined {
  const want = trimSlash(pathname);
  return m.entries.find((e) => trimSlash(e.path) === want);
}

export function findBySku(m: SkuManifest, sku: string): ManifestEntry | undefined {
  return m.entries.find((e) => e.sku === sku);
}

export function findByGtin(m: SkuManifest, gtin: string): ManifestEntry | undefined {
  return m.entries.find((e) => e.gtin !== null && sameGtin(e.gtin, gtin));
}

export function checkListingAgainstManifest(m: SkuManifest | null, link: string, imageLink: string, priceCents: number): ManifestCheck {
  if (!m) return { ok: false, reason: 'build manifest unavailable; deploy the site build first' };
  const entry = findByPath(m, new URL(link).pathname);
  if (!entry) return { ok: false, reason: 'link is not a landing page in the build manifest' };
  if (new URL(imageLink).pathname !== entry.imagePath) return { ok: false, reason: 'imageLink must be the landing page image ' + entry.imagePath };
  if (priceCents !== entry.priceCents) return { ok: false, reason: 'priceCents must equal the landing page price ' + entry.priceCents };
  return { ok: true, entry };
}

export async function loadManifest(assets: AssetsFetcher, requestUrl: string): Promise<SkuManifest | null> {
  try {
    const res = await assets.fetch(new Request(new URL(MANIFEST_PATH, requestUrl).toString()));
    if (!res.ok) return null;
    return parseManifest(await res.json());
  } catch {
    return null;
  }
}
