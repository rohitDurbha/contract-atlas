// Vector storage and ranking for semantic search.
//
// Each role in the feed is embedded once from its title, skills and the start
// of its description, and the vector is stored in the job_embeddings table of
// the snapshot. A plain-language query is embedded with the same model and
// roles are ranked by cosine similarity. The model itself sits behind the
// Embedder interface, so the refresh workflow, the Vercel function and the
// tests can each supply their own.
//
// Vectors are stored as little-endian float32 blobs, which is the layout
// sqlite-vec reads, so its distance functions can be loaded later without
// rewriting the stored data. With under a thousand roles in the feed a scan
// in JavaScript takes a few milliseconds and needs no native extension.
import { createHash } from 'node:crypto';
import { applyEnrichment, enrichmentRows, feedScopeSql, hydrate } from './db.js';
import { SOURCES } from './sources.js';
import type { Database } from './database.js';
import type { Job } from '../src/types.js';

// The model the refresh workflow embeds roles with. A query must be embedded
// with the same model, so stored rows record which model produced them.
export const EMBEDDING_MODEL = { name: 'BAAI/bge-small-en-v1.5', dimensions: 384 } as const;

// bge models are trained with this prefix on short search queries and no
// prefix on the passages being searched.
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// bge-small reads at most 512 tokens, so the description is cut well before
// that and the title and skills always fit.
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_SKILLS = 20;
export const MAX_SEMANTIC_RESULTS = 50;

