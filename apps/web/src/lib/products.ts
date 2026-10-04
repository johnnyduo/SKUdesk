// Asset list for the market terminal. A ProductSource returns the products that can be traded; today that is our own catalog fixture.
// A Google Merchant API adapter would implement the same interface once credentials exist (Merchant API `products.list` returns the
// merchant's OWN products; it is a catalog source, not a market-price feed). Prices never come from here: they come from the book.
import { keccak256, toHex, type Hex } from 'viem';
import { lotFor, type Lot } from './catalog.ts';

/** Fields as in src/lib/catalog.ts. A Merchant product has no catalog category until someone assigns one (''). */
export type Product = { id: string; marketId: Hex; symbol: string; name: string; category: string; subtitle: string; referenceCents: number; priceBasis: string; lot: Lot; tick: number; accent: string; source: 'snapshot' | 'catalog' | 'merchant' };
export interface ProductSource { readonly name: string; list(): Promise<Product[]> }

type CatalogJson = { markets: { id: string; symbol: string; name: string; category: string; subtitle: string; referenceCents: number; priceBasis: string; lot: Lot; tick: number; accent: string; source: string }[] };

/** Reads the bundled catalog fixture (apps/web/src/data/catalog.json). */
export class CatalogSource implements ProductSource {
  readonly name = 'catalog fixture';
  private readonly json: CatalogJson;
  constructor(json: CatalogJson) { this.json = json; } // plain assignment: Node's type-stripping does not support parameter properties
  async list(): Promise<Product[]> {
    return this.json.markets.map((m) => ({ ...m, marketId: keccak256(toHex(m.id)), source: (m.source === 'snapshot' ? 'snapshot' : 'catalog') as Product['source'] }));
  }
}

/** Shape a Google Merchant API product must be mapped to. Not wired: no credentials exist in this project today. */
export type MerchantProduct = { name: string; offerId: string; title: string; price: { amountMicros: string; currencyCode: string }; attributes?: Record<string, string> };
export function fromMerchantProduct(p: MerchantProduct, accent = '#ccff00'): Omit<Product, 'marketId'> & { marketId: Hex } {
  if (p.price.currencyCode !== 'USD') throw new Error('USD only in v1 (no FX handling)');
  const referenceCents = Math.round(Number(p.price.amountMicros) / 10_000); // micros -> cents, integer math at the boundary
  return { id: p.offerId, marketId: keccak256(toHex(p.offerId)), symbol: p.offerId.slice(0, 10).toUpperCase(), name: p.title, category: '', subtitle: p.attributes?.brand ?? '', referenceCents, priceBasis: 'merchant offer price', lot: lotFor(referenceCents), tick: 1, accent, source: 'merchant' };
}
