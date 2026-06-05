// server/eval/fbeta.mjs — precision-weighted F-score helpers shared by the eval
// harnesses (dedup-threshold-sweep.mjs, d3-eval.mjs, lane-eval.mjs). Rule-of-three
// extraction: the three harnesses each carried an identical copy.
//
// β=0.5: a false positive (false-merge / false-supersession / lane misroute) is
// destructive and often irreversible, so precision is weighted above recall when
// pinning a threshold. Both helpers return 0 on a null P/R or a zero denominator
// (the null guard is inert for callers that always pass numbers — e.g. the D1
// sweep — and load-bearing for those that can pass null, e.g. d3/lane metrics).

export const F_BETA = 0.5;
export const F_BETA_SQ = F_BETA * F_BETA;   // 0.25
export const F_PREFIX = 1 + F_BETA_SQ;      // 1.25

/** F0.5 (precision-weighted, β=0.5): (1.25·P·R)/(0.25·P + R). 0 when P/R null or denom 0. */
export function fHalfFrom(precision, recall) {
  if (precision == null || recall == null) return 0;
  const denom = F_BETA_SQ * precision + recall;
  if (denom === 0) return 0;
  return (F_PREFIX * precision * recall) / denom;
}

/** F1 (balanced harmonic mean): 2PR/(P+R). 0 when P/R null or denom 0. */
export function f1From(precision, recall) {
  if (precision == null || recall == null) return 0;
  const denom = precision + recall;
  if (denom === 0) return 0;
  return (2 * precision * recall) / denom;
}
