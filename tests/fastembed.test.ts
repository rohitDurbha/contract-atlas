import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMBEDDING_MODEL, QUERY_PREFIX } from '../server/embeddings';

// fastembed is replaced with a stand-in, so the test checks how the adapter
// calls it without downloading the model or loading ONNX Runtime.
const state = vi.hoisted(() => ({ init: [] as unknown[], embedded: [] as { texts: string[]; batchSize?: number }[], size: 384 }));
vi.mock('fastembed', () => ({
  EmbeddingModel: { BGESmallENV15: 'fast-bge-small-en-v1.5' },
  FlagEmbedding: {
    async init(options: unknown) {
      state.init.push(options);
      return {
        async *embed(texts: string[], batchSize?: number) {
          state.embedded.push({ texts, batchSize });
          for (let i = 0; i < texts.length; i += batchSize ?? 256) {
            yield texts.slice(i, i + (batchSize ?? 256)).map((_, j) => Array.from({ length: state.size }, (_, k) => (k === 0 ? i + j + 1 : 0)));
          }
        },
        passageEmbed() { throw new Error('the e5 passage prefix must not be used'); },
        queryEmbed() { throw new Error('the e5 query prefix must not be used'); },
      };
    },
  },
}));

const { loadFastEmbedder, DEFAULT_MODEL_CACHE } = await import('../server/fastembed');

describe('fastembed adapter', () => {
  beforeEach(() => { state.init.length = 0; state.embedded.length = 0; state.size = 384; });

  it('loads bge-small from the cache folder without a progress bar', async () => {
    const embedder = await loadFastEmbedder();
    expect(embedder.model).toBe(EMBEDDING_MODEL.name);
    expect(embedder.dimensions).toBe(EMBEDDING_MODEL.dimensions);
    expect(state.init).toEqual([{ model: 'fast-bge-small-en-v1.5', cacheDir: DEFAULT_MODEL_CACHE, maxLength: 512, showDownloadProgress: false }]);
    await loadFastEmbedder({ cacheDir: '/tmp/models' });
    expect((state.init[1] as { cacheDir: string }).cacheDir).toBe('/tmp/models');
  });

  it('embeds passages as given, in order and in small batches', async () => {
    const embedder = await loadFastEmbedder();
    const texts = Array.from({ length: 40 }, (_, i) => `role ${i}`);
    const vectors = await embedder.embedPassages(texts);
    expect(state.embedded).toEqual([{ texts, batchSize: 32 }]);
    expect(vectors).toHaveLength(40);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors.map(v => v[0])).toEqual(texts.map((_, i) => i + 1));
  });

  it('adds the bge query prefix to searches', async () => {
    const embedder = await loadFastEmbedder();
    const vector = await embedder.embedQuery('  remote data engineer ');
    expect(state.embedded[0].texts).toEqual([QUERY_PREFIX + 'remote data engineer']);
    expect(vector).toHaveLength(384);
  });

  it('rejects vectors of the wrong size', async () => {
    state.size = 768;
    const embedder = await loadFastEmbedder();
    await expect(embedder.embedPassages(['a'])).rejects.toThrow('768 values where 384 were expected');
  });
});
