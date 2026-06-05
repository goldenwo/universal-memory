// server/lib/lane-classifier.mjs
// Gap-5: write-time lane auto-classification via embedding-centroid nearest-match.
// Reuses the fact embedding dedup already computes (add.mjs:231) — no extra LLM call.
// Spec: docs/plans/2026-06-04-gap5-lane-classifier-spec.md.

// Cosine over RAW embedding vectors (embeddings are not guaranteed unit-norm).
export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function meanPool(vectors) {
  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) mean[i] += v[i];
  for (let i = 0; i < dim; i++) mean[i] /= vectors.length;
  return mean; // cosineSimilarity normalizes, so no unit-normalization needed here
}

export function classifyByCentroid(vector, centroids, { threshold, margin = 0 } = {}) {
  if (!centroids.length) return { lane: null, score: 0 };
  const scored = centroids
    .map(({ slug, centroid }) => ({ slug, score: cosineSimilarity(vector, centroid) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1]?.score ?? -Infinity;
  if (top.score < threshold) return { lane: null, score: top.score };
  if (margin > 0 && top.score - second < margin) return { lane: null, score: top.score };
  return { lane: top.slug, score: top.score };
}
