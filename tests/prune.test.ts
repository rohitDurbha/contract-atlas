import { describe, it, expect } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement } from '../server/db';
import { makeJob } from '../server/normalize';
import { pruneSnapshot } from '../server/prune';
import { SOURCES } from '../server/sources';

describe('snapshot pruning', () => {
  it('removes rows that can never be listed again and keeps live ones', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare('DELETE FROM jobs').run();
      const now = new Date('2026-11-01T00:00:00Z');
      const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
      const put = async (id: string, postedAt: string, extra: Record<string, unknown> = {}, sourceId = SOURCES[0].id) => {
        const job = makeJob({ ...SOURCES[0], id: sourceId }, { sourceJobId: id, title: 'Data Engineer', applyUrl: `https://example.com/${id}`, postedAt }, day(0))!;
        await jobStatement(db, { ...job, ...extra }).run();
      };
      await put('live', day(3));
      await put('old', day(200));
      await put('perm', day(3), { employmentType: 'Perm' });
      await put('retired', day(3), {}, 'barclays');
      await put('closed', day(3));
      await db.prepare("UPDATE jobs SET active=0,last_seen_at=? WHERE id LIKE '%:closed'").bind(day(30)).run();
      const result = await pruneSnapshot(db, now);
      const left = (await db.prepare('SELECT id FROM jobs ORDER BY id').all<any>()).results.map((r: any) => r.id);
      expect(left).toEqual([`${SOURCES[0].id}:live`]);
      expect(result.removedJobs).toBe(4);
    } finally { close(); }
  });
});