export interface Embedder {
  model: string;
  dimensions: number;
  // Embeds role texts in one batch, in the order given.
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  // Embeds a search query, adding any prefix the model expects.
  embedQuery(text: string): Promise<Float32Array>;
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// The text a role is embedded from. Only these fields go in, so a change to
// pay or to last_seen_at does not cause the role to be embedded again.
export function embeddingText(job: Pick<Job, 'title' | 'skills' | 'description'>): string {
  const skills = job.skills.map(s => s.trim()).filter(Boolean).slice(0, MAX_SKILLS);
  return [
    job.title.trim(),
    skills.length ? `Skills: ${skills.join(', ')}` : '',
    plainText(job.description || '').slice(0, MAX_DESCRIPTION_CHARS),
  ].filter(Boolean).join('\n');
}

// Changes when the text or the model changes, so the refresh can tell which
// stored vectors are out of date.
export function embeddingHash(text: string, model: string = EMBEDDING_MODEL.name): string {
  return createHash('sha256').update(`${model}\n${text}`).digest('hex');
}

// Scales a vector to unit length so a dot product is the cosine similarity.
export function normalize(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const out = new Float32Array(vector.length);
  const norm = Math.sqrt(sum);
  if (!norm) return out;
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

export function encodeVector(vector: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true);
  return bytes;
}

export function decodeVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4) throw new Error('A stored vector is not a whole number of float32 values.');
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(blob.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Vector sizes differ (${a.length} and ${b.length}).`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export async function saveEmbedding(db: Database, jobId: string, hash: string, model: string, vector: ArrayLike<number>, now = new Date()): Promise<void> {
  const unit = normalize(vector);
  await db.prepare(`INSERT INTO job_embeddings(job_id,input_hash,model,dimensions,vector,embedded_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET input_hash=excluded.input_hash,model=excluded.model,dimensions=excluded.dimensions,vector=excluded.vector,embedded_at=excluded.embedded_at`)
    .bind(jobId, hash, model, unit.length, encodeVector(unit), now.toISOString()).run();
}

// Feed roles in scope, optionally with the stored vector for one model.
async function feedRows(db: Database, now: Date, vectors?: { model: string }): Promise<any[]> {
  const ids = SOURCES.map(s => s.id);
  const join = vectors ? 'LEFT JOIN job_embeddings e ON e.job_id=j.id AND e.model=?' : '';
  const rows = await db.prepare(`SELECT j.*${vectors ? ',e.vector AS embedding,e.dimensions AS embedding_dimensions' : ''} FROM jobs j ${join}
    WHERE ${feedScopeSql('j', now)} AND j.source_id IN (${ids.map(() => '?').join(',')})`).bind(...(vectors ? [vectors.model] : []), ...ids).all<any>();
  return rows.results;
}

export interface PendingEmbedding { jobId: string; text: string; hash: string }

// Feed roles that have no vector yet, or whose text or model changed since
// they were embedded. Roles outside the feed are skipped, since nobody can
// search for them.
export async function pendingEmbeddings(db: Database, model: string = EMBEDDING_MODEL.name, now = new Date()): Promise<PendingEmbedding[]> {
  const stored = new Map((await db.prepare('SELECT job_id,input_hash FROM job_embeddings').all<{ job_id: string; input_hash: string }>()).results.map(r => [r.job_id, r.input_hash]));
  const out: PendingEmbedding[] = [];
  for (const row of await feedRows(db, now)) {
    const text = embeddingText(hydrate(row));
    const hash = embeddingHash(text, model);
    if (stored.get(row.id) !== hash) out.push({ jobId: row.id, text, hash });
  }
  return out;
}

// Deletes vectors whose role is no longer in the snapshot.
export async function pruneEmbeddings(db: Database): Promise<number> {
  const { changes } = await db.prepare('DELETE FROM job_embeddings WHERE job_id NOT IN (SELECT id FROM jobs)').run();
  return changes;
}

export interface SemanticSearchOptions {
  limit?: number;
  category?: string;
  workMode?: Job['workMode'];
  model?: string;
  now?: Date;
}

export interface SemanticMatch { job: Job; similarity: number }

export interface SemanticSearchResult {
  // Feed roles that have a vector from this model and were compared.
  rolesCompared: number;
  // Feed roles that had no usable vector, so they could not be ranked.
  rolesWithoutVectors: number;
  matches: SemanticMatch[];
}

// Ranks feed roles by cosine similarity to an already embedded query.
export async function semanticSearch(db: Database, query: ArrayLike<number>, options: SemanticSearchOptions = {}): Promise<SemanticSearchResult> {
  const model = options.model ?? EMBEDDING_MODEL.name;
  const limit = Math.min(MAX_SEMANTIC_RESULTS, Math.max(1, Math.floor(options.limit ?? 10)));
  const unit = normalize(query);
  const rows = await feedRows(db, options.now ?? new Date(), { model });
  const stored = await enrichmentRows(db);
  let missing = 0;
  const scored: SemanticMatch[] = [];
  for (const row of rows) {
    const job = applyEnrichment(hydrate(row), stored.get(row.id));
    if (options.category && job.category !== options.category) continue;
    if (options.workMode && job.workMode !== options.workMode) continue;
    // A vector of another size came from a different model build and cannot be compared.
    if (!row.embedding || Number(row.embedding_dimensions) !== unit.length) { missing++; continue; }
    scored.push({ job, similarity: Math.round(dot(unit, decodeVector(row.embedding)) * 1000) / 1000 });
  }
  scored.sort((a, b) => b.similarity - a.similarity || (b.job.postedAt ?? '').localeCompare(a.job.postedAt ?? ''));
  return { rolesCompared: scored.length, rolesWithoutVectors: missing, matches: scored.slice(0, limit) };
}

// Enough for the whole feed in one run, so a first run or a model change
// catches up at once. bge-small embeds a few dozen roles a second on the
// Actions runner.
export const EMBED_DEFAULT_LIMIT = 1500;
const EMBED_BATCH = 64;

export interface EmbedRunOptions {
  limit?: number;
  now?: Date;
}

export interface EmbedRunResult {
  status: 'skipped' | 'done' | 'error';
  model: string;
  pending: number;
  embedded: number;
  durationMs: number;
  error?: string;
}

// Reads the per-run cap from EMBED_MAX_PER_RUN, falling back to the default
// when it is missing or not a whole number.
export function embedLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  const value = env.EMBED_MAX_PER_RUN;
  const n = Number(value);
  return value != null && value.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : EMBED_DEFAULT_LIMIT;
}

// Embeds up to `limit` feed roles that are new, edited or embedded by another
// model. The model is loaded only when something is pending, and the run
// never throws. A model that cannot download or load, or returns vectors of
// the wrong size, is reported in the result, so the refresh still publishes
// and the roles stay pending for the next run. Vectors already saved in an
// interrupted run are kept, since each one matches its own role text.
export async function embedPending(db: Database, loadEmbedder: () => Promise<Embedder>, options: EmbedRunOptions = {}): Promise<EmbedRunResult> {
  const started = Date.now();
  const result: EmbedRunResult = { status: 'skipped', model: EMBEDDING_MODEL.name, pending: 0, embedded: 0, durationMs: 0 };
  try {
    const pending = await pendingEmbeddings(db, EMBEDDING_MODEL.name, options.now);
    result.pending = pending.length;
    const todo = pending.slice(0, options.limit ?? EMBED_DEFAULT_LIMIT);
    if (todo.length) {
      const embedder = await loadEmbedder();
      if (embedder.model !== EMBEDDING_MODEL.name || embedder.dimensions !== EMBEDDING_MODEL.dimensions) {
        throw new Error(`The embedder is ${embedder.model} with ${embedder.dimensions} values, not ${EMBEDDING_MODEL.name} with ${EMBEDDING_MODEL.dimensions}.`);
      }
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        const batch = todo.slice(i, i + EMBED_BATCH);
        const vectors = await embedder.embedPassages(batch.map(p => p.text));
        if (vectors.length !== batch.length) throw new Error(`The model returned ${vectors.length} vectors for ${batch.length} roles.`);
        const bad = vectors.find(v => v.length !== EMBEDDING_MODEL.dimensions || !Array.from(v).every(Number.isFinite) || !v.some(x => x !== 0));
        if (bad) throw new Error(`The model returned an unusable vector with ${bad.length} values.`);
        const at = options.now ?? new Date();
        for (let j = 0; j < batch.length; j++) await saveEmbedding(db, batch[j].jobId, batch[j].hash, EMBEDDING_MODEL.name, vectors[j], at);
        result.embedded += batch.length;
      }
    }
    result.status = todo.length ? 'done' : 'skipped';
  } catch (error) {
    result.status = 'error';
    result.error = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 200);
  }
  result.durationMs = Date.now() - started;
  return result;
}
