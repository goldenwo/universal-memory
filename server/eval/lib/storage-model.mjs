// server/eval/lib/storage-model.mjs
// Pure footprint math for the storage/index-growth eval (#19). No live calls, no qdrant —
// importing this stays fully offline (the harness no-live-calls contract).

export const FLOAT32_BYTES = 4;
export const DEFAULT_INDEXING_THRESHOLD = 20000; // qdrant optimizers_config.indexing_threshold default
export const DEFAULT_HNSW_M = 16;                // qdrant hnsw_config.m default

/** In-RAM float32 vector store cost for n points of dimension dim. */
export function vectorBytes(n, dim) {
  return n * dim * FLOAT32_BYTES;
}

/** Model prediction: qdrant builds the HNSW graph once a segment exceeds the indexing threshold. */
export function indexed(n, threshold = DEFAULT_INDEXING_THRESHOLD) {
  return n >= threshold;
}
