// Read-only Model Context Protocol server for the public contract-role feed.
// Every tool reads through the same helpers as the website, so an assistant
// sees exactly the roles, counts and sources a visitor would see.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getFeedJob, jobFeed, listSources } from './db.js';
import { marketTrends, MAX_TREND_WEEKS } from './trends.js';
import { estimatePay, type PayFeatures, type PayModel } from './pay-model.js';
import { matchResume, MAX_MATCHES, MAX_RESUME_CHARS, MIN_RESUME_CHARS } from './resume-match.js';
import type { Job } from '../src/types.js';

export const SERVER_INFO = { name: 'contract-atlas', title: 'Contract Atlas', version: '1.0.0' };
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

export interface AtlasMcpOptions {
  // Returns the pay model trained during the last refresh, or null when none ships.
  payModel?: () => PayModel | null;
}

export const estimatePayInput = z.object({
  id: z.string().trim().min(1).max(200).optional().describe('Estimate for a current role by its search_jobs id. Its title, skills, category, location and company are used, and any other fields given here override them.'),
  title: z.string().trim().min(2).max(150).optional().describe('Role title, for example "Senior Data Engineer". Required unless id is given.'),
  skills: z.array(z.string().trim().min(1).max(60)).max(20).optional().describe('Skills such as ["Python","SQL"].'),
  category: z.string().trim().min(1).max(100).optional().describe('Exact category as returned in the search_jobs facets.'),
  location: z.string().trim().min(1).max(100).optional().describe('Location such as "Seattle, WA". A US state or Canadian province code helps most.'),
  country: z.string().trim().min(2).max(3).optional().describe('Two-letter country code such as "US".'),
  workMode: z.enum(['Remote', 'Hybrid', 'On-site']).optional(),
  company: z.string().trim().min(1).max(100).optional().describe('Exact company name as returned in the search_jobs facets.'),
  currency: z.string().trim().length(3).toUpperCase().optional().describe('Currency to estimate in. Defaults to USD. Only currencies with enough listed rates have a model.'),
});

const errorResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export function buildMcpServer(db: D1Database, options: AtlasMcpOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: 'Contract Atlas lists technical contract roles from public staffing and vendor-management boards over the last 90 days. All tools are read-only. Use search_jobs to find roles, get_job for the full posting and list_sources to see which boards are covered and how fresh they are, market_trends for posting volume, skill demand, category mix and hourly pay ranges over time, estimate_pay for a modelled hourly range when a role does not list pay, and match_resume to rank current roles against resume text.',
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
    description: 'List every job board Contract Atlas collects from, with its health, coverage, last successful check and number of current roles. Sources marked empty were read successfully but have no roles in the feed right now.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, async () => {
    const sources = await listSources(db);
    return result({ count: sources.length, emptyCount: sources.filter(s => s.empty).length, sources });
  });

  server.registerTool('market_trends', {
    title: 'Contract market trends',
    description: 'Summarize the contract market over recent weeks. Returns weekly posting volume, the category mix, the most requested skills with recent versus prior demand, and hourly pay ranges (min, quartiles, median, max) per currency, overall and by category. Optionally narrow to one category or company.',
    inputSchema: z.object({
      weeks: z.number().int().min(1).max(MAX_TREND_WEEKS).optional().describe(`How many weeks back to look, up to ${MAX_TREND_WEEKS}. Defaults to 12.`),
      category: z.string().trim().min(1).max(100).optional().describe('Exact category as returned in the search_jobs facets.'),
      company: z.string().trim().min(1).max(100).optional().describe('Exact company name as returned in the search_jobs facets.'),
      skillLimit: z.number().int().min(1).max(50).optional().describe('How many top skills to return. Defaults to 15.'),
    }),
    annotations: READ_ONLY,
  }, async input => result({ ...await marketTrends(db, input) }));

  server.registerTool('estimate_pay', {
    title: 'Estimate hourly pay',
    description: 'Estimate an hourly pay range for a contract role from its title, skills, category, location and company, or for a current role by id. The figures come from a regression trained on roles that list hourly pay and are an estimate, not a quote. Returns low, mid and high, the features that moved the estimate most, inputs the model has not seen, and the model\'s held-out error.',
    inputSchema: estimatePayInput,
    annotations: READ_ONLY,
  }, async input => {
    const model = options.payModel?.() ?? null;
    if (!model) return errorResult('No pay model is available yet. It is trained during the next scheduled refresh.');
    const currency = input.currency ?? 'USD';
    if (!model.currencies[currency]) return errorResult(`There are not enough listed ${currency} hourly rates to estimate pay. Available currencies are ${Object.keys(model.currencies).join(', ') || 'none'}.`);
    let features: PayFeatures | null = null, listed: string | null = null, role: Record<string, unknown> | null = null;
    if (input.id) {
      const job = await getFeedJob(db, input.id);
      if (!job) return errorResult(`No current role has the id "${input.id}". It may have closed or aged out of the 90-day window.`);
      features = { title: job.title, skills: job.skills, category: job.category, location: job.location, country: job.country, workMode: job.workMode, company: job.company };
      listed = pay(job);
      role = { id: job.id, title: job.title, company: job.company, location: job.location };
    }
    const { id: _id, currency: _currency, ...given } = input;
    const defined = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
    features = { ...(features ?? { title: '' }), ...defined };
    if (!features.title) return errorResult('Give a role title or the id of a current role.');
    const estimate = estimatePay(model, features, currency)!;
    return result({ ...(role ? { role, listedPay: listed } : {}), estimate });
  });

  server.registerTool('match_resume', {
    title: 'Match a resume to current roles',
    description: 'Rank current contract roles by how closely they match pasted resume text, using TF-IDF similarity over each role\'s title, skills and description. Each match lists the skills it shares with the resume, the skills it asks for that the resume does not mention, and the terms that drove the score. Also returns the most common missing skills across the matches. The resume is used only for this call and is never stored or logged.',
    inputSchema: z.object({
      resumeText: z.string().trim().min(MIN_RESUME_CHARS).max(MAX_RESUME_CHARS * 2).describe(`Plain resume text, at least ${MIN_RESUME_CHARS} characters. Only the first ${MAX_RESUME_CHARS} characters are compared.`),
      limit: z.number().int().min(1).max(MAX_MATCHES).optional().describe(`How many roles to return, up to ${MAX_MATCHES}. Defaults to 10.`),
      category: z.string().trim().min(1).max(100).optional().describe('Exact category as returned in the search_jobs facets.'),
      workMode: z.enum(['Remote', 'Hybrid', 'On-site']).optional(),
      location: z.string().trim().min(1).max(100).optional().describe('Part of a location name, for example "Seattle" or "Remote".'),
    }),
    annotations: READ_ONLY,
  }, async ({ resumeText, ...options }) => {
    const found = await matchResume(db, resumeText, options);
    return result({
      rolesCompared: found.rolesCompared,
      resume: found.resume,
      matches: found.matches.map(({ job, ...match }) => ({ ...summary(job), ...match })),
      skillGaps: found.skillGaps,
      notes: found.notes,
    });
  });

  return server;
}

// Stateless Streamable HTTP handler. A fresh server is built per request, which
// suits a serverless function that keeps no session state between calls.
export function createAtlasMcpHandler(db: D1Database, options: AtlasMcpOptions = {}) {
  return createMcpHandler(() => buildMcpServer(db, options), {
    onerror: error => console.error(JSON.stringify({ level: 'error', message: error.message, path: '/api/mcp', timestamp: new Date().toISOString() })),
  });
}
