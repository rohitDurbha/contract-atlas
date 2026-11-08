import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement } from '../server/db';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';
import { findSkills, matchResume, tokenize, MAX_RESUME_CHARS } from '../server/resume-match';

const now = new Date('2026-11-06T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

const resume = `Jane Doe, Data Engineer.
Five years building batch and streaming data pipelines in Python and SQL on AWS.
Orchestrated Airflow DAGs, modelled warehouse tables in Snowflake and wrote dbt tests.
Comfortable with Docker and Git. Some Tableau reporting for finance stakeholders.`;

describe('resume tokens and skills', () => {
  it('keeps technical tokens and drops filler words', () => {
    expect(tokenize('Senior C++ / C# developer with 5 years of Node.js and CI/CD.')).toEqual(['senior', 'c++', 'c#', 'developer', 'node.js', 'ci', 'cd']);
  });

  it('finds skills by whole name, alias and listed role skill', () => {
    expect(findSkills('Built k8s operators in Golang, plus PySpark jobs and ASP.NET services.')).toEqual(expect.arrayContaining(['Kubernetes', 'Go', 'Spark', '.NET']));
    expect(findSkills('Worked on the rest of the backlog and enjoyed going outside.')).not.toEqual(expect.arrayContaining(['REST']));
    expect(findSkills('Fluent in R and Excel')).toEqual(expect.arrayContaining(['R', 'Excel']));
    expect(findSkills('A great reader and writer')).not.toContain('R');
    expect(findSkills('Strong Verbal Communication', ['Verbal Communication', 'A very long listed skill phrase here'])).toEqual(['Verbal Communication']);
  });
});

describe('resume matching on a controlled database', () => {
  const sqlite = openSQLite(':memory:');
  const add = (source: number, id: string, title: string, posted: number, description: string, extra: Record<string, unknown> = {}) =>
    jobStatement(sqlite.db, makeJob(SOURCES[source], { sourceJobId: id, title, applyUrl: 'https://example.com/jobs/' + id, postedAt: daysAgo(posted), description, ...extra }, now.toISOString())!).run();

  beforeAll(async () => {
    await ensureDB(sqlite.db);
    await sqlite.db.prepare('DELETE FROM jobs').run();
    await add(0, 'de', 'Data Engineer', 1, 'Build data pipelines with Python, SQL, Airflow and Snowflake on AWS. Kafka a plus.', { location: 'Seattle, WA' });
    await add(0, 'fe', 'Frontend Software Engineer', 2, 'Ship React and TypeScript interfaces with Cypress tests.', { location: 'Remote', workMode: 'Remote' });
    await add(1, 'ml', 'Machine Learning Engineer', 3, 'Train PyTorch models in Python and deploy them with Docker and Kubernetes.', { location: 'Austin, TX', skills: ['Python', 'PyTorch', 'Kubernetes'] });
    await add(1, 'bi', 'Business Intelligence Analyst', 4, 'Build Tableau and Power BI dashboards from SQL sources for finance.', { location: 'Seattle, WA' });
    // Outside the feed, so never matched even though they share words.
    await add(1, 'old', 'Data Engineer', 120, 'Python SQL Airflow Snowflake AWS dbt pipelines.');
    await add(1, 'retail', 'Retail Associate', 1, 'Python SQL Airflow Snowflake pipelines.');
  });
  afterAll(() => sqlite.close());

  it('ranks the closest role first and explains the overlap', async () => {
    const result = await matchResume(sqlite.db, resume, { now });
    expect(result.rolesCompared).toBe(4);
    expect(result.matches[0].job.id).toBe(`${SOURCES[0].id}:de`);
    expect(result.matches.map(m => m.job.id)).not.toContain(`${SOURCES[1].id}:old`);
    expect(result.matches.map(m => m.job.id)).not.toContain(`${SOURCES[1].id}:retail`);
    const top = result.matches[0];
    expect(top.similarity).toBeGreaterThan(0);
    expect(top.similarity).toBeLessThanOrEqual(1);
    expect(top.matchedSkills).toEqual(expect.arrayContaining(['Python', 'SQL', 'Airflow', 'Snowflake', 'AWS']));
    expect(top.missingSkills).toEqual(['Kafka']);
    expect(top.sharedTerms).toContain('pipelines');
    for (let i = 1; i < result.matches.length; i++) expect(result.matches[i].similarity).toBeLessThanOrEqual(result.matches[i - 1].similarity);
    expect(result.resume.skills).toEqual(expect.arrayContaining(['Python', 'SQL', 'dbt', 'Docker', 'Tableau']));
  });

  it('collects the skills the best matches ask for that the resume lacks', async () => {
    const result = await matchResume(sqlite.db, resume, { now });
    const gaps = Object.fromEntries(result.skillGaps.map(g => [g.skill, g.roles]));
    expect(gaps.Kafka).toBe(1);
    expect(gaps.PyTorch).toBe(1);
    expect(gaps.Python).toBeUndefined();
  });

  it('narrows by category, work mode, location and limit', async () => {
    expect((await matchResume(sqlite.db, resume, { now, workMode: 'Remote' })).matches.map(m => m.job.title)).toEqual(['Frontend Software Engineer']);
    expect((await matchResume(sqlite.db, resume, { now, location: 'austin' })).rolesCompared).toBe(1);
    const data = await matchResume(sqlite.db, resume, { now, category: 'Data & Analytics' });
    expect(data.matches.every(m => m.job.category === 'Data & Analytics')).toBe(true);
    expect((await matchResume(sqlite.db, resume, { now, limit: 1 })).matches).toHaveLength(1);
  });

  it('returns no matches for text that shares nothing with the feed', async () => {
    const result = await matchResume(sqlite.db, 'Pastry chef who laminates croissant dough and tempers chocolate every morning.', { now });
    expect(result.matches).toEqual([]);
    expect(result.resume.skills).toEqual([]);
  });

  it('compares only the first part of a very long resume and says so', async () => {
    const long = resume + ' filler'.repeat(MAX_RESUME_CHARS);
    const result = await matchResume(sqlite.db, long, { now });
    expect(result.resume.characters).toBe(MAX_RESUME_CHARS);
    expect(result.notes.join(' ')).toContain(String(MAX_RESUME_CHARS));
  });
});
