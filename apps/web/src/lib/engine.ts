// Deterministic engine: seeded PRNG + integer-cent economics + hard-gate matching.
// EVERYTHING here is simulated fixture data. No network call is made by this module or by the web app.
// Connector modes shown in the UI:
//   - supplier-feed: FIXTURE (local deterministic file, not a market)
//   - robinhood-rpc: CONFIGURED (public RPC URL is configured; this site does not probe it)
//   - serpapi/shopee/lazada/merchant: MOCK (no credentials; deterministic fixtures)
import { economics, verifyProof, fmtUSD, fmtBps, type EconInputCents } from '../../../../packages/economics/index.js';
import { matchOffer } from '../../../../packages/matching/index.js';
import { mulberry32 } from '../../../../packages/shared/index.js';

export type ConnMode = 'FIXTURE' | 'CONFIGURED' | 'MOCK' | 'DEGRADED';
export const CONN_LABEL: Record<ConnMode, string> = { FIXTURE: 'Local fixture', CONFIGURED: 'Configured, not probed', MOCK: 'Sample data', DEGRADED: 'Sample data (API restricted)' };
export type ConnState = { id: string; label: string; mode: ConnMode; latencyMs: number; lastSync: string; note: string; demo: boolean };
export const CONNECTORS: ConnState[] = [
  { id: 'supplier-feed', label: 'Supplier Feed (CSV/JSON)', mode: 'FIXTURE', latencyMs: 12, lastSync: 'fixture', note: 'local deterministic fixture - 100 SKUs, not a live market', demo: true },
  { id: 'robinhood-rpc', label: 'Robinhood Chain RPC', mode: 'CONFIGURED', latencyMs: 0, lastSync: 'never', note: 'configured RPC endpoint (chain 46630), not probed by this site', demo: false },
  { id: 'serpapi', label: 'SerpApi Google Shopping', mode: 'MOCK', latencyMs: 182, lastSync: '12s ago', note: 'SERPAPI_KEY absent - deterministic discovery fixtures', demo: true },
  { id: 'merchant', label: 'Google Merchant', mode: 'DEGRADED', latencyMs: 240, lastSync: '1m ago', note: 'own-catalog only; competitor search not permitted by API', demo: true },
  { id: 'shopee', label: 'Shopee Open Platform', mode: 'MOCK', latencyMs: 140, lastSync: '9s ago', note: 'seller auth absent - deterministic fixtures', demo: true },
  { id: 'lazada', label: 'Lazada Open Platform', mode: 'MOCK', latencyMs: 151, lastSync: '11s ago', note: 'app credentials absent - deterministic fixtures', demo: true },
];

const MODELS = ['iPhone 16 Pro', 'iPhone 16', 'iPhone 16 Pro Max', 'Galaxy S25', 'Pixel 9'];
const COLORS = ['Clear', 'Black', 'White', 'Navy'];
const SELLERS = ['Supplier A', 'Supplier B', 'Wholesale feed', 'Direct HK', 'Shenzhen hub'];
const VENUES = ['Google Shopping', 'Lazada Store', 'Shopee Store'];

export type Product = { id: string; brand: string; model: string; compat: string; color: string; magSafe: boolean; pack: number; gtin: string };
export type Offer = { id: string; productId: string; source: string; title: string; priceCents: number; shipCents: number; stock: number; seller: string; verdict: any; mode: 'MOCK' };
export type Opp = { id: string; productId: string; title: string; buy: string; sell: string; buyCents: number; landedCents: number; sellCents: number; netCents: number; marginBps: number; roiBps: number; breakevenCents: number; breakEvenBuyCents: number; qty: number; capitalCents: number; batchCents: number; status: string; input: EconInputCents; proof: any[]; verified: boolean };

function buildCatalog() {
  const rnd = mulberry32(46630);
  const products: Product[] = [];
  const hero: Product = { id: 'CASE-IP16PRO-CLEAR-MAG-001', brand: 'Apple-compatible', model: 'iPhone 16 Pro Clear MagSafe Case', compat: 'iPhone 16 Pro', color: 'Clear', magSafe: true, pack: 1, gtin: '850063102441' };
  products.push(hero);
  for (let i = 1; i < 100; i++) {
    const m = MODELS[Math.floor(rnd() * MODELS.length)];
    const c = COLORS[Math.floor(rnd() * COLORS.length)];
    const mag = rnd() > 0.3; const pack = rnd() > 0.88 ? 2 : 1;
    products.push({ id: 'SKU-' + String(1000 + i), brand: 'Apple-compatible', model: m + ' ' + c + (mag ? ' MagSafe' : '') + ' Case' + (pack === 2 ? ' 2-Pack' : ''), compat: m, color: c, magSafe: mag, pack, gtin: '8500631' + String(10000 + i) });
  }
  return { products, hero };
}

export const CATALOG = buildCatalog();

