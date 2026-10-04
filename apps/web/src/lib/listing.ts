// Landing-page data for /p/<sku>/ and the build manifest the Worker checks before publishing to Google Merchant.
// One source of truth: the page price and the listing price both come from listPriceCents().
import { CATALOG, type Product } from './engine';
import { casePngSrc } from '../components/commerce/images';
import { isValidGtin } from '../../worker/gtin.ts';
import type { ManifestEntry, SkuManifest } from '../../worker/manifest.ts';

export const SITE_ORIGIN = 'https://skudesk.lol';
export const BRAND = 'SKUdesk';

// The demo catalog's GTINs are generated placeholders, not GS1-assigned codes, so they are never published or
// used for price lookups. Add real assigned GTINs here (sku -> GTIN) when the store has them.
export const ASSIGNED_GTINS: Record<string, string> = {};

// Store policies Merchant Center requires on the landing page. null = not configured (shown as such on the page;
// Google will disapprove listings until a real returns policy and contact are set).
export const STORE_POLICY: { returnsUrl: string | null; contactEmail: string | null } = { returnsUrl: null, contactEmail: null };

export function listPriceCents(p: Product): number {
  return 899 + (p.magSafe ? 200 : 0) + (p.pack === 2 ? 600 : 0);
}

export function skuPath(p: Product): string {
  return '/p/' + p.id + '/';
}

export function assignedGtin(p: Product): string | null {
  const g = ASSIGNED_GTINS[p.id];
  return g && isValidGtin(g) ? g : null;
}

export function manifestEntry(p: Product): ManifestEntry {
  return {
    sku: p.id, path: skuPath(p), imagePath: casePngSrc(p), title: p.model, brand: BRAND, gtin: assignedGtin(p),
    priceCents: listPriceCents(p), currency: 'USD', availability: 'IN_STOCK', compat: p.compat, color: p.color, magSafe: p.magSafe, pack: p.pack,
  };
}

export function buildManifest(): SkuManifest {
  return { version: 1, origin: SITE_ORIGIN, entries: CATALOG.products.map(manifestEntry) };
}

export const fmtPrice = (cents: number) => '$' + (cents / 100).toFixed(2);
