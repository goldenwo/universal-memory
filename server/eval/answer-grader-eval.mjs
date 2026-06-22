/**
 * server/eval/answer-grader-eval.mjs — Layer-1 reliability eval for the answer grader.
 *
 * Sibling of eval/d3-eval.mjs. Runs the shipped grader (lib/answer-grader.mjs) over a
 * labelled fixture (eval/answer-grader-set.jsonl) of (query, memory, gold) triples and
 * reports precision/recall across confidence thresholds, so a human can pin τ_answer.
 * pickThreshold + the fbeta helpers are reused from d3-eval/fbeta; computeMetrics is
 * mirrored here (NOT d3's — every triple is comparable; fields are gold/answers).
 *
 * Re-eval trigger: the pinned TAU_ANSWER (and the mq §4e gate floors) are invalidated by a
 * change to the grader model OR to text-embedding-3-small — re-run this eval to re-pin.
 *
 * Pure fns are unit-tested in test/answer-grader-eval.test.mjs; the CLI shim (IS_MAIN)
 * lazy-imports the live grader so importing this module from a test stays offline.
 */
import { fHalfFrom, f1From } from './fbeta.mjs';

export const PRECISION_FLOOR = 0.90;   // §4a reliability gate (single home; drift-tested)
export const TAU_ANSWER = 0.0;         // PINNED IN P2 from the live sweep — placeholder until measured

/**
 * Confusion-matrix metrics at a single confidence threshold τ. Parse-fails (ok!==true)
 * are EXCLUDED. predictedPositive = (answers===true && confidence>=τ); actualPositive = gold===true.
 *
 * @param {Array<{gold:boolean, answers:boolean, confidence:number, ok:boolean}>} judged
 * @param {number} tau
 */
export function computeMetrics(judged, tau) {
  let tp = 0, fp = 0, fn = 0, tn = 0, graded = 0;
  for (const row of judged) {
    if (row.ok !== true) continue;
    graded++;
    const predictedPositive = row.answers === true && row.confidence >= tau;
    const actualPositive = row.gold === true;
    if (predictedPositive && actualPositive) tp++;
    else if (predictedPositive && !actualPositive) fp++;
    else if (!predictedPositive && actualPositive) fn++;
    else tn++;
  }
  const precision = (tp + fp) === 0 ? null : tp / (tp + fp);
  const recall = (tp + fn) === 0 ? null : tp / (tp + fn);
  return { tau, tp, fp, fn, tn, graded, precision, recall, f1: f1From(precision, recall), fHalf: fHalfFrom(precision, recall) };
}

/**
 * Run computeMetrics across an array of thresholds.
 * @param {{judged: Array, thresholds: number[]}} args
 */
export function sweepThresholds({ judged, thresholds }) {
  return thresholds.map((t) => computeMetrics(judged, t));
}
