// LLM enrichment of roles at collection time.
//
// The refresh workflow sends each new or changed role to a free LLM tier and
// stores the structured answer in the job_enrichment table of the snapshot,
// so the site and the MCP tools read plain columns with no runtime AI cost.
// Groq is the default provider and Gemini is the fallback. Without a key the
// module does nothing, and a failing provider never stops a refresh.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { feedScopeSql, hydrate } from './db.js';
import { SOURCES } from './sources.js';
import type { Database } from './database.js';
import type { Job } from '../src/types.js';

// Bump when the prompt or the stored fields change, so every role is
// enriched again on the next refresh.
export const ENRICHMENT_VERSION = 1;

// Default models, overridable with ENRICH_GROQ_MODEL and ENRICH_GEMINI_MODEL
// when a provider retires one.
export const ENRICHMENT_MODELS = {
  groq: 'openai/gpt-oss-20b',
  gemini: 'gemini-3.1-flash-lite',
} as const;

export type ProviderName = keyof typeof ENRICHMENT_MODELS;
export interface EnrichmentProvider { name: ProviderName; model: string; apiKey: string }

export const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'lead', 'principal', 'unknown'] as const;
export const REMOTE = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
// Same sanity band as the pay model and the market trends figures.
const HOURLY_FLOOR = 5;
const HOURLY_CEILING = 1000;
const MAX_SKILLS = 15;
// Long descriptions are cut so one role stays well inside free tier token limits.
const MAX_DESCRIPTION_CHARS = 6000;

export interface Enrichment {
  skills: string[];
  seniority: (typeof SENIORITY)[number];
  normalizedTitle: string;
  remote: (typeof REMOTE)[number];
  hourlyPayMin: number | null;
  hourlyPayMax: number | null;
}

