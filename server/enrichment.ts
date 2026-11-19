// LLM enrichment of roles at collection time.
//
// The refresh workflow sends each new or changed role to a free LLM tier and
// stores the structured answer in the job_enrichment table of the snapshot,
// so the site and the MCP tools read plain columns with no runtime AI cost.
// Groq is the default provider and Gemini is the fallback. Without a key the
// module does nothing, and a failing provider never stops a refresh.
import { createHash } from 'node:crypto';
import { z } from 'zod';
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
