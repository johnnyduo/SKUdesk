import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleFetch } from '../app.ts';
import { getListing, saveListing } from '../db/listings.ts';
import { deriveStatus } from '../google/productStatus.ts';
import { encodeProductId } from '../google/mapping.ts';
import { FIXED_NOW_MS, baseEnv, fakeAssets, fakeExec, jsonResponse, limiter, scriptedFetch, testDeps } from './helpers/fakes.ts';
import { sqliteD1 } from './helpers/d1.ts';
import { throwawayServiceAccount } from './helpers/keys.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/merchant/' + name, import.meta.url), 'utf8'));
const MANIFEST = readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8');
const SITE = 'https://robinize.agent-dong.workers.dev';
const TOKEN = 't'.repeat(40);
const LISTING = {
  lotId: 'LOT-1842',
  title: 'iPhone 16 Pro Clear MagSafe Case',
  link: SITE + '/p/CASE-IP16PRO-CLEAR-MAG-001/',
  imageLink: SITE + '/img/cases-png/iphone-16-pro_clear_mag_1.png',
  priceCents: 1099,
};
const HERO_ID = encodeProductId('en', 'US', 'LOT-1842');

function env(over: Record<string, unknown> = {}) {
  return baseEnv({ ASSETS: fakeAssets({ '/p/manifest.json': MANIFEST }), DB: sqliteD1(), ...over });
}
async function liveEnv(over: Record<string, unknown> = {}) {
  const { saJson } = await throwawayServiceAccount();
  return env({ GOOGLE_SA_JSON: saJson, MERCHANT_ACCOUNT_ID: '123', MERCHANT_DATA_SOURCE_ID: '456', ADMIN_TOKEN: TOKEN, ...over });
}
function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(SITE + '/api/merchant/listing', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
const call = (req: Request, e: unknown, deps: unknown = testDeps()) => handleFetch(req, e as any, fakeExec() as any, deps as any);
const tokenOk = () => jsonResponse({ access_token: 'ya29.t', expires_in: 3599 });

test('deriveStatus: approved / disapproved / pending fixtures', () => {
  assert.equal(deriveStatus(fx('product-approved.json'), 'US').status, 'APPROVED');
  assert.equal(deriveStatus(fx('product-approved.json'), 'US').issues[0].code, 'image_too_small');
  assert.equal(deriveStatus(fx('product-disapproved.json'), 'US').status, 'DISAPPROVED');
  assert.equal(deriveStatus(fx('product-pending.json'), 'US').status, 'PROCESSING');
  assert.equal(deriveStatus({}, 'US').status, 'PROCESSING');
});

test('publish: default is DRY_RUN with masked ids, no network, no DB row', async () => {
  const e = env();
  const res = await call(post(LISTING), e);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.mode, 'DRY_RUN');
  assert.equal(body.configured, false);
  assert.equal(body.wouldSend.path, '/products/v1/accounts/{MERCHANT_ACCOUNT_ID}/productInputs:insert');
  assert.equal(body.wouldSend.body.productAttributes.price.amountMicros, '10990000');
  assert.equal(await getListing(e.DB as any, 'LOT-1842'), null);
});

test('publish: dry run with a configured account still masks ids for non-admin callers', async () => {
  const e = await liveEnv();
  const body = await (await call(post(LISTING), e)).json() as any;
  assert.equal(body.configured, true);
  assert.ok(!JSON.stringify(body).includes('/accounts/123/'));
});

test('publish: dryRun:false without or with a wrong token -> 401, never live', async () => {
  const e = await liveEnv();
  assert.equal((await call(post({ ...LISTING, dryRun: false }), e)).status, 401);
  assert.equal((await call(post({ ...LISTING, dryRun: false }, { 'x-admin-token': TOKEN + 'x' }), e)).status, 401);
  assert.equal((await call(post({ ...LISTING, dryRun: 'false' }, { 'x-admin-token': TOKEN }), e)).status, 400);
});

test('publish: admin live without merchant secrets -> 503 NOT_CONFIGURED', async () => {
  const e = env({ ADMIN_TOKEN: TOKEN });
  const res = await call(post({ ...LISTING, dryRun: false }, { 'x-admin-token': TOKEN }), e);
  assert.equal(res.status, 503);
  assert.equal((await res.json() as any).error.code, 'NOT_CONFIGURED');
});

