/**
 * Retrieval relevance floor — the no-answer-precision gate (v1.6).
 *
 * `doSearch` returns the vector store's nearest neighbours regardless of
 * relevance, so an unanswerable query still surfaces the least-irrelevant
 * memory (a confident false positive). This module supplies the floor below
 * which a result is dropped, and the per-result keep/drop decision. When every
 * result is dropped, `doSearch` returns the empty envelope — abstention.
 *
 * Both functions are PURE (no metrics, no I/O) so they unit-test offline and the
 * eval sweep can reuse the exact production decision.
 *
 * SCALE NOTE: the floor compares the memory-client SEARCH score (~0.20–0.65 in
 * practice), NOT the dedup/supersession cosine scale (0.84+). It is unrelated to
 * `UM_AUTOSUPERSEDE_RETRIEVAL_THRESHOLD` (0.45 cosine for contradiction-candidate
 * retrieval) — different scale, different purpose. Re-evaluate the default if the
 * embedding model changes (text-embedding-3-small).
 */

/**
 * PROVISIONAL default — pending the Phase-5 grown-fixture sweep (acceptance gates
 * a–e in docs/plans/2026-06-19-no-answer-precision-spec.md §4). Recall-safe by
 * design: pinned below the lowest measured answerable score. Keep in lockstep
 * with server/.env.example UM_RETRIEVAL_MIN_SCORE (the drift gate).
 */
export const DEFAULT_RETRIEVAL_MIN_SCORE = 0.30;

/**
 * Minimum search score for a result to be returned. Default-on (the provisional
 * default above); `UM_RETRIEVAL_MIN_SCORE=0` is the inert escape hatch.
 * Mirrors the `contradictionBandCeiling(env)` reader shape.
 *
 * @param {object} [env=process.env]
 * @returns {number} the floor (0 = off)
 */
export function retrievalMinScore(env = process.env) {
  const n = Number.parseFloat(env.UM_RETRIEVAL_MIN_SCORE);
  return Number.isFinite(n) ? n : DEFAULT_RETRIEVAL_MIN_SCORE;
}

/**
 * Per-result keep/drop decision — recall-safe.
 *
 * - floor ≤ 0 → inert (keep everything).
 * - missing / non-numeric score → KEEP (never drop on absent score — a client
 *   that omits scores must not have its results nuked).
 * - present numeric score → keep iff `score >= floor` (inclusive lower edge).
 *
 * @param {number} score - the result's search score
 * @param {number} floor - the relevance floor (from retrievalMinScore())
 * @returns {boolean} true = keep
 */
export function passesRelevanceFloor(score, floor) {
  if (!(floor > 0)) return true;                                   // inert
  if (typeof score !== 'number' || !Number.isFinite(score)) return true; // missing/non-numeric → keep
  return score >= floor;
}
