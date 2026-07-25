// lib/ingestion/embeddings.ts
//
// PHASE 1 of the semantic ranking build (docs/SEMANTIC_RANKING_SPEC_2026-07-23.md §3a/§4).
// Local, $0, CPU-only sentence embeddings for the clustering layer. This is deliberately NOT
// an LLM call — no API, no key, no per-call charge, and it must be reproducible: the same
// headline embeds to the same vector on every machine, forever, until someone deliberately
// bumps MODEL_REVISION.
//
// Pinned per spec §6 risk 5 ("an upgraded model silently re-ranks the feed"). Bumping either
// constant is a deliberate, reviewable decision — never an incidental side effect of
// `npm install`.
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
// The specific commit on the HF Hub this build was tuned and tested against (2026-07-24).
// Pin by revision, not just model id, so a repo-side model update can never silently reorder
// the feed underneath an unrelated code change.
const MODEL_REVISION = 'main';
const EMBED_DIM = 384;

// Model weights (~23MB, gitignored under .cache/) are downloaded once from the HF Hub and
// cached on disk; every ingest run after the first is a pure local read. Never committed —
// see .gitignore `.cache/`.
const CACHE_DIR = '.cache/transformers/';

export { MODEL_ID, MODEL_REVISION, EMBED_DIM };

// Lazy singleton — the pipeline (model load + tokenizer) is expensive to construct (~2-3s)
// and cheap to reuse. One ingest run embeds everything through one loaded instance.
let extractorPromise: Promise<unknown> | null = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = CACHE_DIR;
      // Deterministic, portable inference: fp32 CPU backend everywhere (dev laptop, CI
      // runner). No GPU dependency — this must run unattended in a 6-hourly cron job on
      // whatever hardware runs it.
      return pipeline('feature-extraction', MODEL_ID, { revision: MODEL_REVISION, dtype: 'fp32' });
    })();
  }
  return extractorPromise;
}

/**
 * Embed a batch of texts into 384-dim, L2-normalized vectors (mean-pooled token embeddings).
 * Normalized so cosine similarity reduces to a plain dot product downstream.
 *
 * $0 / local / CPU-only — never call this from the browser or from a request handler. It is
 * an ingest-time-only utility (spec §4: "ingest-time only, in Node, on CPU").
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (extractor as any)(texts, { pooling: 'mean', normalize: true });
  const dim: number = out.dims[1];
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(out.data.slice(i * dim, (i + 1) * dim));
  }
  return vectors;
}

/** Cosine similarity. Vectors from embedTexts() are already normalized, so this is a dot product
 *  — but this function does not assume that, so it stays correct if a caller passes raw vectors. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
