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
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fHalfFrom, f1From } from './fbeta.mjs';
import { pickThreshold } from './d3-eval.mjs';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';

export const PRECISION_FLOOR = 0.90;   // §4a reliability gate (single home; drift-tested)
// PINNED 2026-06-22 from 2 IDENTICAL live gpt-4o-mini runs (temp 0): precision 1.000 /
// recall 0.86 / fp=0 on 50 positives + 30 same-lane hard negatives. Precision is 1.0 across
// the whole τ≥0.05 plateau, so the recall-maximizing floor-clearing τ is the bottom (0.05) —
// the answers-boolean carries the precision; the confidence gate is near-inert at this model.
// RE-EVAL TRIGGER: a change to the grader model OR text-embedding-3-small invalidates this
// pin (and the mq §4e gate floors) — re-run eval/answer-grader-eval.mjs to re-pin.
export const TAU_ANSWER = 0.05;

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

const THRESHOLDS = Array.from({ length: 19 }, (_, i) => Number((0.05 + i * 0.05).toFixed(2))); // 0.05..0.95

/** PURE: build the result JSON from judged rows (sweep + chosen-τ via precision floor). */
export function buildResultJson({ judged, fixturePath, model }) {
  const sweep = sweepThresholds({ judged, thresholds: THRESHOLDS });
  const chosen = pickThreshold(sweep, { precisionFloor: PRECISION_FLOOR });
  const parseFails = judged.filter((r) => r.ok !== true).length;
  return { timestamp: null, fixture: fixturePath, model, precisionFloor: PRECISION_FLOOR, parseFails, graded: judged.length - parseFails, sweep, chosen };
}

// ---------------------------------------------------------------------------
// CLI shim — one invocation = one run (mirror d3; run twice for stability). Live deps
// are lazy-imported inside cliMain so importing this module from a test stays offline.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.fixture) { console.error('Usage: answer-grader-eval.mjs --fixture <path> [--out <path>]'); process.exit(2); }
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) {
    console.error('[answer-grader-eval] OPENAI_API_KEY not set — skipping (run: node --env-file=.env eval/answer-grader-eval.mjs --fixture eval/answer-grader-set.jsonl)');
    process.exit(2);
  }

  const { gradeAnswer } = await import('../lib/answer-grader.mjs');
  const model = process.env.UM_ANSWER_GRADER_MODEL ?? 'gpt-4o-mini';
  const rows = await loadFixtureJsonl(args.fixture);
  const judged = [];
  for (const row of rows) {
    const v = await gradeAnswer(row.query, row.memory, { model });
    judged.push({ id: row.id, gold: row.gold === true, answers: v.answers, confidence: v.confidence, ok: v.ok, category: row.category });
  }
  const result = buildResultJson({ judged, fixturePath: args.fixture, model });
  result.timestamp = new Date().toISOString();
  const out = args.out ?? `eval/results/${result.timestamp.slice(0, 10)}-answer-grader-run1.json`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`[answer-grader-eval] model=${model} graded=${result.graded} parseFails=${result.parseFails}`);
  console.log('[answer-grader-eval] chosen:', JSON.stringify(result.chosen));
  console.log(`[answer-grader-eval] written to ${out}`);
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) cliMain().catch((e) => { console.error('[answer-grader-eval] FATAL:', process.env.GITHUB_ACTIONS ? (e?.message ?? e) : e); process.exit(1); });
