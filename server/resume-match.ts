// Ranks current roles against a pasted resume with TF-IDF cosine similarity.
//
// The index is built from the public feed only (title, skills and
// description of each role the site lists), so matching needs no model, no
// network call and no AI cost. Resume text is tokenised in memory to answer a
// single call and is never written to the database, a cache or a log.
import { feedScopeSql, hydrate } from './db.js';
import { SOURCES } from './sources.js';
import type { Job } from '../src/types.js';

export const MIN_RESUME_CHARS = 80;
export const MAX_RESUME_CHARS = 30_000;
export const MAX_MATCHES = 25;
// The role index is rebuilt after this long so a long-lived local process
// still follows the 90-day window. On Vercel the snapshot is fixed per deploy.
const INDEX_TTL_MS = 15 * 60_000;
// Title words describe the role best, so they count as several description words.
const TITLE_WEIGHT = 3;
const SKILL_WEIGHT = 2;
const SHARED_TERMS = 8;

const STOP_WORDS = new Set(('a about above after again all also am an and any are as at be been being below between both but by can could did do does doing down during each etc few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not of off on once only or other our ours out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours ' +
  'ability able across apply applicants candidate candidates company contract contractor duties employer employment experience job looking must opportunity position preferred required requirements responsibilities role team work working year years plus strong excellent good great knowledge skills skill using use including within new day days per hour hours based help ensure provide support well related etc').split(' '));

// Common technical skills with the spellings people use for them. A role's
// listed skills are added to this per role, so the list only needs to cover
// skills that descriptions mention without listing.
const SKILL_VOCABULARY: [string, string[]][] = [
  ['Python', []], ['SQL', []], ['Java', []], ['JavaScript', []], ['TypeScript', []], ['C++', []], ['C#', []], ['Go', ['Golang']],
  ['Rust', []], ['Scala', []], ['Kotlin', []], ['Swift', []], ['R', []], ['MATLAB', []], ['Bash', ['Shell scripting']],
  ['React', ['React.js', 'ReactJS']], ['Angular', []], ['Vue', ['Vue.js']], ['Node.js', ['NodeJS', 'Node']], ['Django', []], ['Flask', []],
  ['FastAPI', []], ['Spring', ['Spring Boot']], ['.NET', ['dotnet', 'ASP.NET']], ['GraphQL', []], ['REST', ['RESTful']],
  ['AWS', ['Amazon Web Services']], ['Azure', []], ['GCP', ['Google Cloud']], ['Kubernetes', ['k8s']], ['Docker', []], ['Terraform', []],
  ['Linux', []], ['Git', []], ['CI/CD', ['continuous integration']], ['Jenkins', []], ['Ansible', []],
  ['Spark', ['PySpark', 'Apache Spark']], ['Hadoop', []], ['Kafka', []], ['Airflow', []], ['dbt', []], ['Snowflake', []], ['Databricks', []],
  ['BigQuery', []], ['Redshift', []], ['PostgreSQL', ['Postgres']], ['MySQL', []], ['MongoDB', []], ['Oracle', []], ['SQL Server', ['MS SQL Server', 'MSSQL']],
  ['ETL', []], ['Data Modeling', ['data modelling']], ['Tableau', []], ['Power BI', ['PowerBI']], ['Looker', []], ['Excel', []],
  ['Pandas', []], ['NumPy', []], ['scikit-learn', ['sklearn']], ['TensorFlow', []], ['PyTorch', []], ['Machine Learning', ['ML']],
  ['Deep Learning', []], ['NLP', ['natural language processing']], ['Computer Vision', []], ['LLM', ['large language models', 'LLMs']],
  ['Statistics', ['statistical analysis']], ['A/B Testing', ['AB testing']], ['Selenium', []], ['Cypress', []], ['Playwright', []],
  ['Unit Testing', []], ['Test Automation', []], ['Agile', []], ['Scrum', []], ['JIRA', []], ['Salesforce', []], ['SAP', []], ['Figma', []],
  ['Microservices', []], ['Distributed Systems', []], ['Security', ['cybersecurity']],
];

export interface ResumeMatchOptions {
  limit?: number;
  category?: string;
  workMode?: Job['workMode'];
  location?: string;
  now?: Date;
}

export interface RoleMatch {
  job: Job;
  similarity: number;
  matchedSkills: string[];
  missingSkills: string[];
  sharedTerms: string[];
}

export interface ResumeMatchResult {
  rolesCompared: number;
  resume: { characters: number; recognisedTerms: number; skills: string[] };
  matches: RoleMatch[];
  skillGaps: { skill: string; roles: number }[];
  notes: string[];
}

interface IndexedRole { job: Job; weights: Map<string, number>; skills: string[] }
interface RoleIndex { builtAt: number; idf: Map<string, number>; roles: IndexedRole[] }

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const token = raw.replace(/^\.+|\.+$/g, '');
    if (token.length < 2 || STOP_WORDS.has(token) || /^[\d.]+$/.test(token)) continue;
    out.push(token);
  }
  return out;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const skillPatterns = new Map<string, RegExp>();
// Names that are also everyday words only count when written as a name.
const CASE_SENSITIVE = new Set(['REST', 'Go', 'Rust', 'Swift', 'Spring', 'Node']);
// Whole-word match that understands names such as C++, C#, .NET and CI/CD.
// One and two letter names like R and ML must match in capitals too.
function mentions(text: string, name: string): boolean {
  let pattern = skillPatterns.get(name);
  if (!pattern) {
    const exact = CASE_SENSITIVE.has(name) || /^[A-Za-z]{1,2}$/.test(name);
    pattern = new RegExp(`(^|[^A-Za-z0-9+#.])${escape(name).replace(/ /g, '[\\s-]+')}(?![A-Za-z0-9+#]|\\.[A-Za-z0-9])`, exact ? '' : 'i');
    skillPatterns.set(name, pattern);
  }
  return pattern.test(text);
}

