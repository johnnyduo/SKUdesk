import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidGtin, normalizeGtin, sameGtin } from '../gtin.ts';
import { HttpError } from '../http.ts';
import { centsToMicros, encodeProductId, normalizeTitle, payloadHash, productInputPath, productPath, toProductInput, validateListingRequest } from '../google/mapping.ts';

const SITE = 'https://robinize.agent-dong.workers.dev';
const base = {
  lotId: 'LOT-1842',
  title: 'iPhone 16 Pro Clear MagSafe Case',
  link: SITE + '/p/CASE-IP16PRO-CLEAR-MAG-001/',
  imageLink: SITE + '/img/cases-png/iphone-16-pro_clear_mag_1.png',
  priceCents: 1099,
};
const isBad = (re: RegExp) => (e: unknown) => e instanceof HttpError && e.status === 400 && re.test(e.message);

test('isValidGtin: valid EAN-8/UPC-A/EAN-13/GTIN-14, rejects bad checksum, junk, all zeros', () => {
  for (const g of ['96385074', '036000291452', '4006381333931', '00036000291452']) assert.equal(isValidGtin(g), true, g);
  for (const g of ['850063102441', '036000291453', '12345', 'abcdefghijkl', '000000000000', '']) assert.equal(isValidGtin(g), false, g);
});

test('normalizeGtin / sameGtin: UPC-A equals its EAN-13 form', () => {
  assert.equal(normalizeGtin('036000291452'), '00036000291452');
  assert.equal(sameGtin('036000291452', '0036000291452'), true);
  assert.equal(sameGtin('036000291452', '4006381333931'), false);
  assert.equal(sameGtin(undefined, undefined), false);
  assert.equal(normalizeGtin('850063102441'), null);
});

test('centsToMicros: integer only, no float drift', () => {
  assert.equal(centsToMicros(1099), '10990000');
  assert.equal(centsToMicros(1), '10000');
  assert.equal(centsToMicros(100_000_000), '1000000000000');
  assert.throws(() => centsToMicros(10.99));
  assert.throws(() => centsToMicros(-1));
});

test('normalizeTitle: promo stripped (not inside words), ALL CAPS de-shouted, 150-char cap on code points', () => {
  assert.equal(normalizeTitle('  iPhone 16 Pro Case!!! FREE SHIPPING  '), 'iPhone 16 Pro Case');
  assert.equal(normalizeTitle('Wholesale Clear Case'), 'Wholesale Clear Case');
  assert.equal(normalizeTitle('CLEAR MAGSAFE CASE FOR IPHONE 16 PRO'), 'Clear Magsafe Case For Iphone 16 Pro');
  const long = 'Clear case '.repeat(30);
  const t = normalizeTitle(long);
  assert.ok(Array.from(t).length <= 150);
  assert.ok(!t.endsWith(' '));
  const emoji = '📱'.repeat(160);
  const e = normalizeTitle(emoji);
  assert.equal(Array.from(e).length, 150);
  assert.ok(!/[\uD800-\uDBFF]$/.test(e), 'no dangling high surrogate');
});

test('validateListingRequest: defaults, offerId idempotency key, dryRun default true', () => {
  const r = validateListingRequest(base, SITE);
  assert.equal(r.offerId, 'LOT-1842');
  assert.equal(r.dryRun, true);
  assert.equal(r.condition, 'NEW');
  assert.equal(r.availability, 'IN_STOCK');
  assert.equal(r.currency, 'USD');
  assert.equal(validateListingRequest({ ...base, dryRun: false }, SITE).dryRun, false);
  assert.equal(validateListingRequest({ ...base, offerId: 'OFFER_1' }, SITE).offerId, 'OFFER_1');
});

test('validateListingRequest: rejects float/string/zero/huge prices and non-boolean dryRun', () => {
  assert.throws(() => validateListingRequest({ ...base, priceCents: 10.99 }, SITE), isBad(/priceCents/));
  assert.throws(() => validateListingRequest({ ...base, priceCents: '1099' }, SITE), isBad(/priceCents/));
  assert.throws(() => validateListingRequest({ ...base, priceCents: 0 }, SITE), isBad(/priceCents/));
  assert.throws(() => validateListingRequest({ ...base, priceCents: 100_000_001 }, SITE), isBad(/priceCents/));
  assert.throws(() => validateListingRequest({ ...base, dryRun: 'false' }, SITE), isBad(/dryRun/));
});