test('publish: manifest guard rejects unknown page, wrong image and price drift (dry run too)', async () => {
  const e = env();
  const codes = [];
  for (const body of [{ ...LISTING, link: SITE + '/p/NOPE/' }, { ...LISTING, imageLink: SITE + '/img/cases/iphone-16-pro_clear_mag_1.svg' }, { ...LISTING, priceCents: 999 }, { ...LISTING, gtin: '036000291452' }]) {
    const res = await call(post(body), e);
    codes.push(res.status + ':' + (await res.json() as any).error.code);
  }
  assert.deepEqual(codes, ['422:LINK_NOT_IN_MANIFEST', '422:LINK_NOT_IN_MANIFEST', '422:LINK_NOT_IN_MANIFEST', '422:LINK_NOT_IN_MANIFEST']);
  const noManifest = await call(post(LISTING), env({ ASSETS: fakeAssets({}) }));
  assert.equal(noManifest.status, 422);
});

test('publish: cross-origin POST -> 403; RL_WRITE refusal -> 429', async () => {
  assert.equal((await call(post(LISTING, { origin: 'https://evil.test' }), env())).status, 403);
  assert.equal((await call(post(LISTING), env({ RL_WRITE: limiter(0) }))).status, 429);
});

test('publish live: insert with dataSource, row SUBMITTED (201); identical repeat is idempotent; changed payload updates (200)', async () => {
  const e = await liveEnv();
  const net = scriptedFetch([tokenOk, () => jsonResponse(fx('insert-ok.json')), () => jsonResponse(fx('insert-ok.json'))]);
  const deps = testDeps({ fetch: net.fetch });
  const first = await call(post({ ...LISTING, dryRun: false }, { 'x-admin-token': TOKEN }), e, deps);
  assert.equal(first.status, 201);
  const fb = await first.json() as any;
  assert.deepEqual([fb.mode, fb.status, fb.name, fb.idempotent], ['REAL', 'SUBMITTED', 'accounts/123/productInputs/en~US~LOT-1842', false]);
  assert.equal(net.calls[1].method, 'POST');
  assert.equal(net.calls[1].url, 'https://merchantapi.googleapis.com/products/v1/accounts/123/productInputs:insert?dataSource=accounts%2F123%2FdataSources%2F456');
  const sent = JSON.parse(net.calls[1].body ?? '');
  assert.deepEqual([sent.offerId, sent.contentLanguage, sent.feedLabel, sent.productAttributes.price.currencyCode], ['LOT-1842', 'en', 'US', 'USD']);
  const row = await getListing(e.DB as any, 'LOT-1842');
  assert.deepEqual([row?.status, row?.price_micros, row?.created_at], ['SUBMITTED', 10_990_000, FIXED_NOW_MS]);

  const again = await call(post({ ...LISTING, dryRun: false }, { 'x-admin-token': TOKEN }), e, deps);
  assert.equal(again.status, 200);
  assert.equal((await again.json() as any).idempotent, true);
  assert.equal(net.calls.length, 2);

  const changed = await call(post({ ...LISTING, title: 'iPhone 16 Pro Clear MagSafe Case TPU', dryRun: false }, { 'x-admin-token': TOKEN }), e, deps);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json() as any).updated, true);
  assert.equal(net.calls.length, 3);
});