export function findSkills(text: string, extra: string[] = []): string[] {
  const found = new Map<string, string>();
  for (const [name, aliases] of SKILL_VOCABULARY) {
    if ([name, ...aliases].some(alias => mentions(text, alias))) found.set(name.toLowerCase(), name);
  }
  for (const skill of extra) {
    const name = skill.trim();
    if (!name || name.split(/\s+/).length > 4 || found.has(name.toLowerCase())) continue;
    if (mentions(text, name)) found.set(name.toLowerCase(), name);
  }
  return [...found.values()];
}

function termCounts(parts: [string, number][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [text, weight] of parts) for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + weight);
  return counts;
}

// Sublinear term frequency times inverse document frequency, scaled to unit length.
function weigh(counts: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const weights = new Map<string, number>();
  let norm = 0;
  for (const [term, count] of counts) {
    const w = idf.get(term);
    if (!w) continue;
    const value = (1 + Math.log(count)) * w;
    weights.set(term, value);
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm) for (const [term, value] of weights) weights.set(term, value / norm);
  return weights;
}

function roleSkills(job: Job): string[] {
  const listed = job.skills.filter(s => s.trim() && s.trim().split(/\s+/).length <= 4);
  return findSkills(`${job.title}\n${job.description}\n${listed.join('\n')}`, listed);
}

export function buildIndex(jobs: Job[]): RoleIndex {
  const counts = jobs.map(job => termCounts([[job.title, TITLE_WEIGHT], [job.skills.join(' '), SKILL_WEIGHT], [job.description, 1]]));
  const df = new Map<string, number>();
  for (const c of counts) for (const term of c.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [term, n] of df) idf.set(term, Math.log((jobs.length + 1) / (n + 1)) + 1);
  return { builtAt: Date.now(), idf, roles: jobs.map((job, i) => ({ job, weights: weigh(counts[i], idf), skills: roleSkills(job) })) };
}

const cache = new WeakMap<D1Database, Promise<RoleIndex>>();
async function loadIndex(db: D1Database, now?: Date): Promise<RoleIndex> {
  if (now) return buildIndex(await feedRoles(db, now));
  let pending = cache.get(db);
  if (pending) {
    const index = await pending.catch(() => null);
    if (index && Date.now() - index.builtAt < INDEX_TTL_MS) return index;
  }
  pending = feedRoles(db, new Date()).then(buildIndex);
  cache.set(db, pending);
  pending.catch(() => cache.delete(db));
  return pending;
}

async function feedRoles(db: D1Database, now: Date): Promise<Job[]> {
  const ids = SOURCES.map(s => s.id);
  const rows = await db.prepare(`SELECT * FROM jobs j WHERE ${feedScopeSql('j', now)} AND j.source_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  return rows.results.map(hydrate);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export async function matchResume(db: D1Database, resumeText: string, options: ResumeMatchOptions = {}): Promise<ResumeMatchResult> {
  const text = resumeText.slice(0, MAX_RESUME_CHARS);
  const index = await loadIndex(db, options.now);
  const limit = Math.min(MAX_MATCHES, Math.max(1, Math.floor(options.limit ?? 10)));
  const location = options.location?.trim().toLowerCase();
  const pool = index.roles.filter(r =>
    (!options.category || r.job.category === options.category) &&
    (!options.workMode || r.job.workMode === options.workMode) &&
    (!location || r.job.location.toLowerCase().includes(location)));

  const resume = weigh(termCounts([[text, 1]]), index.idf);
  const resumeSkills = findSkills(text, [...new Set(pool.flatMap(r => r.skills))]);
  const has = new Set(resumeSkills.map(s => s.toLowerCase()));

  const scored = pool.map(role => {
    let similarity = 0;
    const shared: [string, number][] = [];
    for (const [term, weight] of resume) {
      const other = role.weights.get(term);
      if (!other) continue;
      similarity += weight * other;
      shared.push([term, weight * other]);
    }
    return { role, similarity, shared };
  }).filter(s => s.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || (b.role.job.postedAt ?? '').localeCompare(a.role.job.postedAt ?? ''))
    .slice(0, limit);

  const matches = scored.map(({ role, similarity, shared }) => ({
    job: role.job,
    similarity: round(similarity),
    matchedSkills: role.skills.filter(s => has.has(s.toLowerCase())),
    missingSkills: role.skills.filter(s => !has.has(s.toLowerCase())),
    sharedTerms: shared.sort((a, b) => b[1] - a[1]).slice(0, SHARED_TERMS).map(([term]) => term),
  }));

  const gaps = new Map<string, number>();
  for (const m of matches) for (const s of m.missingSkills) gaps.set(s, (gaps.get(s) ?? 0) + 1);

  return {
    rolesCompared: pool.length,
    resume: { characters: text.length, recognisedTerms: resume.size, skills: resumeSkills },
    matches,
    skillGaps: [...gaps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([skill, roles]) => ({ skill, roles })),
    notes: [
      'Similarity is TF-IDF cosine similarity between the resume and each role\'s title, skills and description, from 0 (nothing shared) to 1. It measures shared vocabulary, not fit.',
      'Skills are matched by name, so a skill the resume describes in other words can show as missing.',
      'The resume text was used only to answer this call. It was not stored or logged.',
      ...(resumeText.length > MAX_RESUME_CHARS ? [`Only the first ${MAX_RESUME_CHARS} characters of the resume were compared.`] : []),
    ],
  };
}
