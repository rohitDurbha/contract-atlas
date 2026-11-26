import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobFeed, jobStatement } from '../server/db';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';
import { EMBEDDING_MODEL, embeddingHash, saveEmbedding, type Embedder } from '../server/embeddings';
import { cleanDescription, createQueryEmbedder, MAX_DESCRIPTION_CHARS, semanticFeed, wantsSemantic, type QueryEmbedder } from '../server/semantic-feed';
import { copyModel, loadFastEmbedder, missingModelFiles, MODEL_FILES, MODEL_FOLDER } from '../server/fastembed';
import { freeFetch } from '../server/free-runtime';
import { createAtlasMcpHandler } from '../server/mcp';
import publicAPI from '../api/index';

// A stand-in for bge-small that counts topic words into the first values of
// a 384 value vector, so rankings are easy to predict and nothing downloads.
const TOPICS = [['data', 'pipeline', 'pipelines', 'airflow', 'warehouse', 'etl'], ['react', 'frontend', 'interfaces', 'typescript'], ['model', 'models', 'pytorch', 'training', 'learning']];
function topicVector(text: string): Float32Array {
  const words = text.toLowerCase().split(/[^a-z]+/);
  const out = new Float32Array(EMBEDDING_MODEL.dimensions);
  TOPICS.forEach((topic, i) => { out[i] = words.filter(w => topic.includes(w)).length + 0.01; });
  return out;
}
function fakeEmbedder(calls: string[] = []): Embedder {
  return {
    model: EMBEDDING_MODEL.name, dimensions: EMBEDDING_MODEL.dimensions,
    async embedPassages(texts) { return texts.map(topicVector); },
    async embedQuery(text) { calls.push(text); return topicVector(text); },
  };
}

describe('query embedder', () => {
  it('loads the model once and caches repeated descriptions', async () => {
    const calls: string[] = [];
    const load = vi.fn(async () => fakeEmbedder(calls));
    const embedder = createQueryEmbedder(load);
    const first = await embedder.embed('  Data   pipelines ');
    const again = await embedder.embed('Data pipelines');
    expect('vector' in first && 'vector' in again).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['Data pipelines']);
    // Returned vectors are unit length.
    const v = (first as { vector: Float32Array }).vector;
    expect(Math.hypot(...v)).toBeCloseTo(1);
  });

  it('keeps only the most recent descriptions', async () => {
    const calls: string[] = [];
    const embedder = createQueryEmbedder(async () => fakeEmbedder(calls), { cacheSize: 2 });
    for (const text of ['a data', 'b data', 'c data', 'a data']) await embedder.embed(text);
    expect(calls).toEqual(['a data', 'b data', 'c data', 'a data']);
  });

  it('reports a model that fails to load and waits before trying again', async () => {
    let now = 0, attempts = 0;
    const embedder = createQueryEmbedder(async () => { attempts++; throw new Error('missing model_optimized.onnx\nstack'); }, { clock: () => now, retryAfterMs: 1000 });
    expect(await embedder.embed('data')).toEqual({ error: 'The search model is unavailable (missing model_optimized.onnx).' });
    now = 500;
    expect('error' in await embedder.embed('data')).toBe(true);
    expect(attempts).toBe(1);
    now = 1500;
    await embedder.embed('data');
    expect(attempts).toBe(2);
  });

  it('refuses a model of another name or size, and empty text', async () => {
    const wrong = createQueryEmbedder(async () => ({ ...fakeEmbedder(), dimensions: 768 }));
    expect((await wrong.embed('data') as { error: string }).error).toMatch(/not BAAI\/bge-small-en-v1.5 with 384/);
    expect(await createQueryEmbedder(async () => fakeEmbedder()).embed('   ')).toEqual({ error: 'Describe the role in a few words.' });
  });

  it('trims descriptions and reads the semantic flag', () => {
    expect(cleanDescription(' a \n b ')).toBe('a b');
    expect(cleanDescription('x'.repeat(1000))).toHaveLength(MAX_DESCRIPTION_CHARS);
    expect(wantsSemantic(new URLSearchParams('semantic=1'))).toBe(true);
    expect(wantsSemantic(new URLSearchParams('semantic=true'))).toBe(true);
    expect(wantsSemantic(new URLSearchParams('semantic=0'))).toBe(false);
    expect(wantsSemantic(new URLSearchParams(''))).toBe(false);
  });
});

