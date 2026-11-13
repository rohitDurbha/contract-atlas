import { describe, it, expect } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement, markDuplicates, feedScopeSql } from '../server/db';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';

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

describe('markDuplicates', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const put = async (db: D1Database, id: string, title: string, location: string, postedAt: string, extra: Record<string, unknown> = {}) => {
    const job = makeJob(SOURCES[0], { sourceJobId: id, title, location, applyUrl: `https://example.com/${id}`, postedAt }, day(0))!;
    await jobStatement(db, { ...job, ...extra }).run();
  };
  const ids = async (db: D1Database, where: string) =>
    (await db.prepare(`SELECT id FROM jobs WHERE ${where} ORDER BY id`).all<any>()).results.map((r: any) => r.id.split(':')[1]);

  it('flags every older repost and keeps the newest posting of each opening', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare('DELETE FROM jobs').run();
      await put(db, 'new', 'Data Engineer', 'Remote', day(2));
      await put(db, 'repost', ' data engineer ', 'REMOTE', day(5));
      await put(db, 'oldest', 'Data Engineer', 'Remote', day(9));
      await put(db, 'other-city', 'Data Engineer', 'Austin, TX', day(5));
      await put(db, 'solo', 'Machine Learning Engineer', 'Remote', day(4));
      const flagged = await markDuplicates(db, now);
      expect(flagged).toBe(2);
      expect(await ids(db, 'duplicate=1')).toEqual(['oldest', 'repost']);
    } finally { close(); }
  });

  it('ignores rows outside the feed so they never hide a listed role', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare('DELETE FROM jobs').run();
      await put(db, 'live', 'Data Engineer', 'Remote', day(10));
      await put(db, 'perm', 'Data Engineer', 'Remote', day(1), { employmentType: 'Permanent' });
      await put(db, 'stale', 'Data Engineer', 'Remote', day(120));
      await put(db, 'closed', 'Data Engineer', 'Remote', day(2));
      await db.prepare("UPDATE jobs SET active=0 WHERE id LIKE '%:closed'").run();
      expect(await markDuplicates(db, now)).toBe(0);
    } finally { close(); }
  });

  it('agrees with the window query the feed runs today', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare('DELETE FROM jobs').run();
      const titles = ['Data Engineer', 'Data Analyst', 'Software Developer'];
      const places = ['Remote', 'Austin, TX'];
      for (let i = 0; i < 24; i++) await put(db, `r${i}`, titles[i % 3], places[i % 2], day(1 + (i % 7)));
      await markDuplicates(db, now);
      // Re-running is stable, so a refresh that changes nothing changes no flags.
      await markDuplicates(db, now);
      const listed = await ids(db, feedScopeSql('', now));
      expect(listed).toHaveLength(6);
      expect(await ids(db, 'duplicate=0')).toEqual(listed);
    } finally { close(); }
  });
});
