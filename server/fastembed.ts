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
// The package is only imported when a refresh actually has roles to embed,
// so the Vercel function and the tests never load ONNX Runtime.
import { EMBEDDING_MODEL, QUERY_PREFIX, type Embedder } from './embeddings.js';

export const DEFAULT_MODEL_CACHE = '.cache/fastembed';
// Small batches keep memory flat on the two core Actions runner, since a
// batch is padded to its longest text.
const BATCH_SIZE = 32;

export async function loadFastEmbedder(options: { cacheDir?: string } = {}): Promise<Embedder> {
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