// Picks the provider from the environment. Groq wins when both keys are set,
// and the other provider is returned as the fallback.
export function providersFromEnv(env: Record<string, string | undefined> = process.env): EnrichmentProvider[] {
  const out: EnrichmentProvider[] = [];
  const groq = env.GROQ_API_KEY?.trim(), gemini = env.GEMINI_API_KEY?.trim();
  if (groq) out.push({ name: 'groq', model: env.ENRICH_GROQ_MODEL?.trim() || ENRICHMENT_MODELS.groq, apiKey: groq });
  if (gemini) out.push({ name: 'gemini', model: env.ENRICH_GEMINI_MODEL?.trim() || ENRICHMENT_MODELS.gemini, apiKey: gemini });
  return out;
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// The role text that goes into the prompt. Only these fields are sent, so a
// change to anything else (such as last_seen_at) does not trigger new calls.
export function enrichmentInput(job: Pick<Job, 'title' | 'company' | 'location' | 'workMode' | 'description' | 'payMin' | 'payMax' | 'payPeriod' | 'currency'>): string {
  const pay = job.payMin != null || job.payMax != null
    ? `${job.payMin ?? ''}-${job.payMax ?? ''} ${job.currency ?? ''} per ${job.payPeriod ?? 'unknown period'}`
    : 'not listed';
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}`,
    `Listed work mode: ${job.workMode}`,
    `Listed pay: ${pay}`,
    `Description: ${plainText(job.description || '').slice(0, MAX_DESCRIPTION_CHARS)}`,
  ].join('\n');
}

export function inputHash(input: string): string {
  return createHash('sha256').update(`v${ENRICHMENT_VERSION}\n${input}`).digest('hex');
}

export const SYSTEM_PROMPT = [
  'You extract structured facts from one contract job posting.',
  'Answer with a single JSON object and nothing else, using exactly these keys.',
  'skills is a list of up to 15 concrete technical skills, tools or languages the role asks for, each a short name such as "Python" or "AWS".',
  `seniority is one of ${SENIORITY.join(', ')}.`,
  'normalizedTitle is a short plain job title without company names, locations, contract terms or requisition codes, such as "Senior Data Engineer".',
  `remote is one of ${REMOTE.join(', ')}.`,
  'hourlyPayMin and hourlyPayMax are the hourly pay range in the posting currency when the posting states pay. Convert yearly pay by dividing by 2080. Use null when no pay is stated. Never guess.',
].join(' ');

// JSON schema shared by both providers' structured output modes.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    skills: { type: 'array', items: { type: 'string' } },
    seniority: { type: 'string', enum: [...SENIORITY] },
    normalizedTitle: { type: 'string' },
    remote: { type: 'string', enum: [...REMOTE] },
    hourlyPayMin: { type: ['number', 'null'] },
    hourlyPayMax: { type: ['number', 'null'] },
  },
  required: ['skills', 'seniority', 'normalizedTitle', 'remote', 'hourlyPayMin', 'hourlyPayMax'],
  additionalProperties: false,
} as const;

const pay = z.union([z.number(), z.string(), z.null()]).optional().transform(v => {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= HOURLY_FLOOR && n <= HOURLY_CEILING ? Math.round(n * 100) / 100 : null;
});
const answer = z.object({
  skills: z.array(z.unknown()).catch([]),
  seniority: z.string().catch('unknown'),
  normalizedTitle: z.string().catch(''),
  remote: z.string().catch('unknown'),
  hourlyPayMin: pay,
  hourlyPayMax: pay,
});

// Validates and cleans a model answer. Unknown labels become "unknown", odd
// skills are dropped, pay outside the sanity band becomes null and a reversed
// range is swapped. Returns null when the text is not a JSON object at all.
export function parseEnrichment(text: string): Enrichment | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return null;
  }
  const parsed = answer.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const s of a.skills) {
    if (typeof s !== 'string') continue;
    const name = s.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    skills.push(name);
    if (skills.length === MAX_SKILLS) break;
  }
  const seniority = a.seniority.toLowerCase().trim();
  const remote = a.remote.toLowerCase().replace(/[^a-z]/g, '');
  let [min, max] = [a.hourlyPayMin, a.hourlyPayMax];
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return {
    skills,
    seniority: (SENIORITY as readonly string[]).includes(seniority) ? seniority as Enrichment['seniority'] : 'unknown',
    normalizedTitle: a.normalizedTitle.replace(/\s+/g, ' ').trim().slice(0, 120),
    remote: (REMOTE as readonly string[]).includes(remote) ? remote as Enrichment['remote'] : 'unknown',
    hourlyPayMin: min,
    hourlyPayMax: max,
  };
}

type Fetch = typeof fetch;

async function callGroq(provider: EnrichmentProvider, input: string, fetchImpl: Fetch, signal: AbortSignal): Promise<string> {
  const response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: input }],
      response_format: { type: 'json_schema', json_schema: { name: 'job_enrichment', schema: RESPONSE_SCHEMA } },
    }),
  });
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}`);
  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '';
}

