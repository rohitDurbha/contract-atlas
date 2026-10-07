CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, company TEXT NOT NULL, provider TEXT NOT NULL,
 url TEXT NOT NULL, country TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 last_checked_at TEXT, last_success_at TEXT, message TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), company TEXT NOT NULL,
 title TEXT NOT NULL, location TEXT NOT NULL, country TEXT NOT NULL,
 work_mode TEXT NOT NULL, category TEXT NOT NULL, pay_min REAL, pay_max REAL,
 posted_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
 apply_url TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL,
 UNIQUE(source_id,apply_url)
);
CREATE INDEX IF NOT EXISTS jobs_freshness ON jobs(active,posted_at DESC,first_seen_at DESC);
CREATE INDEX IF NOT EXISTS jobs_filters ON jobs(company,category,work_mode);
CREATE INDEX IF NOT EXISTS jobs_sources ON jobs(source_id,active,last_seen_at);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL,
 completed_at TEXT, source_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
 new_count INTEGER NOT NULL DEFAULT 0, job_count INTEGER NOT NULL DEFAULT 0,cursor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
