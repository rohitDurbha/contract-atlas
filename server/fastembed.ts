// The bge-small embedder the refresh workflow uses, through fastembed and
// ONNX Runtime on the CPU.
//
// fastembed downloads the quantized Qdrant export of BAAI/bge-small-en-v1.5
// from Hugging Face into cacheDir the first time, and the workflow caches
// that folder between runs. fastembed's own passageEmbed and queryEmbed add
// the "passage:" and "query:" prefixes that e5 models expect, which bge was
// not trained with, so this adapter calls embed() and adds the bge query
// prefix itself.
//
// The package is only imported when a refresh has roles to embed, or when the
// Vercel function answers its first semantic search, so other requests and the
// tests never load ONNX Runtime.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDING_MODEL, QUERY_PREFIX, type Embedder } from './embeddings.js';

export const DEFAULT_MODEL_CACHE = '.cache/fastembed';
// Where the refresh workflow copies the model before deploying, so the Vercel
// function can embed search queries without downloading anything.
export const BUNDLED_MODEL_DIR = 'data/model';
// The folder and files fastembed keeps for bge-small inside its cache.
export const MODEL_FOLDER = 'Qdrant_bge-small-en-v1.5-onnx-Q';
export const MODEL_FILES = ['model_optimized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json', 'special_tokens_map.json'];

export function missingModelFiles(cacheDir: string): string[] {
  return MODEL_FILES.filter(file => !existsSync(join(cacheDir, MODEL_FOLDER, file)));
}

// Copies the cached model into another folder in the layout fastembed reads.
export function copyModel(fromCache: string, toDir: string): void {
  const missing = missingModelFiles(fromCache);
  if (missing.length) throw new Error(`The model cache is missing ${missing.join(', ')}.`);
  mkdirSync(join(toDir, MODEL_FOLDER), { recursive: true });
  for (const file of MODEL_FILES) copyFileSync(join(fromCache, MODEL_FOLDER, file), join(toDir, MODEL_FOLDER, file));
}
// Small batches keep memory flat on the two core Actions runner, since a
// batch is padded to its longest text.
const BATCH_SIZE = 32;

// With offline set, a missing model file is an error instead of a download,
// which suits the read-only Vercel filesystem.
export async function loadFastEmbedder(options: { cacheDir?: string; offline?: boolean } = {}): Promise<Embedder> {
  if (options.offline) {
    const missing = missingModelFiles(options.cacheDir ?? DEFAULT_MODEL_CACHE);
    if (missing.length) throw new Error(`The model is not bundled (missing ${missing.join(', ')}).`);
  }
  const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
  const model = await FlagEmbedding.init({
    model: EmbeddingModel.BGESmallENV15,
    cacheDir: options.cacheDir ?? DEFAULT_MODEL_CACHE,
    maxLength: 512,
    showDownloadProgress: false,
  });
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for await (const batch of model.embed(texts, BATCH_SIZE)) {
      for (const vector of batch) {
        if (vector.length !== EMBEDDING_MODEL.dimensions) {
          throw new Error(`The model returned ${vector.length} values where ${EMBEDDING_MODEL.dimensions} were expected.`);
        }
        out.push(Float32Array.from(vector));
      }
    }
    return out;
  };
  return {
    model: EMBEDDING_MODEL.name,
    dimensions: EMBEDDING_MODEL.dimensions,
    embedPassages: embed,
    async embedQuery(text: string) {
      return (await embed([QUERY_PREFIX + text.trim()]))[0];
    },
  };
}