describe('semantic feed on a controlled database', () => {
  const sqlite = openSQLite(':memory:');
  const db = sqlite.db;
  const recent = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const id = (key: string) => `${SOURCES[0].id}:${key}`;
  const add = (key: string, title: string, days: number, description: string, extra: Record<string, unknown> = {}) =>
    jobStatement(db, makeJob(SOURCES[0], { sourceJobId: key, title, applyUrl: 'https://example.com/jobs/' + key, postedAt: recent(days), description, ...extra }, recent(days))!).run();
  const embedder = createQueryEmbedder(async () => fakeEmbedder());
  const feed = (query: string, e: QueryEmbedder | null = embedder) => semanticFeed(db, new URLSearchParams(query), e);

  beforeAll(async () => {
    await ensureDB(db);
    await db.prepare('DELETE FROM jobs').run();
    await add('de', 'Data Engineer', 1, 'Build data pipelines in Airflow and load the warehouse.');
    await add('fe', 'Frontend Software Engineer', 2, 'Ship React and TypeScript interfaces.', { workMode: 'Remote' });
    await add('ml', 'Machine Learning Engineer', 3, 'Train PyTorch models and run training jobs.');
    // In the feed but not embedded yet.
    await add('qa', 'QA Engineer', 4, 'Write test plans.');
  });
  afterAll(() => sqlite.close());

  it('falls back to keyword search when no role has a vector', async () => {
    const result = await feed('q=Engineer&semantic=1');
    expect(result.search).toEqual({ mode: 'keyword', fallback: 'No roles have been embedded yet.' });
    expect(result.total).toBe((await jobFeed(db, new URLSearchParams('q=Engineer'))).total);
  });

  it('ranks feed roles by meaning, best first, with their similarity', async () => {
    const model = fakeEmbedder();
    for (const key of ['de', 'fe', 'ml']) {
      const row = await db.prepare('SELECT title,data FROM jobs WHERE id=?').bind(id(key)).first<any>();
      const text = `${row.title} ${JSON.parse(row.data).description}`;
      await saveEmbedding(db, id(key), embeddingHash(text), model.model, (await model.embedPassages([text]))[0]);
    }
    const result = await feed('q=' + encodeURIComponent('I want to train learning models') + '&semantic=1');
    expect(result.search).toEqual({ mode: 'semantic', rolesWithoutVectors: 1 });
    expect(result.total).toBe(3);
    expect(result.jobs[0].id).toBe(id('ml'));
    expect(result.jobs.map(j => j.id).sort()).toEqual([id('de'), id('fe'), id('ml')]);
    expect(result.jobs[0].similarity).toBeGreaterThan(0.9);
    expect(result.jobs[0].similarity!).toBeGreaterThan(result.jobs[1].similarity!);
    expect(result.facets.companies.length).toBeGreaterThan(0);
  });

  it('applies the usual filters but not a text match on the description', async () => {
    const remote = await feed('q=data+pipelines&semantic=1&mode=Remote');
    expect(remote.jobs.map(j => j.id)).toEqual([id('fe')]);
    // No role contains the words "ETL on a warehouse", yet the data role ranks first.
    const etl = await feed('q=ETL+on+a+warehouse&semantic=1');
    expect(etl.jobs[0].id).toBe(id('de'));
  });

  it('pages through ranked roles in pages of 18', async () => {
    const result = await feed('q=data&semantic=1&page=9');
    expect(result.page).toBe(1);
    expect(result.pages).toBe(1);
  });

  it('falls back with a reason when the model is missing or fails', async () => {
    expect((await feed('q=data&semantic=1', null)).search).toEqual({ mode: 'keyword', fallback: 'The search model is not available on this server.' });
    const broken = createQueryEmbedder(async () => { throw new Error('no model'); });
    const result = await feed('q=data&semantic=1', broken);
    expect(result.search).toEqual({ mode: 'keyword', fallback: 'The search model is unavailable (no model).' });
    expect(result.jobs.every(j => j.similarity === undefined)).toBe(true);
    expect((await feed('semantic=1')).search?.fallback).toBe('Describe the role to rank roles by meaning.');
  });

  it('is served on /api/jobs with semantic=1 and leaves the keyword feed unchanged', async () => {
    const api = freeFetch(db, embedder);
    const semantic = await (await api(new Request('https://atlas.test/api/jobs?semantic=1&q=react+interfaces'))).json() as any;
    expect(semantic.search.mode).toBe('semantic');
    expect(semantic.jobs[0].id).toBe(id('fe'));
    const keyword = await (await api(new Request('https://atlas.test/api/jobs?q=react'))).json() as any;
    expect(keyword.search).toBeUndefined();
    expect(keyword.jobs.map((j: any) => j.id)).toEqual([id('fe')]);
  });

  it('is offered to assistants as the semantic_search MCP tool', async () => {
    const handler = createAtlasMcpHandler(db, { embedder });
    const response = await handler.fetch(new Request('https://atlas.test/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'semantic_search', arguments: { description: 'training pytorch models', workMode: ['On-site', 'Unspecified', 'Hybrid'] } } }),
    }));
    const body = await response.text();
    const json = JSON.parse(body.trimStart().startsWith('{') ? body : body.split('\n').find(line => line.startsWith('data: '))!.slice(6));
    const out = json.result.structuredContent;
    expect(out.mode).toBe('semantic');
    expect(out.jobs[0].id).toBe(id('ml'));
    expect(out.jobs[0].similarity).toBeGreaterThan(0.9);
    expect(out.jobs.map((j: any) => j.id)).not.toContain(id('fe'));
  });
});

describe('bundled query model', () => {
  it('copies the files fastembed reads and reports any that are missing', () => {
    const cache = mkdtempSync(join(tmpdir(), 'atlas-cache-')), out = mkdtempSync(join(tmpdir(), 'atlas-model-'));
    expect(missingModelFiles(cache)).toEqual(MODEL_FILES);
    expect(() => copyModel(cache, out)).toThrow(/missing model_optimized.onnx/);
    mkdirSync(join(cache, MODEL_FOLDER));
    for (const file of MODEL_FILES) writeFileSync(join(cache, MODEL_FOLDER, file), file);
    copyModel(cache, out);
    expect(missingModelFiles(out)).toEqual([]);
    expect(readFileSync(join(out, MODEL_FOLDER, 'config.json'), 'utf8')).toBe('config.json');
  });

  it('never downloads when loading offline from a folder without the model', async () => {
    await expect(loadFastEmbedder({ cacheDir: mkdtempSync(join(tmpdir(), 'atlas-empty-')), offline: true })).rejects.toThrow(/not bundled/);
  });

  it('lets the public function fall back to keywords when the model is not bundled', async () => {
    const result = await (await publicAPI.fetch(new Request('https://atlas.test/api/index?__atlasRoute=jobs&semantic=1&q=data+engineer'))).json() as any;
    expect(result.search.mode).toBe('keyword');
    expect(result.search.fallback).toMatch(/not bundled|not been embedded/);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});
