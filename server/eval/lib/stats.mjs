// server/eval/lib/stats.mjs — shared distribution statistics for the eval harnesses.
//
// The nearest-rank percentile + distribution-summary pattern lived in three eval
// harnesses (memory-quality-eval's percentile/summarizeLatency, lane-eval's and
// d3-eval's nearestRank/distStats). Rule-of-three → extracted here so the rank
// math has a single home. Each consumer keeps its own domain name + percentile
// set as a thin wrapper, so no consumer's output shape changes.
//
// Pure + dependency-free: importing this never pulls live/provider code into the
// offline unit-test scope.

/**
 * Filter a sample down to finite numbers and return a sorted-ascending copy.
 * Non-finite entries (NaN, ±Infinity) and non-numbers are dropped; null/undefined
 * samples are treated as empty. The single place the sample is cleaned + ordered.
 *
 * @param {number[]|null|undefined} samples
 * @returns {number[]} new ascending array of the finite values
 */
function toSortedFinite(samples) {
  return (samples ?? []).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
}

/**
 * Nearest-rank value at quantile `q` over a SORTED-ascending array. The single
 * rank formula: idx = clamp(ceil(q*n) - 1, 0, n-1), so q=0 → first and q=1 →
 * last. (Algebraically identical to clamp(ceil(q*n), 1, n) - 1.) Empty → null.
 *
 * @param {number[]} sortedAsc  ascending, finite
 * @param {number} q  quantile fraction in [0,1]
 * @returns {number|null}
 */
function rankValue(sortedAsc, q) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sortedAsc[idx];
}

/**
 * Nearest-rank percentile of a numeric sample. `q` ∈ [0,1]: sorts a copy
 * ascending and returns the value at idx = clamp(ceil(q*n)-1, 0, n-1), so q=0 →
 * min and q=1 → max. Non-finite entries are dropped; an empty (or null) sample →
 * null. Nearest-rank (not interpolated) — the standard latency-baseline choice
 * and exact-testable.
 *
 * @param {number[]|null|undefined} samples
 * @param {number} q  percentile as a fraction in [0,1]
 * @returns {number|null}
 */
export function percentile(samples, q) {
  return rankValue(toSortedFinite(samples), q);
}

/**
 * Summarize a numeric sample into { count, ...requested percentiles, min, max,
 * mean } over its finite values. The percentile set is a parameter so each
 * consumer keeps its own labels/quantiles (mq: p50/p95; lane/d3: p25/median/p75)
 * with no shape change. Empty (or null) sample → count 0 with every stat null.
 * No rounding — kept exact for unit tests; renderers round for display.
 *
 * @param {number[]|null|undefined} samples
 * @param {Array<[string, number]>} [percentiles]  ordered [label, q] pairs
 * @returns {{ count: number, min: number|null, max: number|null, mean: number|null } & Record<string, number|null>}
 */
export function summarize(samples, percentiles = []) {
  const sorted = toSortedFinite(samples);
  const n = sorted.length;
  const out = { count: n };
  for (const [label, q] of percentiles) out[label] = rankValue(sorted, q);
  if (n === 0) {
    out.min = out.max = out.mean = null;
    return out;
  }
  out.min = sorted[0];
  out.max = sorted[n - 1];
  out.mean = sorted.reduce((s, v) => s + v, 0) / n;
  return out;
}
