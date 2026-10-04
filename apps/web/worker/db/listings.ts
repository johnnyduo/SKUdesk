// D1 repository for merchant_listings and price_observations. All timestamps are epoch ms.
import type { ListingStatus } from '../api-types.ts';

export type ListingRow = {
  offer_id: string;
  lot_id: string;
  product_name: string | null;
  status: ListingStatus;
  issues_json: string | null;
  price_micros: number;
  currency: 'USD';
  payload_hash: string;
  created_at: number;
  updated_at: number;
  last_checked_at: number | null;
};
export type NewListing = Omit<ListingRow, 'created_at' | 'updated_at' | 'last_checked_at'>;
export type ObservationRow = {
  source: string;
  gtin: string | null;
  query: string;
  price_cents: number;
  currency: 'USD';
  locked: 0 | 1;
  title: string | null;
  url: string | null;
  observed_at: number;
};

export const RECONCILE_MIN_AGE_MS = 2 * 60 * 1000;
export const RECONCILE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const BESTBUY_RETENTION_MS = 72 * 60 * 60 * 1000;
export const EBAY_RETENTION_MS = 6 * 60 * 60 * 1000;
export const MAX_OBSERVATIONS_PER_WRITE = 40;

export async function getListing(db: D1Database, offerId: string): Promise<ListingRow | null> {
  return db.prepare('SELECT * FROM merchant_listings WHERE offer_id = ?1').bind(offerId).first<ListingRow>();
}

export async function saveListing(db: D1Database, row: NewListing, nowMs: number): Promise<void> {
  await db.prepare(
    `INSERT INTO merchant_listings (offer_id, lot_id, product_name, status, issues_json, price_micros, currency, payload_hash, created_at, updated_at, last_checked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, NULL)
     ON CONFLICT(offer_id) DO UPDATE SET lot_id = excluded.lot_id, product_name = excluded.product_name, status = excluded.status,
       issues_json = excluded.issues_json, price_micros = excluded.price_micros, currency = excluded.currency,
       payload_hash = excluded.payload_hash, updated_at = excluded.updated_at, last_checked_at = NULL`,
  ).bind(row.offer_id, row.lot_id, row.product_name, row.status, row.issues_json, row.price_micros, row.currency, row.payload_hash, nowMs).run();
}

// Unconditional status write. Used by delete only (DELETED must win); refresh paths use the guarded variants below.
// updated_at moves only when the status actually changes; last_checked_at always moves.
export async function setListingStatus(db: D1Database, offerId: string, status: ListingStatus, issuesJson: string | null, nowMs: number): Promise<void> {
  await db.prepare(
    `UPDATE merchant_listings SET updated_at = CASE WHEN status = ?2 THEN updated_at ELSE ?4 END,
       status = ?2, issues_json = ?3, last_checked_at = ?4 WHERE offer_id = ?1`,
  ).bind(offerId, status, issuesJson, nowMs).run();
}

// Refresh/reconcile write: only rows still waiting on Merchant processing may change, so a refresh that
// raced a delete (or a status already final) can never resurrect or overwrite the row.
export async function setRefreshedListingStatus(db: D1Database, offerId: string, status: ListingStatus, issuesJson: string | null, nowMs: number): Promise<void> {
  await db.prepare(
    `UPDATE merchant_listings SET updated_at = CASE WHEN status = ?2 THEN updated_at ELSE ?4 END,
       status = ?2, issues_json = ?3, last_checked_at = ?4 WHERE offer_id = ?1 AND status IN ('SUBMITTED', 'PROCESSING')`,
  ).bind(offerId, status, issuesJson, nowMs).run();
}

// Per-row reconcile failure: bump last_checked_at (same pending-only guard) so a permanently failing row
// moves behind the unchecked ones instead of starving the batch.
export async function touchListingChecked(db: D1Database, offerId: string, nowMs: number): Promise<void> {
  await db.prepare(
    `UPDATE merchant_listings SET last_checked_at = ?2 WHERE offer_id = ?1 AND status IN ('SUBMITTED', 'PROCESSING')`,
  ).bind(offerId, nowMs).run();
}

// The 48 h window is keyed on updated_at (saveListing resets it on every re-submit), not created_at.
export async function listDueForReconcile(db: D1Database, nowMs: number, limit = 25): Promise<ListingRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM merchant_listings
     WHERE status IN ('SUBMITTED', 'PROCESSING') AND COALESCE(last_checked_at, updated_at) <= ?1 AND updated_at >= ?2
     ORDER BY COALESCE(last_checked_at, 0) ASC, updated_at ASC LIMIT ?3`,
  ).bind(nowMs - RECONCILE_MIN_AGE_MS, nowMs - RECONCILE_MAX_AGE_MS, limit).all<ListingRow>();
  return results;
}

export async function insertObservations(db: D1Database, rows: ObservationRow[]): Promise<number> {
  const batch = rows.slice(0, MAX_OBSERVATIONS_PER_WRITE);
  for (const r of batch) {
    await db.prepare(
      `INSERT INTO price_observations (source, gtin, query, price_cents, currency, locked, title, url, observed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(r.source, r.gtin, r.query, r.price_cents, r.currency, r.locked, r.title, r.url, r.observed_at).run();
  }
  return batch.length;
}

// Retention: 30 days generally; eBay data may only be kept 6 h (eBay API terms) and Best Buy content 72 h (Best Buy API terms).
export async function purgeObservations(db: D1Database, nowMs: number): Promise<number> {
  const r = await db.prepare(
    `DELETE FROM price_observations WHERE observed_at < ?1 OR (source = 'bestbuy' AND observed_at < ?2) OR (source = 'ebay' AND observed_at < ?3)`,
  ).bind(nowMs - OBSERVATION_RETENTION_MS, nowMs - BESTBUY_RETENTION_MS, nowMs - EBAY_RETENTION_MS).run();
  return r.meta.changes;
}
