// Copies the bge-small model from the fastembed cache into data/model before
// the Vercel deploy, so the API can embed semantic search queries. The model
// is downloaded first when the cache is empty. data/model is ignored by git
// and uploaded by the Vercel CLI, which reads .vercelignore but not
// .gitignore. A failure only leaves semantic search on its keyword fallback,
// so this script never fails the workflow.
import { BUNDLED_MODEL_DIR, DEFAULT_MODEL_CACHE, copyModel, loadFastEmbedder, missingModelFiles } from '../server/fastembed';

const cacheDir = process.env.FASTEMBED_CACHE || DEFAULT_MODEL_CACHE;
try {
  if (missingModelFiles(cacheDir).length) await loadFastEmbedder({ cacheDir });
  copyModel(cacheDir, BUNDLED_MODEL_DIR);
  // A quick check that the copied model loads and embeds a query.
  const embedder = await loadFastEmbedder({ cacheDir: BUNDLED_MODEL_DIR, offline: true });
  const vector = await embedder.embedQuery('remote data engineer');
  console.log(JSON.stringify({ bundled: BUNDLED_MODEL_DIR, model: embedder.model, dimensions: vector.length }));
} catch (error) {
  console.warn('The query model was not bundled; semantic search will fall back to keywords.', error instanceof Error ? error.message : error);
}
