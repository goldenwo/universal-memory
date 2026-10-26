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
import { dirname } from 'node:path';
import { fHalfFrom, f1From } from './fbeta.mjs';
import { pickThreshold } from './d3-eval.mjs';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';
import { timed, callRecord, fileSha256 } from './lib/call-record.mjs';
// TAU_ANSWER relocated to lib/answer-grader.mjs (read-path bouncer needs it without a prod→eval
// import). Re-exported here so existing importers (memory-quality-eval.mjs) keep working.
export { TAU_ANSWER } from '../lib/answer-grader.mjs';

export const PRECISION_FLOOR = 0.90;   // §4a reliability gate (single home; drift-tested)

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

/**
 * `runs` serial runs of the grader over every triple, each swept and τ-picked. Each judged row
 * keeps the verdict, its raw confidence and the call record (ok, failCause, the R1 fields,
 * latency); a parse-fail or invoke-error (ok !== true) is excluded from the sweep (model
 * migration Phase B, spec R2). The model is passed explicitly on every call.
 */
export async function runGrader({ rows, grade, model, runs = 1 }) {
  const out = [];
  for (let r = 0; r < runs; r++) {
    const judged = [];
    for (const row of rows) {
      const v = await timed(() => grade(row.query, row.memory, { model }));
      judged.push({ id: row.id, gold: row.gold === true, answers: v.answers, confidence: v.confidence, category: row.category, ...callRecord(v) });
    }
    const { sweep, chosen, parseFails, graded } = buildResultJson({ judged, fixturePath: null, model });
    out.push({ run: r + 1, parseFails, graded, sweep, chosen, judged });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI shim. Live deps are lazy-imported inside cliMain so importing this module from a test
// stays offline.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { runs: 1 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--runs') args.runs = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
  }
  return args;
}

/** Why the CLI cannot run, or null. A measurement names its grader: no silent default model. */
export function cliError(args, env) {
  if (!args.fixture) return 'Usage: answer-grader-eval.mjs --fixture <path> --out <path> [--runs N] (needs --fixture)';
  if (!args.out) return '--out <path> is required';
  if (!env.UM_ANSWER_GRADER_MODEL) return 'UM_ANSWER_GRADER_MODEL is required: the grader model is named, never defaulted';
  return null;
}

async function cliMain() {
  const args = parseArgs(process.argv);
  const err = cliError(args, process.env);
  if (err) { console.error(`[answer-grader-eval] ${err}`); process.exit(2); }
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) {
    console.error('[answer-grader-eval] OPENAI_API_KEY not set — skipping (run: node --env-file=.env eval/answer-grader-eval.mjs --fixture eval/answer-grader-set.jsonl --out <path>)');
    process.exit(2);
  }

  const { gradeAnswer } = await import('../lib/answer-grader.mjs');
  const model = process.env.UM_ANSWER_GRADER_MODEL;
  const rows = await loadFixtureJsonl(args.fixture);
  const runs = await runGrader({ rows, grade: gradeAnswer, model, runs: args.runs });
  const result = { timestamp: new Date().toISOString(), fixture: args.fixture, fixtureSha256: await fileSha256(args.fixture), model, precisionFloor: PRECISION_FLOOR, runs };
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  for (const r of runs) {
    console.log(`[answer-grader-eval] run ${r.run} model=${model} graded=${r.graded} parseFails=${r.parseFails}`);
    console.log('[answer-grader-eval] chosen:', JSON.stringify(r.chosen));
  }
  console.log(`[answer-grader-eval] written to ${args.out}`);
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) cliMain().catch((e) => { console.error('[answer-grader-eval] FATAL:', process.env.GITHUB_ACTIONS ? (e?.message ?? e) : e); process.exit(1); });
