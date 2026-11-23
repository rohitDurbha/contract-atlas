import { describe, it, expect } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { boardsInHtml, readAshby, readGreenhouse, readLever, readTeamtailor, readWorkable } from '../server/startups/boards';
import { boardMatches, collectStartups, guessSlugs, resolveCompany, startupCompanies, startupJobs, startupOverview, STARTUP_COMPANIES, type StartupCompany } from '../server/startups/collect';
import { freeFetch } from '../server/free-runtime';

const ashby = {
  jobs: [
    { id: 'a1', title: 'Founding Engineer', team: 'Engineering', location: 'San Francisco', secondaryLocations: [{ location: 'Remote (US)' }], isRemote: false, workplaceType: 'Hybrid', employmentType: 'FullTime', publishedAt: '2026-11-20T10:00:00Z', jobUrl: 'https://jobs.ashbyhq.com/acme/a1', descriptionPlain: 'Acme builds rockets. Join Acme to build Acme engines.', compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 180000, maxValue: 220000 }] } },
    { id: 'a2', title: 'Hidden', isListed: false, location: 'NYC' },
  ],
};

describe('board readers', () => {
  it('reads Ashby roles with pay, teams and remote locations', () => {
    const { roles } = readAshby(ashby, 'acme');
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ id: 'ashby:acme:a1', title: 'Founding Engineer', team: 'Engineering', location: 'San Francisco · Remote (US)', remote: true, employmentType: 'Full Time', payMin: 180000, payMax: 220000, currency: 'USD', payInterval: 'year', url: 'https://jobs.ashbyhq.com/acme/a1' });
  });

  it('reads Greenhouse, Lever, Workable and Teamtailor boards', () => {
    const gh = readGreenhouse({ jobs: [{ id: 7, title: 'ML Engineer', location: { name: 'Remote - US' }, departments: [{ name: 'Research' }], absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/7', first_published: '2026-11-01T00:00:00Z', content: '&lt;p&gt;Hello&lt;/p&gt;' }] }, 'acme', 'Acme');
    expect(gh.roles[0]).toMatchObject({ id: 'greenhouse:acme:7', team: 'Research', remote: true, postedAt: '2026-11-01T00:00:00.000Z' });
    const lever = readLever([{ id: 'x', text: 'Designer', categories: { team: 'Design', location: 'London', commitment: 'Full-time' }, createdAt: 1763000000000, hostedUrl: 'https://jobs.lever.co/acme/x', descriptionPlain: 'Design at Acme', salaryRange: { min: 60000, max: 80000, currency: 'GBP', interval: 'per-year-salary' } }], 'acme');
    expect(lever.roles[0]).toMatchObject({ title: 'Designer', employmentType: 'Full-time', currency: 'GBP', payInterval: 'year', remote: false });
    const wk = readWorkable({ name: 'Open', jobs: [{ title: 'Support Lead', shortcode: 'AB12', telecommuting: true, country: 'Germany', url: 'https://apply.workable.com/j/AB12' }] }, 'open-252');
    expect(wk).toMatchObject({ boardName: 'Open', roles: [{ id: 'workable:open-252:AB12', remote: true, location: 'Germany' }] });
    const tt = readTeamtailor('<rss><channel><item><title>AE</title><link>https://compriai.teamtailor.com/jobs/123-ae</link><pubDate>Mon, 16 Nov 2026 10:00:00 +0100</pubDate><description>&lt;p&gt;Sell&lt;/p&gt;</description></item></channel></rss>', 'compriai');
    expect(tt.roles[0]).toMatchObject({ id: 'teamtailor:compriai:123-ae', title: 'AE', summary: 'Sell' });
  });

  it('finds board links on a careers page and skips path words', () => {
    const html = '<a href="https://jobs.ashbyhq.com/Lightfield/abc">x</a><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script><a href="https://jobs.lever.co/acme-co">y</a><a href="https://jobs.ashbyhq.com/api/x">z</a>';
    expect(boardsInHtml(html)).toEqual([{ ats: 'ashby', board: 'Lightfield' }, { ats: 'greenhouse', board: 'acme' }, { ats: 'lever', board: 'acme-co' }]);
  });
});

describe('matching a company to a board', () => {
  const acme: StartupCompany = { id: 'acme', name: 'Acme Robotics', focus: 'Rockets', location: 'SF', careersUrl: 'https://www.acmerockets.com/careers' };

  it('guesses slugs from the name and the careers domain', () => {
    expect(guessSlugs(acme)).toEqual(['acmerobotics', 'acme-robotics', 'acme', 'acmerockets']);
  });

  it('trusts a guessed board only when the company name shows up', () => {
    const read = readAshby(ashby, 'acme');
    expect(boardMatches({ ...acme, name: 'Acme Labs' }, read)).toBe(false);
    expect(boardMatches({ ...acme, name: 'Acme' }, read)).toBe(false);
    expect(boardMatches({ ...acme, name: 'Acmes' }, read)).toBe(false);
    expect(boardMatches({ ...acme, name: 'Open' }, { ...read, boardName: 'Open' })).toBe(true);
    const named = { ...read, text: 'Acme Robotics is hiring. Acme Robotics ships. At Acme Robotics we test.' };
    expect(boardMatches(acme, named)).toBe(true);
  });
});

function fakeWeb(pages: Record<string, string>) {
  const calls: string[] = [];
  const get = async (url: string) => {
    calls.push(url);
    if (url in pages) return pages[url];
    throw new Error('HTTP 404');
  };
  return { get, calls };
}

describe('resolving and collecting', () => {
  const now = new Date('2026-11-23T12:00:00Z');

  it('follows the seed board, then careers page links, and gives up cleanly', async () => {
    const web = fakeWeb({
      'https://api.ashbyhq.com/posting-api/job-board/omni?includeCompensation=true': JSON.stringify(ashby),
      'https://beta.example/careers': '<a href="https://jobs.lever.co/beta">jobs</a>',
      'https://api.lever.co/v0/postings/beta?mode=json': JSON.stringify([{ id: 'l1', text: 'PM', categories: {}, hostedUrl: 'https://jobs.lever.co/beta/l1' }]),
    });
    expect(await resolveCompany({ id: 'omni', name: 'Omni', focus: '', location: '', ats: 'ashby', board: 'omni' }, web.get)).toMatchObject({ status: 'ok', board: { ats: 'ashby', board: 'omni' } });
    expect(await resolveCompany({ id: 'beta', name: 'Beta', focus: '', location: '', careersUrl: 'https://beta.example/careers' }, web.get)).toMatchObject({ status: 'ok', board: { ats: 'lever', board: 'beta' } });
    expect(await resolveCompany({ id: 'zed', name: 'Zed', focus: '', location: '' }, web.get)).toMatchObject({ status: 'no-board', board: null });
  });

  it('respects a careers page that robots.txt disallows', async () => {
    const web = fakeWeb({ 'https://gamma.example/robots.txt': 'User-agent: *\nDisallow: /careers', 'https://gamma.example/careers': '<a href="https://jobs.lever.co/gamma">x</a>' });
    expect(await resolveCompany({ id: 'gamma', name: 'Gamma', focus: '', location: '', careersUrl: 'https://gamma.example/careers' }, web.get)).toMatchObject({ status: 'blocked' });
    expect(web.calls).not.toContain('https://gamma.example/careers');
  });

  it('stores roles in their own tables, keeps first seen dates and serves them read only', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      const companies: StartupCompany[] = [
        { id: 'omni', name: 'Omni', focus: 'Analytics', location: 'Global', ats: 'ashby', board: 'omni', fastestRank: 27 },
        { id: 'zed', name: 'Zed', focus: 'Editors', location: 'SF' },
      ];
      const web = fakeWeb({ 'https://api.ashbyhq.com/posting-api/job-board/omni?includeCompensation=true': JSON.stringify(ashby) });
      expect(await collectStartups(db, { get: web.get, now, companies })).toMatchObject({ companies: 2, withBoards: 1, roles: 1, checked: 2 });
      const later = new Date(now.getTime() + 2 * 3_600_000);
      const again = fakeWeb({ 'https://api.ashbyhq.com/posting-api/job-board/omni?includeCompensation=true': JSON.stringify(ashby) });
      expect(await collectStartups(db, { get: again.get, now: later, companies })).toMatchObject({ checked: 1 });
      const [job] = await startupJobs(db);
      expect(job).toMatchObject({ companyId: 'omni', firstSeenAt: now.toISOString(), remote: true });
      const failing = fakeWeb({});
      await collectStartups(db, { get: failing.get, now: new Date(later.getTime() + 3_600_000), companies });
      expect(await startupJobs(db)).toHaveLength(1);
      expect(await startupOverview(db, later)).toMatchObject({ roles: 1, withBoards: 1, remoteRoles: 1 });
    } finally {
      close();
    }
  });

  it('drops roles from a guessed board once the company is marked noGuess', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      const text = 'Radiant builds things. Radiant is hiring. Join Radiant.';
      const web = fakeWeb({ 'https://api.ashbyhq.com/posting-api/job-board/radiant?includeCompensation=true': JSON.stringify({ jobs: [{ id: 'r1', title: 'SRE', location: 'UK', descriptionPlain: text }, { id: 'r2', title: 'PM', location: 'UK', descriptionPlain: text }, { id: 'r3', title: 'AE', location: 'UK', descriptionPlain: text }] }) });
      const radiant: StartupCompany = { id: 'radiant', name: 'Radiant', focus: 'Microreactors', location: 'El Segundo' };
      expect(await collectStartups(db, { get: web.get, now, companies: [radiant] })).toMatchObject({ roles: 3 });
      expect(await collectStartups(db, { get: web.get, now: new Date(now.getTime() + 3_600_000), companies: [{ ...radiant, noGuess: true }] })).toMatchObject({ roles: 0, withBoards: 0 });
    } finally {
      close();
    }
  });

  it('answers the StartupAtlas API on a snapshot that has never collected startups', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      const fetcher = freeFetch(db);
      const companies = await (await fetcher(new Request('https://atlas.test/api/startups/companies'))).json() as any[];
      expect(companies).toHaveLength(STARTUP_COMPANIES.length);
      expect(companies.every(c => c.roleCount === 0 && c.status === 'pending')).toBe(true);
      expect(await (await fetcher(new Request('https://atlas.test/api/startups/jobs'))).json()).toEqual([]);
      expect((await fetcher(new Request('https://atlas.test/api/startups/jobs', { method: 'POST' }))).status).not.toBe(200);
    } finally {
      close();
    }
  });
});

describe('the company list', () => {
  it('has unique ids, both lists and the two companies that appear in both', () => {
    const ids = STARTUP_COMPANIES.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(STARTUP_COMPANIES.filter(c => c.fastestRank)).toHaveLength(32);
    expect(STARTUP_COMPANIES.filter(c => c.tier)).toHaveLength(92);
    expect(STARTUP_COMPANIES.filter(c => c.fastestRank && c.tier).map(c => c.name).sort()).toEqual(['Baseten', 'Factory']);
  });
});
