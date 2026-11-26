// Semantic search over the public feed.
//
// A visitor or an assistant describes the role they want in plain words. The
// description is embedded at request time with the same bge-small model the
// refresh workflow embeds roles with, and roles that pass the usual filters
// are ranked by cosine similarity to it. When the model cannot load, or no
// role has a stored vector yet, the request falls back to the keyword feed
// and says why, so a search never fails because of the model.
import { inArray } from 'drizzle-orm';
import * as schema from './schema.js';
import { drizzleFor, FEED_PAGE_SIZE, feedFacets, feedFilters, hydrate, jobFeed, withEnrichment } from './db.js';
import { EMBEDDING_MODEL, decodeVector, dot, normalize, type Embedder } from './embeddings.js';
import type { Database } from './database.js';
import type { Feed, Job } from '../src/types.js';

// Long enough for a few sentences, short enough to stay far below the 512
// tokens bge-small reads.
export const MAX_DESCRIPTION_CHARS = 300;
const QUERY_CACHE_SIZE = 200;
// After the model fails to load, requests skip it for this long instead of
// paying the load time again on every search.
const RETRY_AFTER_MS = 10 * 60_000;

export type QueryVector = { vector: Float32Array } | { error: string };

export interface QueryEmbedder {
  embed(text: string): Promise<QueryVector>;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 200);
}

export function cleanDescription(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
}

// Loads the model on the first semantic request and keeps it for the life of
// the function instance. Recent query vectors are cached, since the site asks
// for the same description again when a visitor changes page or filter.
export function createQueryEmbedder(load: () => Promise<Embedder>, options: { retryAfterMs?: number; cacheSize?: number; clock?: () => number } = {}): QueryEmbedder {
  const clock = options.clock ?? Date.now;
  const retryAfter = options.retryAfterMs ?? RETRY_AFTER_MS;
  const cacheSize = options.cacheSize ?? QUERY_CACHE_SIZE;
  const cache = new Map<string, Float32Array>();
  let loading: Promise<Embedder> | null = null;
  let failure: { at: number; error: string } | null = null;

  function model(): Promise<Embedder> {
    if (!loading) {
      const started = clock();
      loading = load().then(embedder => {
        if (embedder.model !== EMBEDDING_MODEL.name || embedder.dimensions !== EMBEDDING_MODEL.dimensions) {
          throw new Error(`The embedder is ${embedder.model} with ${embedder.dimensions} values, not ${EMBEDDING_MODEL.name} with ${EMBEDDING_MODEL.dimensions}.`);
        }
        console.log(JSON.stringify({ level: 'info', message: 'Loaded the query model', model: embedder.model, loadMs: clock() - started }));
        return embedder;
      });
      loading.catch(error => {
        failure = { at: clock(), error: message(error) };
        loading = null;
        console.error(JSON.stringify({ level: 'error', message: 'The query model could not load', error: failure.error }));
      });
    }
    return loading;
  }

  return {
    async embed(raw: string): Promise<QueryVector> {
      const text = cleanDescription(raw);
      if (!text) return { error: 'Describe the role in a few words.' };
      const hit = cache.get(text);
      if (hit) {
        cache.delete(text);
        cache.set(text, hit);
        return { vector: hit };
      }
      if (failure && clock() - failure.at < retryAfter) return { error: `The search model is unavailable (${failure.error}).` };
      try {
        const vector = await (await model()).embedQuery(text);
        if (vector.length !== EMBEDDING_MODEL.dimensions || !Array.from(vector).every(Number.isFinite)) {
          return { error: `The search model returned an unusable vector with ${vector.length} values.` };
        }
        const unit = normalize(vector);
        cache.set(text, unit);
        if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
        return { vector: unit };
      } catch (error) {
        return { error: `The search model is unavailable (${message(error)}).` };
      }
    },
  };
}

export function wantsSemantic(p: URLSearchParams): boolean {
  return ['1', 'true', 'yes'].includes((p.get('semantic') ?? '').toLowerCase());
}

async function keywordFallback(db: Database, p: URLSearchParams, reason: string): Promise<Feed> {
  return { ...await jobFeed(db, p), search: { mode: 'keyword', fallback: reason } };
}

async function storedVectors(db: Database): Promise<Map<string, Uint8Array>> {
  try {
    const rows = await db.prepare('SELECT job_id,vector,dimensions FROM job_embeddings WHERE model=?').bind(EMBEDDING_MODEL.name).all<{ job_id: string; vector: Uint8Array; dimensions: number }>();
    return new Map(rows.results.filter(r => Number(r.dimensions) === EMBEDDING_MODEL.dimensions).map(r => [r.job_id, r.vector]));
  } catch {
    // A snapshot from before the job_embeddings table has no vectors.
    return new Map();
  }
}

// The jobs feed ranked by similarity to the description in q. Every other
// filter in the query string applies as usual, and pages hold the same 18
// roles as the keyword feed.
export async function semanticFeed(db: Database, p: URLSearchParams, embedder?: QueryEmbedder | null): Promise<Feed> {
  const text = cleanDescription(p.get('q'));
  if (!text) return keywordFallback(db, p, 'Describe the role to rank roles by meaning.');
  if (!embedder) return keywordFallback(db, p, 'The search model is not available on this server.');
  const vectors = await storedVectors(db);
  if (!vectors.size) return keywordFallback(db, p, 'No roles have been embedded yet.');
  const query = await embedder.embed(text);
  if ('error' in query) return keywordFallback(db, p, query.error);

  const orm = drizzleFor(db), j = schema.jobs;
  const { active, where } = await feedFilters(db, p, { textQuery: false });
  const candidates = await orm.select({ id: j.id, postedAt: j.postedAt }).from(j).where(where);
  let missing = 0;
  const scored: { id: string; postedAt: string | null; similarity: number }[] = [];
  for (const row of candidates) {
    const blob = vectors.get(row.id);
    if (!blob) { missing++; continue; }
    scored.push({ ...row, similarity: dot(query.vector, decodeVector(blob)) });
  }
  scored.sort((a, b) => b.similarity - a.similarity || (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));

  const total = scored.length, pages = Math.max(1, Math.ceil(total / FEED_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(p.get('page')) || 1)));
  const slice = scored.slice((page - 1) * FEED_PAGE_SIZE, page * FEED_PAGE_SIZE);
  const rows = slice.length ? await orm.select().from(j).where(inArray(j.id, slice.map(s => s.id))) : [];
  const byId = new Map((await withEnrichment(db, rows.map(hydrate))).map(job => [job.id, job]));
  const jobs: Job[] = slice.flatMap(s => {
    const job = byId.get(s.id);
    return job ? [{ ...job, similarity: Math.round(s.similarity * 1000) / 1000 }] : [];
  });
  return { jobs, total, page, pages, facets: await feedFacets(db, active), search: { mode: 'semantic', rolesWithoutVectors: missing } };
}
