CREATE TABLE IF NOT EXISTS source_coverage (
  source_id TEXT PRIMARY KEY,
  complete INTEGER NOT NULL DEFAULT 0,
  advertised_count INTEGER,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL
);
