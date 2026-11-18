import { describe, it, expect } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement, markDuplicates, feedScopeSql, windowScopeSql, duplicateFlagDrift } from '../server/db';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';
import type { Database } from '../server/database.js';

const columns = async (db: Database) =>
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
      expect(await indexes(db)).toContain('jobs_feed');
    } finally { close(); }
  });
});

const indexes = async (db: Database) =>
  (await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'").all<any>()).results.map((r: any) => r.name);

describe('feed index', () => {
  it('replaces the old freshness index with one that covers the flag', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,company TEXT NOT NULL,title TEXT NOT NULL,location TEXT NOT NULL,country TEXT NOT NULL,work_mode TEXT NOT NULL,category TEXT NOT NULL,pay_min REAL,pay_max REAL,posted_at TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,apply_url TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,UNIQUE(source_id,apply_url))');
      await db.exec('CREATE INDEX jobs_freshness ON jobs(active,posted_at DESC,first_seen_at DESC)');
      await ensureDB(db);
      const names = await indexes(db);
      expect(names).toContain('jobs_feed');
      expect(names).not.toContain('jobs_freshness');
    } finally { close(); }
  });

  it('is the index feed queries search with', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      const plan = async (sql: string) =>
        (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<any>()).results.map((r: any) => r.detail).join(' | ');
      const count = await plan(`SELECT count(*) FROM jobs WHERE ${feedScopeSql()}`);
      expect(count).toContain('jobs_feed (active=? AND duplicate=?)');
      // The default listing order comes straight from the index, so the
      // first page can stop after enough rows instead of sorting them all.
      const page = await plan(`SELECT * FROM jobs WHERE ${feedScopeSql()} ORDER BY posted_at DESC, first_seen_at DESC LIMIT 18`);
      expect(page).toContain('jobs_feed');
      expect(page).not.toContain('TEMP B-TREE');
    } finally { close(); }
  });
});

describe('markDuplicates', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const put = async (db: Database, id: string, title: string, location: string, postedAt: string, extra: Record<string, unknown> = {}) => {
    const job = makeJob(SOURCES[0], { sourceJobId: id, title, location, applyUrl: `https://example.com/${id}`, postedAt }, day(0))!;
    await jobStatement(db, { ...job, ...extra }).run();
  };
  const ids = async (db: Database, where: string) =>
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

  it('lists exactly what the window query would list', async () => {
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
      expect(listed).toEqual(await ids(db, windowScopeSql(now)));
    } finally { close(); }
  });
});

describe('feed scope with stored flags', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it('hides a flagged row even when no newer copy exists', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare('DELETE FROM jobs').run();
      const job = makeJob(SOURCES[0], { sourceJobId: 'only', title: 'Data Engineer', location: 'Remote', applyUrl: 'https://example.com/only', postedAt: day(1) }, day(0))!;
      await jobStatement(db, job).run();
      const listed = async () => (await db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${feedScopeSql('', now)}`).first<any>()).n;
      expect(await listed()).toBe(1);
      await db.prepare('UPDATE jobs SET duplicate=1').run();
      expect(await listed()).toBe(0);
      // A refresh clears a stale flag once the row is the newest copy again.
      await markDuplicates(db, now);
      expect(await listed()).toBe(1);
    } finally { close(); }
  });

  it('keeps an upsert from resetting a stored flag', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare('DELETE FROM jobs').run();
      const job = makeJob(SOURCES[0], { sourceJobId: 'kept', title: 'Data Engineer', location: 'Remote', applyUrl: 'https://example.com/kept', postedAt: day(1) }, day(0))!;
      await jobStatement(db, job).run();
      await db.prepare('UPDATE jobs SET duplicate=1').run();
      await jobStatement(db, { ...job, title: 'Senior Data Engineer' }).run();
      expect((await db.prepare('SELECT duplicate FROM jobs').first<any>()).duplicate).toBe(1);
    } finally { close(); }
  });

  it('flags the seeded snapshot so a fresh database matches the window query', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      const flagged = await db.prepare(`SELECT id FROM jobs WHERE ${feedScopeSql()} ORDER BY id`).all<any>();
      const ranked = await db.prepare(`SELECT id FROM jobs WHERE ${windowScopeSql()} ORDER BY id`).all<any>();
      expect(flagged.results).toEqual(ranked.results);
    } finally { close(); }
  });
});

describe('duplicateFlagDrift', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const put = async (db: Database, id: string, postedAt: string) => {
    const job = makeJob(SOURCES[0], { sourceJobId: id, title: 'Data Engineer', location: 'Remote', applyUrl: `https://example.com/${id}`, postedAt }, day(0))!;
    await jobStatement(db, job).run();
  };
  const setup = async () => {
    const opened = openSQLite(':memory:');
    await ensureDB(opened.db);
    await opened.db.prepare('DELETE FROM jobs').run();
    await put(opened.db, 'new', day(1));
    await put(opened.db, 'old', day(4));
    return opened;
  };

  it('reports nothing when the flags are current', async () => {
    const { db, close } = await setup();
    try {
      await markDuplicates(db, now);
      expect(await duplicateFlagDrift(db, now)).toEqual({ hidden: [], extra: [] });
    } finally { close(); }
  });

  it('reports reposts that were never flagged', async () => {
    const { db, close } = await setup();
    try {
      // New rows arrive unflagged, so skipping markDuplicates lists both copies.
      expect(await duplicateFlagDrift(db, now)).toEqual({ hidden: [], extra: [`${SOURCES[0].id}:old`] });
    } finally { close(); }
  });

  it('reports a listed role that a stale flag hides', async () => {
    const { db, close } = await setup();
    try {
      await markDuplicates(db, now);
      await db.prepare("UPDATE jobs SET duplicate=1 WHERE id LIKE '%:new'").run();
      expect(await duplicateFlagDrift(db, now)).toEqual({ hidden: [`${SOURCES[0].id}:new`], extra: [] });
    } finally { close(); }
  });
});
