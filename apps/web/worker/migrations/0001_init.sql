-- Robinize Worker state. Timestamps are Unix epoch milliseconds. Money is integer (micros / cents), USD only.
CREATE TABLE merchant_listings (
  offer_id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL,
  product_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRY_RUN','SUBMITTED','PROCESSING','APPROVED','DISAPPROVED','DELETED','ERROR')),
  issues_json TEXT,
  price_micros INTEGER NOT NULL CHECK (price_micros > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER
);
CREATE INDEX idx_ml_status ON merchant_listings(status, updated_at);

CREATE TABLE price_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  gtin TEXT,
  query TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
  title TEXT,
  url TEXT,
  observed_at INTEGER NOT NULL
);
CREATE INDEX idx_po_gtin_time ON price_observations(gtin, observed_at);
CREATE INDEX idx_po_source_time ON price_observations(source, observed_at);