function canonOf(p: Product) { return { brand: p.brand, model: p.model, compatibility: p.compat, color: p.color, packCount: p.pack, gtin: p.gtin, attributes: { magsafe: p.magSafe ? 'Yes' : 'No' } }; }
const canonHero = canonOf(CATALOG.hero);

export function liveOffers(tick: number): Offer[] {
  const rnd = mulberry32(46630 + tick * 7919);
  const out: Offer[] = [];
  // Hero legs first (exact, verifiable)
  out.push({ id: 'of-hero-buy', productId: CATALOG.hero.id, source: 'shopee', title: 'Clear MagSafe Case for iPhone 16 Pro TPU Transparent', priceCents: 590, shipCents: 42, stock: 2400, seller: 'Supplier A', verdict: matchOffer(canonHero, { title: 'Clear MagSafe Case for iPhone 16 Pro TPU Transparent', attributes: { device: 'iPhone 16 Pro', magsafe: 'Yes', pack: '1' }, gtin: '850063102441' }), mode: 'MOCK' });
  out.push({ id: 'of-hero-sell', productId: CATALOG.hero.id, source: 'google', title: 'iPhone 16 Pro Clear MagSafe Case TPU', priceCents: 1099, shipCents: 0, stock: 800, seller: 'Retail demand', verdict: matchOffer(canonHero, { title: 'iPhone 16 Pro Clear MagSafe Case TPU', attributes: { device: 'iPhone 16 Pro', magsafe: 'Yes', pack: '1' } }), mode: 'MOCK' });
  // 98 more deterministic offers across the catalog
  CATALOG.products.slice(1).forEach((p, i) => {
    const src = ['shopee', 'lazada', 'google', 'supplier'][Math.floor(rnd() * 4)];
    const base = 380 + Math.floor(rnd() * 900);
    const jit = Math.floor((rnd() - 0.5) * 14);
    const title = p.model + ' TPU' + (p.pack === 2 ? ' 2-Pack' : '') + (p.magSafe ? '' : ' (no magnet)');
    out.push({
      id: 'of-' + i, productId: p.id, source: src,
      title, priceCents: Math.max(99, base + jit), shipCents: 20 + Math.floor(rnd() * 60),
      stock: 50 + Math.floor(rnd() * 2000), seller: SELLERS[Math.floor(rnd() * SELLERS.length)],
      verdict: matchOffer(canonOf(p), { title, attributes: { device: p.compat, magsafe: p.magSafe ? 'Yes' : '', pack: p.pack === 2 ? '2-pack' : '1' }, gtin: rnd() > 0.4 ? p.gtin : undefined }),
      mode: 'MOCK',
    });
  });
  return out;
}

export function liveOpps(tick: number): Opp[] {
  const rnd = mulberry32(9000 + tick * 131);
  const mk = (id: string, buy: string, sell: string, buyC: number, sellC: number, qty: number, status: string, title: string, pid: string): Opp => {
    const input: EconInputCents = { purchaseCents: buyC, inboundShipCents: 42, importDutyCents: 12, taxCents: 8, procurementFeeCents: 5, paymentFeeCents: 2, sellCents: sellC, marketplaceFeeBps: 800, fulfillmentCents: 65, returnReserveBps: 200, chainCostCents: 4, units: qty, fixedBatchCents: 1800 };
    const r = economics(input);
    return { id, productId: pid, title, buy, sell, buyCents: buyC, landedCents: r.landedCents, sellCents: sellC, netCents: r.netCents, marginBps: r.marginBps, roiBps: r.roiBps, breakevenCents: r.breakevenCents, breakEvenBuyCents: r.breakEvenBuyCents, qty, capitalCents: r.capitalCents, batchCents: r.batchCents, status, input, proof: r.proof, verified: verifyProof(input, r).ok };
  };
  const hero = mk('OP-2041', 'Shopee', 'Google Shopping', 590, 1099, 240, 'READY', CATALOG.hero.model, CATALOG.hero.id);
  const jit = (b: number) => Math.max(50, b + Math.floor((rnd() - 0.5) * 10));
  const rest: Opp[] = [
    mk('OP-2042', 'Lazada', 'Google Shopping', 640, 1099, 120, 'RISK CHECK', CATALOG.products[3].model, CATALOG.products[3].id),
    mk('OP-2043', 'Supplier Feed', 'Shopee Store', jit(580), 940, 400, 'PRICING', CATALOG.products[7].model, CATALOG.products[7].id),
    mk('OP-2044', 'Shopee', 'Lazada Store', jit(610), 1020, 160, 'MATCHING', CATALOG.products[11].model, CATALOG.products[11].id),
    mk('OP-2045', 'Wholesale Feed', 'Google Shopping', jit(555), 990, 300, 'READY', CATALOG.products[15].model, CATALOG.products[15].id),
  ];
  return [hero, ...rest];
}

export { fmtUSD, fmtBps, verifyProof };
