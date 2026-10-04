-- Market snapshot state for GET /api/market/snapshot (BlindBook on Robinhood Chain Testnet), written by the every-minute cron.
-- Only public on-chain data. Blocks and epochs are integers; times are Unix seconds (head_time) or epoch ms (updated_at, built_at).
CREATE TABLE IF NOT EXISTS mk_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  book TEXT NOT NULL,
  deploy_block INTEGER NOT NULL,
  schedule_json TEXT,
  next_block INTEGER NOT NULL,
  anchor_block INTEGER,
  anchor_hash TEXT,
  head_block INTEGER NOT NULL DEFAULT 0,
  head_time INTEGER NOT NULL DEFAULT 0,
  cold_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  -- ms timestamp until which one cron run owns the ingest (see acquireLease); 0 = free. A crashed run blocks the next ones for 2 minutes at most.
  lease_until INTEGER NOT NULL DEFAULT 0
);

-- One row per (market, epoch) that has any event. book_json keeps commit hashes (the merge source of truth); lite_json is the
-- same book without hashes (what the snapshot ships for older epochs); clear_json is the epoch's clearing result, if any.
CREATE TABLE IF NOT EXISTS mk_epochs (
  market TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  first_block INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  book_json TEXT NOT NULL,
  lite_json TEXT NOT NULL,
  clear_json TEXT,
  PRIMARY KEY (market, epoch)
);
CREATE INDEX IF NOT EXISTS idx_mk_epochs_epoch ON mk_epochs(epoch);
-- Reorg rewind (rewindStart / deleteFromBlock) selects by last_block: without this index each rewind reads every row.
CREATE INDEX IF NOT EXISTS idx_mk_epochs_last ON mk_epochs(last_block);

-- Pre-serialized snapshot parts: 'cold' (compacted old clears, rebuilt about hourly) and 'hot' (recent books, rebuilt on change).
CREATE TABLE IF NOT EXISTS mk_snapshot (
  part TEXT PRIMARY KEY CHECK (part IN ('hot', 'cold')),
  body TEXT NOT NULL,
  built_at INTEGER NOT NULL
);
