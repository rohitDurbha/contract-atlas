import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement } from '../server/db';
import { makeJob } from '../server/normalize';
import { pruneSnapshot } from '../server/prune';
import { SOURCES } from '../server/sources';
import {
  EMBEDDING_MODEL, decodeVector, dot, embeddingHash, embeddingText, encodeVector, normalize, pendingEmbeddings, saveEmbedding, semanticSearch,
  type Embedder,
} from '../server/embeddings';

const now = new Date('2026-11-19T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

// A stand-in model that counts a few topic words, so similarity is easy to
// predict and the tests never download anything.
const TOPICS = [['data', 'pipeline', 'pipelines', 'airflow', 'warehouse'], ['react', 'frontend', 'interfaces', 'typescript'], ['model', 'models', 'pytorch', 'training', 'learning']];
function topicVector(text: string): Float32Array {
  const words = text.toLowerCase().split(/[^a-z]+/);
  return Float32Array.from(TOPICS.map(topic => words.filter(w => topic.includes(w)).length + 0.01));
}
const fake: Embedder = {
  model: 'test/topics', dimensions: TOPICS.length,
  async embedPassages(texts) { return texts.map(topicVector); },
  async embedQuery(text) { return topicVector(text); },
};

describe('vector helpers', () => {
  it('round-trips a vector through the float32 blob format', () => {
    const vector = Float32Array.from([0.25, -1.5, 3.125]);
    const blob = encodeVector(vector);
    expect(blob.byteLength).toBe(12);
    // Little-endian float32, the layout sqlite-vec reads.
    expect([...blob.slice(0, 4)]).toEqual([0, 0, 128, 62]);
    expect([...decodeVector(blob)]).toEqual([0.25, -1.5, 3.125]);
    expect(() => decodeVector(new Uint8Array(5))).toThrow();
  });

  it('normalizes to unit length so the dot product is cosine similarity', () => {
    const a = normalize([3, 4]);
    expect(a[0]).toBeCloseTo(0.6);
    expect(dot(a, a)).toBeCloseTo(1);
    expect(dot(normalize([1, 0]), normalize([0, 2]))).toBe(0);
    expect([...normalize([0, 0])]).toEqual([0, 0]);
    expect(() => dot(new Float32Array(2), new Float32Array(3))).toThrow();
  });

  it('embeds the title, skills and plain description only', () => {
    const text = embeddingText({ title: ' Data Engineer ', skills: ['Python', ' ', 'SQL'], description: '<p>Build <b>pipelines</b> &amp; models.</p>' });
    expect(text).toBe('Data Engineer\nSkills: Python, SQL\nBuild pipelines & models.');
    expect(embeddingText({ title: 'QA', skills: [], description: '' })).toBe('QA');
    expect(embeddingText({ title: 'QA', skills: [], description: 'x'.repeat(5000) }).length).toBeLessThan(1600);
  });

  it('hashes by text and model', () => {
    expect(embeddingHash('a')).toBe(embeddingHash('a', EMBEDDING_MODEL.name));
    expect(embeddingHash('a')).not.toBe(embeddingHash('b'));
    expect(embeddingHash('a')).not.toBe(embeddingHash('a', 'other/model'));
  });
});

describe('semantic search on a controlled database', () => {
  const sqlite = openSQLite(':memory:');
  const db = sqlite.db;
  const add = (id: string, title: string, posted: number, description: string, extra: Record<string, unknown> = {}) =>
    jobStatement(db, makeJob(SOURCES[0], { sourceJobId: id, title, applyUrl: 'https://example.com/jobs/' + id, postedAt: daysAgo(posted), description, ...extra }, now.toISOString())!).run();
  const id = (key: string) => `${SOURCES[0].id}:${key}`;

  async function embedPending() {
    const pending = await pendingEmbeddings(db, fake.model, now);
    const vectors = await fake.embedPassages(pending.map(p => p.text));
    for (const [i, p] of pending.entries()) await saveEmbedding(db, p.jobId, p.hash, fake.model, vectors[i], now);
    return pending.map(p => p.jobId).sort();
  }

  beforeAll(async () => {
    await ensureDB(db);
    await db.prepare('DELETE FROM jobs').run();
    await add('de', 'Data Engineer', 1, 'Build data pipelines in Airflow and load the warehouse.');
    await add('fe', 'Frontend Software Engineer', 2, 'Ship React and TypeScript interfaces.', { workMode: 'Remote' });
    await add('ml', 'Machine Learning Engineer', 3, 'Train PyTorch models and run training jobs.');
    // Outside the 90-day window and the retention period, so never embedded or ranked.
    await add('old', 'Data Engineer', 200, 'Data pipelines in Airflow.');
  });
  afterAll(() => sqlite.close());

  it('embeds only feed roles that have no vector yet', async () => {
    expect(await embedPending()).toEqual([id('de'), id('fe'), id('ml')]);
    expect(await pendingEmbeddings(db, fake.model, now)).toEqual([]);
    const row = await db.prepare('SELECT model,dimensions,vector FROM job_embeddings WHERE job_id=?').bind(id('de')).first<any>();
    expect(row.model).toBe('test/topics');
    expect(row.dimensions).toBe(3);
    expect(dot(decodeVector(row.vector), decodeVector(row.vector))).toBeCloseTo(1);
  });

  it('embeds a role again when its text or the model changes', async () => {
    await add('fe', 'Frontend Software Engineer', 2, 'Ship React and TypeScript interfaces with Storybook.', { workMode: 'Remote' });
    expect((await pendingEmbeddings(db, fake.model, now)).map(p => p.jobId)).toEqual([id('fe')]);
    await embedPending();
    expect(await pendingEmbeddings(db, 'other/model', now)).toHaveLength(3);
  });

  it('ranks roles by meaning and honours filters', async () => {
    const result = await semanticSearch(db, await fake.embedQuery('I want to train learning models'), { model: fake.model, now });
    expect(result.rolesCompared).toBe(3);
    expect(result.rolesWithoutVectors).toBe(0);
    expect(result.matches[0].job.id).toBe(id('ml'));
    expect(result.matches[0].similarity).toBeGreaterThan(0.9);
    expect(result.matches[0].similarity).toBeGreaterThan(result.matches[1].similarity);

    const remote = await semanticSearch(db, await fake.embedQuery('data pipelines'), { model: fake.model, now, workMode: 'Remote', limit: 5 });
    expect(remote.matches.map(m => m.job.id)).toEqual([id('fe')]);
  });

  it('counts roles without a vector from the requested model instead of failing', async () => {
    const result = await semanticSearch(db, [1, 0, 0], { model: 'other/model', now });
    expect(result).toEqual({ rolesCompared: 0, rolesWithoutVectors: 3, matches: [] });
    // A query of the wrong size cannot be compared with the stored vectors.
    const wrongSize = await semanticSearch(db, [1, 0], { model: fake.model, now });
    expect(wrongSize.rolesCompared).toBe(0);
    expect(wrongSize.rolesWithoutVectors).toBe(3);
  });

  it('drops vectors when their role is pruned', async () => {
    await saveEmbedding(db, id('old'), 'h', fake.model, [1, 0, 0], now);
    await pruneSnapshot(db, now);
    const left = (await db.prepare('SELECT job_id FROM job_embeddings ORDER BY job_id').all<any>()).results.map((r: any) => r.job_id);
    expect(left).toEqual([id('de'), id('fe'), id('ml')]);
  });
});

describe('older snapshots', () => {
  it('gain the job_embeddings table when the schema is ensured', async () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec("CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('seeded','true')");
    const db = openDatabase(raw);
    await ensureDB(db);
    const table = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job_embeddings'").first('name');
    expect(table).toBe('job_embeddings');
    raw.close();
  });
});