async function callGemini(provider: EnrichmentProvider, input: string, fetchImpl: Fetch, signal: AbortSignal): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`;
  const response = await fetchImpl(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': provider.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: RESPONSE_SCHEMA },
    }),
  });
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
}

export interface EnrichResult { enrichment: Enrichment; provider: EnrichmentProvider }

// Tries each provider in order and returns the first valid answer, or null
// when every provider failed or answered with something unusable.
export async function requestEnrichment(providers: EnrichmentProvider[], input: string, options: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<EnrichResult | null> {
  const fetchImpl = options.fetch ?? fetch;
  for (const provider of providers) {
    try {
      const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const text = provider.name === 'groq' ? await callGroq(provider, input, fetchImpl, signal) : await callGemini(provider, input, fetchImpl, signal);
      const enrichment = parseEnrichment(text);
      if (enrichment) return { enrichment, provider };
    } catch {
      // Fall through to the next provider.
    }
  }
  return null;
}

export async function saveEnrichment(db: Database, jobId: string, hash: string, result: EnrichResult, now = new Date()): Promise<void> {
  const e = result.enrichment;
  await db.prepare(`INSERT INTO job_enrichment(job_id,input_hash,provider,model,skills,seniority,normalized_title,remote,pay_min,pay_max,enriched_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET input_hash=excluded.input_hash,provider=excluded.provider,model=excluded.model,skills=excluded.skills,seniority=excluded.seniority,normalized_title=excluded.normalized_title,remote=excluded.remote,pay_min=excluded.pay_min,pay_max=excluded.pay_max,enriched_at=excluded.enriched_at`)
    .bind(jobId, hash, result.provider.name, result.provider.model, JSON.stringify(e.skills), e.seniority, e.normalizedTitle, e.remote, e.hourlyPayMin, e.hourlyPayMax, now.toISOString()).run();
}

export async function loadEnrichment(db: Database, jobId: string): Promise<(Enrichment & { inputHash: string; provider: string; model: string; enrichedAt: string }) | null> {
  const r = await db.prepare('SELECT * FROM job_enrichment WHERE job_id=?').bind(jobId).first<any>();
  if (!r) return null;
  return {
    skills: JSON.parse(r.skills), seniority: r.seniority, normalizedTitle: r.normalized_title, remote: r.remote,
    hourlyPayMin: r.pay_min, hourlyPayMax: r.pay_max, inputHash: r.input_hash, provider: r.provider, model: r.model, enrichedAt: r.enriched_at,
  };
}

export interface PendingEnrichment { jobId: string; input: string; hash: string }

// Feed roles with no stored answer, or whose prompt text changed since they
// were enriched. Newest postings come first, so a capped run spends its calls
// on the roles visitors see at the top of the feed.
export async function pendingEnrichment(db: Database, now = new Date()): Promise<PendingEnrichment[]> {
  const stored = new Map((await db.prepare('SELECT job_id,input_hash FROM job_enrichment').all<{ job_id: string; input_hash: string }>()).results.map(r => [r.job_id, r.input_hash]));
  const ids = SOURCES.map(s => s.id);
  const rows = await db.prepare(`SELECT * FROM jobs WHERE ${feedScopeSql('', now)} AND source_id IN (${ids.map(() => '?').join(',')})
    ORDER BY posted_at DESC, id`).bind(...ids).all<any>();
  const out: PendingEnrichment[] = [];
  for (const row of rows.results) {
    const input = enrichmentInput(hydrate(row));
    const hash = inputHash(input);
    if (stored.get(row.id) !== hash) out.push({ jobId: row.id, input, hash });
  }
  return out;
}

export interface EnrichmentProblem { jobId: string; problem: string }

// Checks every stored answer against the same rules parseEnrichment applies
// when it saves one, so a hand edit, a bad migration or a future code change
// cannot publish rows the readers would misread. A snapshot without the
// table has nothing to check and returns no problems.
export async function enrichmentProblems(db: Database): Promise<EnrichmentProblem[]> {
  const table = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='job_enrichment'").first();
  if (!table) return [];
  const rows = (await db.prepare(`SELECT e.*, j.id AS role FROM job_enrichment e LEFT JOIN jobs j ON j.id=e.job_id ORDER BY e.job_id`).all<any>()).results;
  const providers = Object.keys(ENRICHMENT_MODELS);
  const out: EnrichmentProblem[] = [];
  for (const r of rows) {
    const add = (problem: string) => out.push({ jobId: r.job_id, problem });
    if (r.role == null) add('no matching role');
    if (!/^[0-9a-f]{64}$/.test(r.input_hash ?? '')) add('input hash is not a sha256 hex digest');
    if (!providers.includes(r.provider)) add(`unknown provider ${JSON.stringify(r.provider)}`);
    if (!String(r.model ?? '').trim()) add('empty model name');
    let skills: unknown;
    try { skills = JSON.parse(r.skills); } catch { skills = undefined; }
    if (!Array.isArray(skills)) add('skills is not a JSON list');
    else if (skills.length > MAX_SKILLS || skills.some(s => typeof s !== 'string' || !s.trim() || s.length > 40)) add('skills list has empty, long or non-text entries or too many entries');
    if (!(SENIORITY as readonly string[]).includes(r.seniority)) add(`unknown seniority ${JSON.stringify(r.seniority)}`);
    if (!(REMOTE as readonly string[]).includes(r.remote)) add(`unknown remote label ${JSON.stringify(r.remote)}`);
    if (typeof r.normalized_title !== 'string' || r.normalized_title.length > 120) add('normalized title is missing or too long');
    for (const [name, value] of [['pay_min', r.pay_min], ['pay_max', r.pay_max]] as const) {
      if (value != null && !(typeof value === 'number' && value >= HOURLY_FLOOR && value <= HOURLY_CEILING)) add(`${name} is outside ${HOURLY_FLOOR} to ${HOURLY_CEILING} per hour`);
    }
    if (typeof r.pay_min === 'number' && typeof r.pay_max === 'number' && r.pay_min > r.pay_max) add('pay_min is above pay_max');
    if (Number.isNaN(Date.parse(r.enriched_at ?? ''))) add('enriched_at is not a date');
  }
  return out;
}

// Deletes answers whose role is no longer in the snapshot.
export async function pruneEnrichment(db: Database): Promise<number> {
  const { changes } = await db.prepare('DELETE FROM job_enrichment WHERE job_id NOT IN (SELECT id FROM jobs)').run();
  return changes;
}

// Free tier limits. Groq allows about 30 requests a minute on the default
// model and Gemini Flash Lite about 15, so one call every four seconds stays
// under both. Forty roles a run at twelve runs a day is under 500 calls, well
// inside either daily quota, and a backlog drains over a few refreshes.
export const ENRICH_DEFAULT_LIMIT = 40;
export const ENRICH_DEFAULT_DELAY_MS = 4000;
// After this many failures in a row the provider is treated as down for the
// rest of the run instead of burning the whole delay budget.
const MAX_CONSECUTIVE_FAILURES = 3;

export interface EnrichRunOptions {
  limit?: number;
  delayMs?: number;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

export interface EnrichRunResult {
  status: 'skipped' | 'done' | 'stopped' | 'error';
  pending: number;
  attempted: number;
  enriched: number;
  failed: number;
  providers: string[];
  error?: string;
}

function wholeNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value != null && value.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

// Run options from the environment, so the cap and delay can be tuned in
// the workflow without a code change.
export function runOptionsFromEnv(env: Record<string, string | undefined> = process.env): Pick<EnrichRunOptions, 'limit' | 'delayMs'> {
  return { limit: wholeNumber(env.ENRICH_MAX_PER_RUN, ENRICH_DEFAULT_LIMIT), delayMs: wholeNumber(env.ENRICH_DELAY_MS, ENRICH_DEFAULT_DELAY_MS) };
}

// Enriches up to `limit` pending roles, waiting `delayMs` between calls.
// It never throws. A missing key skips the run, a provider that keeps failing
// stops it early, and any other error is reported in the result, so the
// refresh always goes on to publish the snapshot.
export async function enrichPending(db: Database, providers: EnrichmentProvider[], options: EnrichRunOptions = {}): Promise<EnrichRunResult> {
  const result: EnrichRunResult = { status: 'skipped', pending: 0, attempted: 0, enriched: 0, failed: 0, providers: providers.map(p => `${p.name}:${p.model}`) };
  if (!providers.length) return result;
  const limit = options.limit ?? ENRICH_DEFAULT_LIMIT;
  const delayMs = options.delayMs ?? ENRICH_DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    const pending = await pendingEnrichment(db, options.now);
    result.pending = pending.length;
    result.status = 'done';
    let failuresInRow = 0;
    for (const role of pending.slice(0, limit)) {
      if (result.attempted > 0 && delayMs > 0) await sleep(delayMs);
      result.attempted++;
      const answer = await requestEnrichment(providers, role.input, { fetch: options.fetch });
      if (answer) {
        await saveEnrichment(db, role.jobId, role.hash, answer, options.now);
        result.enriched++;
        failuresInRow = 0;
      } else {
        result.failed++;
        if (++failuresInRow >= MAX_CONSECUTIVE_FAILURES) { result.status = 'stopped'; break; }
      }
    }
  } catch (error) {
    result.status = 'error';
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}
