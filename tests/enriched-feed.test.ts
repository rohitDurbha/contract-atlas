import { describe, it, expect } from 'vitest';
import worker from '../server/index';
import { applyEnrichment, ensureDB, getFeedJob, hasEnrichment, jobFeed, jobStatement, type EnrichmentRow } from '../server/db';
import { saveEnrichment, type Enrichment } from '../server/enrichment';
import { matchResume } from '../server/resume-match';
import { semanticSearch, saveEmbedding, EMBEDDING_MODEL } from '../server/embeddings';
import { createAtlasMcpHandler } from '../server/mcp';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';
import { openSQLite } from '../server/sqlite';
import type { Database } from '../server/database';
import type { Job } from '../src/types';

const provider = { name: 'groq' as const, model: 'test-model', apiKey: 'k' };
const answer = (over: Partial<Enrichment> = {}): Enrichment => ({
  skills: ['Python', 'Airflow'], seniority: 'senior', normalizedTitle: 'Senior Data Engineer', remote: 'remote', hourlyPayMin: null, hourlyPayMax: null, ...over,
});
const row = (over: Partial<EnrichmentRow> = {}): EnrichmentRow => ({
  job_id: 'x', skills: '["Python","Airflow"]', seniority: 'senior', normalized_title: 'Senior Data Engineer', remote: 'remote', ...over,
});

const recent = new Date(Date.now() - 86_400_000).toISOString();
const id = (key: string) => `${SOURCES[0].id}:${key}`;

// Three feed roles. "a" is listed on-site with regex skills and gets an
// enrichment that says remote, "b" is listed remote with no enrichment, and
// "c" is enriched with unknown labels and no skills, so its listing stands.
async function seeded(): Promise<Database> {
  const db = openSQLite(':memory:').db;
  await ensureDB(db);
  await db.prepare('DELETE FROM jobs').run();
  const add = (key: string, title: string, location: string, workMode: Job['workMode'], description: string) =>
    jobStatement(db, makeJob(SOURCES[0], { sourceJobId: key, title, location, workMode, applyUrl: `https://example.com/jobs/${key}`, postedAt: recent, description }, recent)!).run();
  await add('a', 'Sr. Data Engineer (W2 Contract) - Req 4471', 'Austin, TX', 'On-site', 'Build data pipelines with Python and Airflow for analytics teams across the company.');
  await add('b', 'Software Engineer', 'Remote', 'Remote', 'Write TypeScript and React software for internal tools used by analysts.');
  await add('c', 'Data Analyst', 'Denver, CO', 'Unspecified', 'Report on sales data with SQL and Tableau dashboards.');
  await saveEnrichment(db, id('a'), 'h', { enrichment: answer(), provider });
  await saveEnrichment(db, id('c'), 'h', { enrichment: answer({ skills: [], seniority: 'unknown', normalizedTitle: '', remote: 'unknown' }), provider });
  return db;
}

describe('applying stored enrichment to a role', () => {
  const job = { id: 'x', title: 'Sr. Data Eng', workMode: 'On-site', skills: ['SQL'] } as Job;

  it('prefers enriched skills and a known work mode and adds seniority and the normalized title', () => {
    expect(applyEnrichment(job, row())).toMatchObject({ skills: ['Python', 'Airflow'], workMode: 'Remote', seniority: 'senior', normalizedTitle: 'Senior Data Engineer', enriched: true });
    expect(applyEnrichment(job, row({ remote: 'onsite' })).workMode).toBe('On-site');
    expect(applyEnrichment(job, row({ remote: 'hybrid' })).workMode).toBe('Hybrid');
  });

  it('keeps the listing when the answer is unknown, empty or malformed', () => {
    const kept = applyEnrichment(job, row({ skills: '[]', seniority: 'unknown', normalized_title: ' ', remote: 'unknown' }));
    expect(kept).toEqual(job);
    expect(applyEnrichment(job, row({ skills: 'not json' })).skills).toEqual(['SQL']);
    expect(applyEnrichment(job, undefined)).toBe(job);
  });

  it('leaves the original role untouched', () => {
    applyEnrichment(job, row());
    expect(job.skills).toEqual(['SQL']);
    expect(job.workMode).toBe('On-site');
  });
});