test('validateListingRequest: URLs must be https on our origin, ASCII, no credentials', () => {
  assert.throws(() => validateListingRequest({ ...base, link: 'http://robinize.agent-dong.workers.dev/p/x/' }, SITE), isBad(/https/));
  assert.throws(() => validateListingRequest({ ...base, link: 'https://evil.test/p/x/' }, SITE), isBad(/must be on/));
  assert.throws(() => validateListingRequest({ ...base, link: 'https://robinize.agent-dong.workers.dev.evil.test/p/' }, SITE), isBad(/must be on/));
  assert.throws(() => validateListingRequest({ ...base, imageLink: 'https://u:p@robinize.agent-dong.workers.dev/a.png' }, SITE), isBad(/credentials/));
  assert.throws(() => validateListingRequest({ ...base, link: SITE + '/p/ü/' }, SITE), isBad(/ASCII/));
});

test('validateListingRequest: offerId charset/length, currency, gtin checksum, enums', () => {
  assert.throws(() => validateListingRequest({ ...base, lotId: 'LOT 1842' }, SITE), isBad(/lotId/));
  assert.throws(() => validateListingRequest({ ...base, offerId: 'x'.repeat(51) }, SITE), isBad(/offerId/));
  assert.throws(() => validateListingRequest({ ...base, offerId: 'en~US~x' }, SITE), isBad(/offerId/));
  assert.throws(() => validateListingRequest({ ...base, currency: 'THB' }, SITE), isBad(/USD/));
  assert.throws(() => validateListingRequest({ ...base, gtin: '850063102441' }, SITE), isBad(/checksum/));
  assert.throws(() => validateListingRequest({ ...base, condition: 'new' }, SITE), isBad(/condition/));
  assert.throws(() => validateListingRequest([], SITE), isBad(/object/));
});

test('toProductInput: v1 shape, micros as string, gtins only when valid, identifierExists=false otherwise', () => {
  const cfg = { language: 'en', feedLabel: 'US' };
  const noGtin = toProductInput(validateListingRequest(base, SITE), cfg);
  assert.deepEqual(noGtin, {
    offerId: 'LOT-1842', contentLanguage: 'en', feedLabel: 'US',
    productAttributes: { title: 'iPhone 16 Pro Clear MagSafe Case', link: base.link, imageLink: base.imageLink, price: { amountMicros: '10990000', currencyCode: 'USD' }, availability: 'IN_STOCK', condition: 'NEW', identifierExists: false },
  });
  const withGtin = toProductInput(validateListingRequest({ ...base, gtin: '036000291452', brand: 'Robinize', description: 'TPU case' }, SITE), cfg);
  assert.deepEqual(withGtin.productAttributes.gtins, ['036000291452']);
  assert.equal(withGtin.productAttributes.identifierExists, undefined);
  assert.equal(withGtin.productAttributes.brand, 'Robinize');
});

test('encodeProductId matches the Google doc example; paths use the encoded id', () => {
  assert.equal(encodeProductId('en', 'US', 'sku/123'), 'ZW5-VVN-c2t1LzEyMw');
  assert.equal(productInputPath('123', 'en', 'US', 'LOT-1842'), '/products/v1/accounts/123/productInputs/' + encodeProductId('en', 'US', 'LOT-1842'));
  assert.equal(productPath('123', 'en', 'US', 'LOT-1842'), '/products/v1/accounts/123/products/' + encodeProductId('en', 'US', 'LOT-1842'));
});

test('payloadHash is stable for equal payloads and changes with price', async () => {
  const cfg = { language: 'en', feedLabel: 'US' };
  const a = await payloadHash(toProductInput(validateListingRequest(base, SITE), cfg));
  const b = await payloadHash(toProductInput(validateListingRequest(base, SITE), cfg));
  const c = await payloadHash(toProductInput(validateListingRequest({ ...base, priceCents: 1199 }, SITE), cfg));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('validateListingRequest: link/imageLink must not carry a query string or fragment', () => {
  for (const suffix of ['?utm=x', '#frag', '?utm=x#frag', '?']) {
    assert.throws(() => validateListingRequest({ ...base, link: base.link + suffix }, SITE), isBad(/query string or fragment/), suffix);
    assert.throws(() => validateListingRequest({ ...base, imageLink: base.imageLink + suffix }, SITE), isBad(/query string or fragment/), suffix);
  }
  assert.equal(validateListingRequest(base, SITE).link, base.link);
});

test('payloadHash covers the data source', async () => {
  const cfg = { language: 'en', feedLabel: 'US' };
  const body = toProductInput(validateListingRequest(base, SITE), cfg);
  assert.equal(await payloadHash(body, 'accounts/1/dataSources/2'), await payloadHash(body, 'accounts/1/dataSources/2'));
  assert.notEqual(await payloadHash(body, 'accounts/1/dataSources/2'), await payloadHash(body, 'accounts/1/dataSources/3'));
});
