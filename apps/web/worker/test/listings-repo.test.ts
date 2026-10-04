import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getListing, insertObservations, listDueForReconcile, purgeObservations, saveListing, setListingStatus, setRefreshedListingStatus, touchListingChecked } from '../db/listings.ts';
import type { NewListing, ObservationRow } from '../db/listings.ts';
import { sqliteD1 } from './helpers/d1.ts';

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const MIN = 60_000;
const row = (over: Partial<NewListing> = {}): NewListing => ({
  offer_id: 'LOT-1842', lot_id: 'LOT-1842', product_name: 'accounts/123/productInputs/en~US~LOT-1842', status: 'SUBMITTED',
  issues_json: null, price_micros: 10_990_000, currency: 'USD', payload_hash: 'h1', ...over,
});

test('saveListing inserts then upserts on the same offer_id (idempotency key)', async () => {
  const db = sqliteD1() as any;
  await saveListing(db, row(), T0);
  await saveListing(db, row({ payload_hash: 'h2', price_micros: 11_990_000 }), T0 + MIN);
  const got = await getListing(db, 'LOT-1842');
  assert.equal(got?.payload_hash, 'h2');
  assert.equal(got?.price_micros, 11_990_000);
  assert.equal(got?.created_at, T0);
  assert.equal(got?.updated_at, T0 + MIN);
  assert.equal(got?.last_checked_at, null);
  assert.equal(await getListing(db, 'nope'), null);
});

test('migration constraints reject bad status, non-USD and zero price', async () => {
  const db = sqliteD1() as any;
  await assert.rejects(saveListing(db, row({ status: 'LIVE' as any }), T0));
  await assert.rejects(saveListing(db, row({ currency: 'THB' as any }), T0));
  await assert.rejects(saveListing(db, row({ price_micros: 0 }), T0));
});

test('setListingStatus moves updated_at only on change; last_checked_at always', async () => {
  const db = sqliteD1() as any;
  await saveListing(db, row(), T0);
  await setListingStatus(db, 'LOT-1842', 'SUBMITTED', null, T0 + 5 * MIN);
  let got = await getListing(db, 'LOT-1842');
  assert.equal(got?.updated_at, T0);
  assert.equal(got?.last_checked_at, T0 + 5 * MIN);
  await setListingStatus(db, 'LOT-1842', 'APPROVED', '[]', T0 + 10 * MIN);
  got = await getListing(db, 'LOT-1842');
  assert.equal(got?.status, 'APPROVED');
  assert.equal(got?.updated_at, T0 + 10 * MIN);
  assert.equal(got?.issues_json, '[]');
});

test('listDueForReconcile: only SUBMITTED/PROCESSING, >= 2 min since last check, < 48 h old, bounded', async () => {
  const db = sqliteD1() as any;
  await saveListing(db, row({ offer_id: 'A' }), T0);
  await saveListing(db, row({ offer_id: 'B', status: 'APPROVED' }), T0);
  await saveListing(db, row({ offer_id: 'C' }), T0 + 59 * MIN);
  await saveListing(db, row({ offer_id: 'OLD' }), T0 - 49 * 60 * MIN);
  const due = await listDueForReconcile(db, T0 + 60 * MIN);
  assert.deepEqual(due.map((r) => r.offer_id), ['A']);
  for (let i = 0; i < 30; i++) await saveListing(db, row({ offer_id: 'N' + i }), T0);
  assert.equal((await listDueForReconcile(db, T0 + 60 * MIN)).length, 25);
});

test('insertObservations caps at 40 rows; purgeObservations applies 30 d, eBay 6 h and Best Buy 72 h retention', async () => {
  const db = sqliteD1() as any;
  const HOUR = 60 * MIN;
  const obs = (source: string, ageMs: number): ObservationRow => ({ source, gtin: '036000291452', query: 'q', price_cents: 999, currency: 'USD', locked: 1, title: 't', url: 'https://x', observed_at: T0 - ageMs });
  assert.equal(await insertObservations(db, Array.from({ length: 50 }, () => obs('ebay', 0))), 40);
  await insertObservations(db, [
    obs('ebay', 31 * 24 * HOUR), obs('ebay', 7 * HOUR), obs('ebay', 5 * HOUR),
    obs('bestbuy', 73 * HOUR), obs('bestbuy', 71 * HOUR), obs('serpapi', 29 * 24 * HOUR),
  ]);
  assert.equal(await purgeObservations(db, T0), 3);
  const left = db.raw.prepare('SELECT source, COUNT(*) AS n FROM price_observations GROUP BY source ORDER BY source').all().map((r: any) => ({ ...r }));
  assert.deepEqual(left, [{ source: 'bestbuy', n: 1 }, { source: 'ebay', n: 41 }, { source: 'serpapi', n: 1 }]);
});

test('setRefreshedListingStatus / touchListingChecked only touch SUBMITTED/PROCESSING rows (never resurrect DELETED)', async () => {
  const db = sqliteD1() as any;
  await saveListing(db, row(), T0);
  await setListingStatus(db, 'LOT-1842', 'DELETED', null, T0 + MIN);
  await setRefreshedListingStatus(db, 'LOT-1842', 'APPROVED', '[]', T0 + 2 * MIN);
  await touchListingChecked(db, 'LOT-1842', T0 + 3 * MIN);
  const got = await getListing(db, 'LOT-1842');
  assert.deepEqual([got?.status, got?.last_checked_at, got?.issues_json], ['DELETED', T0 + MIN, null]);
  await saveListing(db, row({ offer_id: 'P' }), T0);
  await setRefreshedListingStatus(db, 'P', 'PROCESSING', '[]', T0 + MIN);
  await touchListingChecked(db, 'P', T0 + 5 * MIN);
  assert.deepEqual([(await getListing(db, 'P'))?.status, (await getListing(db, 'P'))?.last_checked_at], ['PROCESSING', T0 + 5 * MIN]);
});

test('listDueForReconcile: the 48 h window follows updated_at, so a re-submitted old listing is due again', async () => {
  const db = sqliteD1() as any;
  await saveListing(db, row({ offer_id: 'R' }), T0 - 49 * 60 * MIN);
  await saveListing(db, row({ offer_id: 'R' }), T0 + 50 * MIN);
  assert.deepEqual((await listDueForReconcile(db, T0 + 60 * MIN)).map((r: any) => r.offer_id), ['R']);
});
