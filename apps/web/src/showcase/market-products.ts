// The products on the hero ring (besides the on-chain run): a pick from the market's product list.
// Prices are US list-price references (not live quotes, not street prices); on /market, agents trade around them with test tokens.
// Integer cents. The list follows the market's approved product list; update here when the market's list changes.
export type MarketProduct = { symbol: string; name: string; category: 'Phones' | 'Audio' | 'Gaming' | 'Computing' | 'Wearables'; listCents: number; art: string };

/** In ring order after the on-chain run (a phone case): neighbours differ in category, and neither end is a phone, so the ring reads as a mix. */
export const MARKET_PRODUCTS: MarketProduct[] = [
  { symbol: 'APP3', name: 'AirPods Pro 3', category: 'Audio', listCents: 24900, art: '/img/showcase/earbuds.svg' },
  { symbol: 'IP18P', name: 'iPhone 18 Pro (256 GB)', category: 'Phones', listCents: 119900, art: '/img/showcase/phone-pro.svg' },
  { symbol: 'NSW2', name: 'Nintendo Switch 2', category: 'Gaming', listCents: 49999, art: '/img/showcase/handheld.svg' },
  { symbol: 'MBA13', name: 'MacBook Air 13 M5 (16/512)', category: 'Computing', listCents: 129900, art: '/img/showcase/laptop.svg' },
  { symbol: 'AW12', name: 'Apple Watch Series 12 (42 mm)', category: 'Wearables', listCents: 39900, art: '/img/showcase/watch.svg' },
  { symbol: 'S26', name: 'Galaxy S26 (256 GB)', category: 'Phones', listCents: 99999, art: '/img/showcase/phone-flat.svg' },
  { symbol: 'PS5', name: 'PlayStation 5 (disc, 1 TB)', category: 'Gaming', listCents: 64999, art: '/img/showcase/console.svg' },
];

/** 119900 -> "$1,199.00" (integer cents in, no floating point). */
export function fmtList(cents: number): string {
  const whole = Math.trunc(cents / 100), rest = Math.abs(cents % 100);
  return `$${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(rest).padStart(2, '0')}`;
}

/** The caption line: "Phones · US list price $1,199.00". */
export const listLine = (p: MarketProduct) => `${p.category} · US list price ${fmtList(p.listCents)}`;
