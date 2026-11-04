// Read-only Model Context Protocol server for the public contract-role feed.
// Every tool reads through the same helpers as the website, so an assistant
// sees exactly the roles, counts and sources a visitor would see.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getFeedJob, jobFeed, listSources } from './db.js';
import type { Job } from '../src/types.js';

const SERVER_INFO = { name: 'contract-atlas', title: 'Contract Atlas', version: '1.0.0' };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SUMMARY_CHARS = 280;

const list = z.array(z.string().trim().min(1).max(100)).max(20).optional();
export const searchJobsInput = z.object({
  query: z.string().trim().max(150).optional().describe('Free text matched against title, company, location and description.'),
  location: z.string().trim().max(100).optional().describe('Part of a location name, for example "Seattle" or "Remote".'),
  company: list.describe('Exact company names, for example ["Meta","Microsoft"].'),
  category: list.describe('Exact role categories as returned in the facets.'),
  workMode: z.array(z.enum(['Remote', 'Hybrid', 'On-site', 'Unspecified'])).max(4).optional(),
  country: list.describe('Exact country labels as returned in the facets.'),
  postedWithin: z.enum(['24h', '7d', '30d']).optional().describe('Only roles posted within this window.'),
  payListed: z.boolean().optional().describe('Only roles that list a pay rate.'),
  sort: z.enum(['newest', 'discovered', 'company', 'pay']).optional().describe('"pay" keeps only USD hourly roles and sorts by the top of the range.'),
  page: z.number().int().min(1).max(500).optional(),
});

function feedParams(input: z.infer<typeof searchJobsInput>): URLSearchParams {
  const p = new URLSearchParams();
  if (input.query) p.set('q', input.query);
  if (input.location) p.set('location', input.location);
  for (const value of input.company ?? []) p.append('company', value);
  for (const value of input.category ?? []) p.append('category', value);
  for (const value of input.workMode ?? []) p.append('mode', value);
  for (const value of input.country ?? []) p.append('country', value);
  if (input.postedWithin) p.set('freshness', input.postedWithin);
  if (input.payListed) p.set('pay', 'yes');
  if (input.sort && input.sort !== 'newest') p.set('sort', input.sort);
  if (input.page) p.set('page', String(input.page));
  return p;
}

function pay(job: Job): string | null {
  if (job.payMin == null && job.payMax == null) return null;
  const range = job.payMin != null && job.payMax != null && job.payMin !== job.payMax ? `${job.payMin}-${job.payMax}` : String(job.payMin ?? job.payMax);
  return [job.currency, range, job.payPeriod ? `per ${job.payPeriod}` : null].filter(Boolean).join(' ');
}

function summary(job: Job) {
  const text = job.description.replace(/\s+/g, ' ').trim();
  return {
    id: job.id, title: job.title, company: job.company, location: job.location, workMode: job.workMode,
    category: job.category, pay: pay(job), duration: job.duration, postedAt: job.postedAt,
    skills: job.skills.slice(0, 12), applyUrl: job.applyUrl,
    snippet: text.length > SUMMARY_CHARS ? text.slice(0, SUMMARY_CHARS).trimEnd() + '...' : text,
  };
}

function result(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

export function buildMcpServer(db: D1Database): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: 'Contract Atlas lists technical contract roles from public staffing and vendor-management boards over the last 90 days. All tools are read-only. Use search_jobs to find roles, get_job for the full posting and list_sources to see which boards are covered and how fresh they are.',
  });

  server.registerTool('search_jobs', {
    title: 'Search contract roles',
    description: 'Search current technical contract roles. Returns 18 roles per page with short summaries, the total match count and facet values (companies, categories, countries) that can be used as filters.',
    inputSchema: searchJobsInput,
    annotations: READ_ONLY,
  }, async input => {
    const feed = await jobFeed(db, feedParams(input));
    return result({
      total: feed.total, page: feed.page, pages: feed.pages,
      jobs: feed.jobs.map(summary),
      facets: { companies: feed.facets.companies, categories: feed.facets.categories, countries: feed.facets.countries },
    });
  });

  server.registerTool('get_job', {
    title: 'Get a contract role',
    description: 'Fetch one role by the id returned from search_jobs, including the full description, skills, pay and apply link.',
    inputSchema: z.object({ id: z.string().trim().min(1).max(200).describe('Role id such as "meta:12345".') }),
    annotations: READ_ONLY,
  }, async ({ id }) => {
    const job = await getFeedJob(db, id);
    if (!job) return { content: [{ type: 'text' as const, text: `No current role has the id "${id}". It may have closed or aged out of the 90-day window.` }], isError: true };
    const { active: _active, ...rest } = job;
    return result({ ...rest, pay: pay(job) });
  });

  server.registerTool('list_sources', {
    title: 'List job sources',
    description: 'List every job board Contract Atlas collects from, with its health, coverage, last successful check and number of current roles.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, async () => {
    const sources = await listSources(db);
    return result({ count: sources.length, sources });
  });

  return server;
}

// Stateless Streamable HTTP handler. A fresh server is built per request, which
// suits a serverless function that keeps no session state between calls.
export function createAtlasMcpHandler(db: D1Database) {
  return createMcpHandler(() => buildMcpServer(db), {
    onerror: error => console.error(JSON.stringify({ level: 'error', message: error.message, path: '/api/mcp', timestamp: new Date().toISOString() })),
  });
}
