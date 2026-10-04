import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkListingAgainstManifest, findByGtin, findByPath, findBySku, loadManifest, parseManifest } from '../manifest.ts';
import { fakeAssets } from './helpers/fakes.ts';

const RAW = readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8');
const SITE = 'https://robinize.agent-dong.workers.dev';
const HERO_LINK = SITE + '/p/CASE-IP16PRO-CLEAR-MAG-001/';
const HERO_IMG = SITE + '/img/cases-png/iphone-16-pro_clear_mag_1.png';

test('parseManifest accepts the fixture and rejects malformed input', () => {
  const m = parseManifest(JSON.parse(RAW));
  assert.equal(m?.entries.length, 2);
  assert.equal(parseManifest({ version: 2, origin: SITE, entries: [] }), null);
  assert.equal(parseManifest({ version: 1, origin: SITE, entries: [{ sku: 'x' }] }), null);
  assert.equal(parseManifest(null), null);
});

test('find helpers: path ignores trailing slash, gtin compares as GTIN-14', () => {
  const m = parseManifest(JSON.parse(RAW));
  assert.ok(m);
  assert.equal(findByPath(m, '/p/CASE-IP16PRO-CLEAR-MAG-001')?.sku, 'CASE-IP16PRO-CLEAR-MAG-001');
  assert.equal(findBySku(m, 'SKU-TEST-GTIN')?.color, 'Black');
  assert.equal(findByGtin(m, '0036000291452')?.sku, 'SKU-TEST-GTIN');
  assert.equal(findByGtin(m, '850063102441'), undefined);
});

test('checkListingAgainstManifest: link, image and price must all match the landing page', () => {
  const m = parseManifest(JSON.parse(RAW));
  assert.equal(checkListingAgainstManifest(m, HERO_LINK, HERO_IMG, 1099).ok, true);
  assert.equal(checkListingAgainstManifest(m, HERO_LINK + '?utm=x', HERO_IMG, 1099).ok, true);
  const noPage = checkListingAgainstManifest(m, SITE + '/p/NOPE/', HERO_IMG, 1099);
  assert.deepEqual(noPage, { ok: false, reason: 'link is not a landing page in the build manifest' });
  assert.equal(checkListingAgainstManifest(m, HERO_LINK, SITE + '/img/cases/iphone-16-pro_clear_mag_1.svg', 1099).ok, false);
  const price = checkListingAgainstManifest(m, HERO_LINK, HERO_IMG, 999);
  assert.equal(price.ok, false);
  assert.equal(checkListingAgainstManifest(null, HERO_LINK, HERO_IMG, 1099).ok, false);
});

test('loadManifest reads /p/manifest.json through ASSETS; missing or broken -> null', async () => {
  assert.equal((await loadManifest(fakeAssets({ '/p/manifest.json': RAW }), 'https://x.test/api/merchant/listing'))?.entries.length, 2);
  assert.equal(await loadManifest(fakeAssets({}), 'https://x.test/api/x'), null);
  assert.equal(await loadManifest(fakeAssets({ '/p/manifest.json': '{broken' }), 'https://x.test/api/x'), null);
});
