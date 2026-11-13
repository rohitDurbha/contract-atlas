import { describe, it, expect } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB } from '../server/db';

const columns = async (db: D1Database) =>
  (await db.prepare("SELECT name FROM pragma_table_info('jobs')").all<any>()).results.map((r: any) => r.name);

describe('duplicate column migration', () => {
  it('creates the duplicate column on a fresh snapshot', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      expect(await columns(db)).toContain('duplicate');
    } finally { close(); }
  });

  it('adds the duplicate column to a snapshot that predates it and keeps its rows', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,company TEXT NOT NULL,title TEXT NOT NULL,location TEXT NOT NULL,country TEXT NOT NULL,work_mode TEXT NOT NULL,category TEXT NOT NULL,pay_min REAL,pay_max REAL,posted_at TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,apply_url TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,UNIQUE(source_id,apply_url))');
      await db.exec("INSERT INTO jobs(id,source_id,company,title,location,country,work_mode,category,first_seen_at,last_seen_at,apply_url,data) VALUES('old:1','old','Acme','Data Engineer','Remote','US','Remote','Data','2026-11-01','2026-11-01','https://example.com/1','{}')");
      await ensureDB(db);
      expect(await columns(db)).toContain('duplicate');
      const row = await db.prepare("SELECT duplicate FROM jobs WHERE id='old:1'").first<any>();
      expect(row.duplicate).toBe(0);
    } finally { close(); }
  });
});
