import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement } from '../server/db';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';
import { marketTrends, MAX_TREND_WEEKS } from '../server/trends';

const DAY = 86_400_000;
// A Friday, so week buckets start on the Mondays before it.
const now = new Date('2026-11-06T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

describe('market trends', () => {
  const sqlite = openSQLite(':memory:');

  beforeAll(async () => {
    await ensureDB(sqlite.db);
    await sqlite.db.prepare('DELETE FROM jobs').run();
    const add = (source: number, id: string, title: string, posted: number, extra: Record<string, unknown> = {}) =>
      jobStatement(sqlite.db, makeJob(SOURCES[source], { sourceJobId: id, title, applyUrl: 'https://example.com/jobs/' + id, postedAt: daysAgo(posted), description: 'Contract role.', ...extra }, now.toISOString())!).run();
    const usd = (min: number, max: number) => ({ payMin: min, payMax: max, payPeriod: 'hour', currency: 'USD' });
    await add(0, 'a', 'Software Engineer', 1, { skills: ['Python', 'SQL'], ...usd(60, 80) });
    await add(0, 'b', 'Software Engineer', 2, { location: 'Austin, TX', skills: ['Python'], ...usd(40, 60) });
    await add(1, 'c', 'Data Engineer', 3, { skills: ['SQL'], ...usd(90, 110) });
    await add(1, 'd', 'Data Analyst', 40, { skills: ['SQL', 'Excel'], payMin: 50, payPeriod: 'hourly', currency: 'CAD' });
    await add(0, 'e', 'Cloud Engineer', 35, { skills: ['Azure'], payMin: 150000, payMax: 180000, payPeriod: 'year', currency: 'USD' });
    // Outside the feed: a repost of "a", a non-technical role, an hourly rate
    // that is clearly a salary, and a role older than the default twelve weeks but still in the feed.
    await add(0, 'a-repost', 'Software Engineer', 5, { skills: ['Python'], ...usd(60, 80) });
    await add(1, 'retail', 'Retail Associate', 1, { skills: ['Python'] });
    await add(1, 'typo', 'Platform Engineer', 2, { skills: ['Go'], ...usd(120000, 140000) });
    await add(1, 'old', 'Data Scientist', 87, { skills: ['R'] });
  });
  afterAll(() => sqlite.close());

  it('counts only roles the site lists inside the window', async () => {
    const t = await marketTrends(sqlite.db, { weeks: 8, now });
    expect(t.window.weeks).toBe(8);
    expect(t.totals).toEqual({ roles: 6, companies: 2, withHourlyPay: 4 });
    expect(t.categories).toEqual([
      { name: 'Engineering & IT', roles: 4, share: 0.667 },
      { name: 'Data & Analytics', roles: 2, share: 0.333 },
    ]);
  });

  it('buckets weekly volume by the Monday that starts each week', async () => {
    const { volume } = await marketTrends(sqlite.db, { weeks: 8, now });
    expect(volume.map(v => v.weekStart)).toEqual(['2026-09-21', '2026-09-28', '2026-11-02']);
    const current = volume.at(-1)!;
    expect(current.roles).toBe(4);
    expect(current.withHourlyPay).toBe(3);
    // Midpoints 70, 50 and 100. The salary typo is not counted.
    expect(current.avgHourlyUsd).toBe(73.33);
  });

  it('ranks skills and compares the last four weeks with the four before', async () => {
    const { topSkills } = await marketTrends(sqlite.db, { weeks: 8, now });
    expect(topSkills[0]).toEqual({ name: 'SQL', roles: 3, share: 0.5, recent: 2, prior: 1 });
    expect(topSkills.find(s => s.name === 'Python')).toMatchObject({ roles: 2, recent: 2, prior: 0 });
    expect(topSkills.map(s => s.name)).not.toContain('R');
    expect((await marketTrends(sqlite.db, { weeks: 8, skillLimit: 1, now })).topSkills).toHaveLength(1);
  });

  it('reports hourly pay quartiles per currency and category', async () => {
    const { pay } = await marketTrends(sqlite.db, { weeks: 8, now });
    expect(pay.overall).toEqual([
      { currency: 'USD', roles: 3, min: 50, p25: 50, median: 70, p75: 100, max: 100 },
      { currency: 'CAD', roles: 1, min: 50, p25: 50, median: 50, p75: 50, max: 50 },
    ]);
    expect(pay.byCategory.find(r => r.category === 'Data & Analytics' && r.currency === 'USD')).toMatchObject({ roles: 1, median: 100 });
  });

  it('narrows to a category or company and clamps the window', async () => {
    const data = await marketTrends(sqlite.db, { category: 'Data & Analytics', now });
    expect(data.totals.roles).toBe(2);
    expect(data.categories.map(c => c.name)).toEqual(['Data & Analytics']);
    const company = await marketTrends(sqlite.db, { company: SOURCES[1].company, weeks: 2, now });
    expect(company.totals.roles).toBe(2);
    const wide = await marketTrends(sqlite.db, { weeks: 99, now });
    expect(wide.window.weeks).toBe(MAX_TREND_WEEKS);
    expect(wide.totals.roles).toBe(7);
    const empty = await marketTrends(sqlite.db, { company: 'Nobody', now });
    expect(empty.totals.roles).toBe(0);
    expect(empty.pay.overall).toEqual([]);
  });
});