describe('enrichment in the feed, the API and the MCP tools', () => {
  it('returns enriched roles from the feed and the detail route', async () => {
    const db = await seeded();
    const feed = await jobFeed(db, new URLSearchParams());
    const a = feed.jobs.find(j => j.id === id('a'))!;
    expect(a).toMatchObject({ workMode: 'Remote', skills: ['Python', 'Airflow'], seniority: 'senior', normalizedTitle: 'Senior Data Engineer', enriched: true });
    expect(a.title).toBe('Sr. Data Engineer (W2 Contract) - Req 4471');
    const c = feed.jobs.find(j => j.id === id('c'))!;
    expect(c.enriched).toBeUndefined();
    expect(c.seniority).toBeUndefined();
    expect(feed.jobs.find(j => j.id === id('b'))!.enriched).toBeUndefined();
    expect(await (await worker.fetch(new Request(`https://atlas.test/api/jobs/${id('a')}`), { DB: db })).json()).toMatchObject({ workMode: 'Remote', seniority: 'senior' });
    expect(await getFeedJob(db, id('c'))).toMatchObject({ workMode: c.workMode });
  });

  it('filters and counts by the work mode the cards show', async () => {
    const db = await seeded();
    const remote = await jobFeed(db, new URLSearchParams('mode=Remote'));
    expect(remote.jobs.map(j => j.id).sort()).toEqual([id('a'), id('b')]);
    expect((await jobFeed(db, new URLSearchParams('mode=On-site'))).total).toBe(0);
    const overview = await (await worker.fetch(new Request('https://atlas.test/api/overview'), { DB: db })).json() as { remoteJobs: number };
    expect(overview.remoteJobs).toBe(2);
  });

  it('uses enriched work mode and skills in resume match and semantic search', async () => {
    const db = await seeded();
    const resume = 'Senior data engineer with eight years of Python and Airflow experience building batch pipelines and analytics models.';
    const matched = await matchResume(db, resume, { workMode: 'Remote' });
    expect(matched.matches.map(m => m.job.id)).toContain(id('a'));
    expect(matched.matches.find(m => m.job.id === id('a'))!.matchedSkills).toEqual(expect.arrayContaining(['Python', 'Airflow']));
    await saveEmbedding(db, id('a'), 'h', EMBEDDING_MODEL.name, [1, 0, 0]);
    const ranked = await semanticSearch(db, [1, 0, 0], { workMode: 'Remote' });
    expect(ranked.matches.map(m => m.job.id)).toEqual([id('a')]);
  });

  it('adds seniority and the normalized title to MCP summaries', async () => {
    const db = await seeded();
    const handler = createAtlasMcpHandler(db);
    const response = await handler.fetch(new Request('https://atlas.test/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_jobs', arguments: { workMode: ['Remote'] } } }),
    }));
    const body = await response.text();
    const json = body.trimStart().startsWith('{') ? body : body.split('\n').find(line => line.startsWith('data: '))!.slice(6);
    const jobs = JSON.parse(json).result.structuredContent.jobs as Record<string, unknown>[];
    expect(jobs.find(j => j.id === id('a'))).toMatchObject({ normalizedTitle: 'Senior Data Engineer', seniority: 'senior', workMode: 'Remote', skills: ['Python', 'Airflow'] });
    expect(jobs.find(j => j.id === id('b'))).not.toHaveProperty('seniority');
  });

  it('reads older snapshots without the enrichment table as before', async () => {
    const db = await seeded();
    await db.prepare('DROP TABLE job_enrichment').run();
    expect(await hasEnrichment(db)).toBe(false);
    const feed = await jobFeed(db, new URLSearchParams('mode=Remote'));
    expect(feed.jobs.map(j => j.id)).toEqual([id('b')]);
    expect(feed.jobs[0].enriched).toBeUndefined();
  });
});
