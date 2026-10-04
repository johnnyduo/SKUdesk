// Build guard: every manifest entry must have its landing page and PNG in dist/, an integer USD price that the
// page actually shows, and no fabricated GTIN. Run after `astro build` (npm run build does this automatically).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = process.argv[2] ?? 'dist';
const SITE = 'https://skudesk.lol';
const errors = [];
const fail = (msg) => errors.push(msg);

const manifestPath = join(DIST, 'p', 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('check-manifest: missing ' + manifestPath + ' (run astro build first)');
  process.exit(1);
}
const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (m.version !== 1) fail('version must be 1');
if (m.origin !== SITE) fail('origin must be ' + SITE);
if (!Array.isArray(m.entries) || m.entries.length === 0) fail('entries must be a non-empty array');
const skus = new Set();
for (const e of m.entries ?? []) {
  if (skus.has(e.sku)) fail('duplicate sku ' + e.sku);
  skus.add(e.sku);
  if (!/^\/p\/[A-Za-z0-9._-]+\/$/.test(e.path)) fail(e.sku + ': bad path ' + e.path);
  if (!/^\/img\/cases-png\/[a-z0-9_-]+\.png$/.test(e.imagePath)) fail(e.sku + ': imagePath must be a PNG under /img/cases-png/');
  if (!Number.isSafeInteger(e.priceCents) || e.priceCents <= 0) fail(e.sku + ': priceCents must be a positive integer');
  if (e.currency !== 'USD') fail(e.sku + ': currency must be USD');
  if (e.gtin !== null && !/^\d{8}$|^\d{12,14}$/.test(e.gtin)) fail(e.sku + ': gtin must be null or digits');
  const page = join(DIST, e.path, 'index.html');
  if (!existsSync(page)) { fail(e.sku + ': missing page ' + page); continue; }
  const html = readFileSync(page, 'utf8');
  const price = '$' + (e.priceCents / 100).toFixed(2);
  if (!html.includes(price)) fail(e.sku + ': page does not show ' + price);
  if (!html.includes('data-price-cents="' + e.priceCents + '"')) fail(e.sku + ': page price attribute mismatch');
  if (!existsSync(join(DIST, e.imagePath))) fail(e.sku + ': missing image ' + e.imagePath);
}
if (errors.length) {
  console.error('check-manifest: ' + errors.length + ' problem(s)\n  ' + errors.slice(0, 50).join('\n  '));
  process.exit(1);
}
console.log('check-manifest: ' + m.entries.length + ' landing pages verified');