test('get listing: 404 unknown; stale SUBMITTED row refreshes from products.get; upstream 404 -> PROCESSING', async () => {
  const e = await liveEnv();
  assert.equal((await call(new Request(SITE + '/api/merchant/listing/NOPE'), e)).status, 404);
  assert.equal((await call(new Request(SITE + '/api/merchant/listing/bad%20id'), e)).status, 400);
  await saveListing(e.DB as any, { offer_id: 'LOT-1842', lot_id: 'LOT-1842', product_name: 'n', status: 'SUBMITTED', issues_json: null, price_micros: 10_990_000, currency: 'USD', payload_hash: 'h' }, FIXED_NOW_MS - 10 * 60_000);
  const net = scriptedFetch([tokenOk, () => jsonResponse(fx('product-approved.json'))]);
  const res = await call(new Request(SITE + '/api/merchant/listing/LOT-1842'), e, testDeps({ fetch: net.fetch }));
  const body = await res.json() as any;
  assert.equal(net.calls[1].url, 'https://merchantapi.googleapis.com/products/v1/accounts/123/products/' + HERO_ID);
  assert.deepEqual([body.status, body.issues.length, body.lastCheckedAt], ['APPROVED', 1, '2026-10-02T12:00:00.000Z']);

  await saveListing(e.DB as any, { offer_id: 'LOT-9', lot_id: 'LOT-9', product_name: 'n', status: 'SUBMITTED', issues_json: null, price_micros: 10_990_000, currency: 'USD', payload_hash: 'h' }, FIXED_NOW_MS - 10 * 60_000);
  // The Google token is already cached in KV from the refresh above, so the only upstream call is products.get -> 404.
  const net404 = scriptedFetch([() => jsonResponse({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }, 404)]);
  const pending = await (await call(new Request(SITE + '/api/merchant/listing/LOT-9'), e, testDeps({ fetch: net404.fetch }))).json() as any;
  assert.equal(pending.status, 'PROCESSING');
  assert.equal(net404.calls.length, 1);
});

test('get listing: productName (embeds the account id) is admin-only; non-admin body has no account id anywhere', async () => {
  const e = await liveEnv({ RL_READ: limiter() });
  const PRODUCT = 'accounts/123/products/' + HERO_ID;
  await saveListing(e.DB as any, { offer_id: 'LOT-1842', lot_id: 'LOT-1842', product_name: PRODUCT, status: 'APPROVED', issues_json: null, price_micros: 10_990_000, currency: 'USD', payload_hash: 'h' }, FIXED_NOW_MS);
  const pubText = await (await call(new Request(SITE + '/api/merchant/listing/LOT-1842'), e)).text();
  assert.ok(!pubText.includes('productName'), pubText);
  assert.ok(!pubText.includes('accounts/'), pubText);
  assert.ok(!pubText.includes('123'), pubText);
  assert.equal(JSON.parse(pubText).status, 'APPROVED');
  const bad = await (await call(new Request(SITE + '/api/merchant/listing/LOT-1842', { headers: { 'x-admin-token': 'q'.repeat(40) } }), e)).text();
  assert.ok(!bad.includes('productName'), bad);
  const adm = await (await call(new Request(SITE + '/api/merchant/listing/LOT-1842', { headers: { 'x-admin-token': TOKEN } }), e)).json() as any;
  assert.equal(adm.productName, PRODUCT);
  const keys = (e.RL_READ as any).keys as string[];
  assert.match(keys[0], /:ip:/);
  assert.match(keys[2], /:adm:/);
});

test('get listing: upstream failure returns the stored row with refreshError instead of failing', async () => {
  const e = await liveEnv();
  await saveListing(e.DB as any, { offer_id: 'LOT-1842', lot_id: 'LOT-1842', product_name: 'n', status: 'SUBMITTED', issues_json: null, price_micros: 10_990_000, currency: 'USD', payload_hash: 'h' }, FIXED_NOW_MS - 10 * 60_000);
  const boom = () => { throw new TypeError('down'); };
  const net = scriptedFetch([tokenOk, boom, boom, boom, boom]);
  const res = await call(new Request(SITE + '/api/merchant/listing/LOT-1842'), e, testDeps({ fetch: net.fetch }));
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.deepEqual([body.status, body.refreshError], ['SUBMITTED', 'MERCHANT_UPSTREAM']);
});

test('delete: 401 without token; with token deletes upstream with dataSource and marks row DELETED', async () => {
  const e = await liveEnv();
  const del = (h: Record<string, string>) => new Request(SITE + '/api/merchant/listing/LOT-1842', { method: 'DELETE', headers: h });
  assert.equal((await call(del({}), e)).status, 401);
  await saveListing(e.DB as any, { offer_id: 'LOT-1842', lot_id: 'LOT-1842', product_name: 'n', status: 'APPROVED', issues_json: '[]', price_micros: 10_990_000, currency: 'USD', payload_hash: 'h' }, FIXED_NOW_MS);
  const net = scriptedFetch([tokenOk, () => jsonResponse({})]);
  const res = await call(del({ 'x-admin-token': TOKEN }), e, testDeps({ fetch: net.fetch }));
  assert.equal(res.status, 200);
  assert.equal(net.calls[1].method, 'DELETE');
  assert.equal(net.calls[1].url, 'https://merchantapi.googleapis.com/products/v1/accounts/123/productInputs/' + HERO_ID + '?dataSource=accounts%2F123%2FdataSources%2F456');
  assert.equal((await getListing(e.DB as any, 'LOT-1842'))?.status, 'DELETED');
});

