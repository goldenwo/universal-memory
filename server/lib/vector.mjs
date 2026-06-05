// server/lib/vector.mjs — shared vector math (cosine + mean-pool).
//
// Single source for the cosine the codebase computes in three places (rule of
// three): the production lane classifier (lib/lane-classifier.mjs) and the two
// offline eval harnesses (eval/dedup-threshold-sweep.mjs, eval/lane-eval.mjs).
//
// TWO deliberately distinct failure contracts share one core formula:
//   - cosineSimilarity → FAIL-SAFE: returns 0 on a degenerate/empty vector and
//       NEVER throws. The production classify path must never fail a user's
//       write over a bad vector. It assumes equal-length inputs (guaranteed by
//       the same-embed-model invariant) and does not validate dimensions.
//   - cosineStrict → FAIL-LOUD: validates that both inputs are non-empty arrays
//       of equal length and throws otherwise. The eval harnesses want a
//       malformed fixture vector to surface as an error, not silently score 0.
// Both return the same value on valid same-dim inputs (including 0 for a
// zero-magnitude vector).

/**
 * Fail-safe cosine over RAW embedding vectors (embeddings are not guaranteed
 * unit-norm). Returns 0 when either vector has zero magnitude; never throws.
 * Assumes a.length === b.length (same-model invariant) — does not validate.
 */
export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Fail-loud cosine: throws if either input is not a non-empty array, or if the
 * dimensions differ. Otherwise identical to cosineSimilarity (returns 0 on a
 * zero-magnitude vector). For eval harnesses where a bad vector is a bug.
 */
export function cosineStrict(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    throw new Error('cosineStrict: vectors must be non-empty arrays of equal length');
  }
  return cosineSimilarity(a, b);
}

/**
 * Elementwise mean of same-length vectors → one pooled vector. Returns [] for
 * an empty input (defensive; callers pass ≥1 same-dim vector). cosine callers
 * normalize, so the pooled vector is intentionally left un-normalized.
 */
export function meanPool(vectors) {
  if (!vectors.length) return [];
  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) mean[i] += v[i];
  for (let i = 0; i < dim; i++) mean[i] /= vectors.length;
  return mean;
}