test('refresh racing a delete: the row stays DELETED and a later identical publish re-inserts', async () => {
  const e = await liveEnv();
  const net = scriptedFetch([
    tokenOk,
    () => jsonResponse(fx('insert-ok.json')),
    () => { // the product read is in flight; a delete lands before the status write
      e.DB.raw.prepare("UPDATE merchant_listings SET status = 'DELETED' WHERE offer_id = 'LOT-1842'").run();
      return jsonResponse(fx('product-approved.json'));
    },
    () => jsonResponse(fx('insert-ok.json')),
  ]);
  const deps = testDeps({ fetch: net.fetch });
  const pub = () => call(post({ ...LISTING, dryRun: false }, { 'x-admin-token': TOKEN }), e, deps);
  assert.equal((await pub()).status, 201);
  const got = await (await call(new Request(SITE + '/api/merchant/listing/LOT-1842'), e, deps)).json() as any;
  assert.equal(got.status, 'DELETED');
  assert.equal((await getListing(e.DB as any, 'LOT-1842'))?.status, 'DELETED');
  const again = await pub();
  assert.equal(again.status, 200);
  const ab = await again.json() as any;
  assert.equal(ab.idempotent, false);
  assert.equal(net.calls.length, 4);
});

test('publish: changing MERCHANT_DATA_SOURCE_ID re-inserts instead of being idempotent', async () => {
  const e = await liveEnv();
  const net = scriptedFetch([tokenOk, () => jsonResponse(fx('insert-ok.json')), () => jsonResponse(fx('insert-ok.json'))]);
  const deps = testDeps({ fetch: net.fetch });
  const pub = (env: unknown) => call(post({ ...LISTING, dryRun: false }, { 'x-admin-token': TOKEN }), env, deps);
  assert.equal((await pub(e)).status, 201);
  const moved = await pub({ ...e, MERCHANT_DATA_SOURCE_ID: '789' });
  assert.equal((await moved.json() as any).idempotent, false);
  assert.ok(net.calls[2].url.includes('dataSources%2F789'));
});

test('publish: dryRun 0 / null -> 400; DELETE wrong token -> 401; DELETE foreign Origin -> 403', async () => {
  const e = await liveEnv();
  for (const dryRun of [0, null]) assert.equal((await call(post({ ...LISTING, dryRun }, { 'x-admin-token': TOKEN }), e)).status, 400, String(dryRun));
  const del = (h: Record<string, string>) => new Request(SITE + '/api/merchant/listing/LOT-1842', { method: 'DELETE', headers: h });
  assert.equal((await call(del({ 'x-admin-token': TOKEN + 'x' }), e)).status, 401);
  assert.equal((await call(del({ 'x-admin-token': TOKEN, origin: 'https://evil.test' }), e)).status, 403);
});

test('publish: Google 400 text never reaches the HTTP response', async () => {
  const e = await liveEnv();
  const net = scriptedFetch([tokenOk, () => jsonResponse({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'SENTINEL-GOOGLE-TEXT <script>', details: [{ fieldViolations: [{ field: 'productAttributes.title', description: 'SENTINEL-GOOGLE-TEXT' }] }] } }, 400)]);
  const res = await call(post({ ...LISTING, dryRun: false }, { 'x-admin-token': TOKEN }), e, testDeps({ fetch: net.fetch }));
  assert.equal(res.status, 422);
  const text = await res.text();
  assert.ok(!text.includes('SENTINEL'));
  assert.equal(JSON.parse(text).error.code, 'MERCHANT_INVALID_PRODUCT');
});

test('publish: availability must equal the landing page availability (dry run too)', async () => {
  const e = env();
  for (const availability of ['OUT_OF_STOCK', 'PREORDER']) {
    const res = await call(post({ ...LISTING, availability }), e);
    assert.equal(res.status, 422, availability);
    assert.equal((await res.json() as any).error.code, 'LINK_NOT_IN_MANIFEST');
  }
  assert.equal((await call(post({ ...LISTING, availability: 'IN_STOCK' }), e)).status, 200);
});
