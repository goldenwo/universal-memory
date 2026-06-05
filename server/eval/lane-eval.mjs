/**
 * server/eval/lane-eval.mjs — Gap-5 P2 lane-classifier threshold-eval harness.
 *
 * Sibling of eval/d3-eval.mjs (D3) and eval/dedup-threshold-sweep.mjs (D1). Same
 * structural contract: PURE exported functions (no I/O, unit-tested directly in
 * test/lane-eval.test.mjs) + a CLI shim guarded by IS_MAIN whose live deps
 * (embed / buildCentroids / classifyByCentroid / cosineStrict) are LAZY-imported
 * inside runOnce — so importing this module from a unit test never pulls the
 * embed SDK into test scope.
 *
 * Purpose: run the SHIPPED classifier (lib/lane-classifier.mjs classifyByCentroid)
 * over the labelled fixture (eval/lane-classifier-set.jsonl) and report routing
 * precision / recall across a τ_lane × margin grid, so a human can pin the lane
 * threshold. This is a MULTI-CLASS task with an abstain (omit → unpartitioned)
 * option, so the confusion is:
 *   TP = predicted a lane AND it matches the expected lane   (correct route)
 *   FP = predicted a lane that is WRONG                       (misroute to another
 *                                                             lane, OR routed a
 *                                                             should-stay-null fact)
 *   FN = predicted null but a lane was expected               (missed route — benign)
 *   TN = predicted null and null was expected                 (correct abstention)
 * precision = TP/(TP+FP) is the precision-killer metric: a wrong route populates
 * a lane the fact does not belong to, which wakes D3 on a mismatched partition →
 * a potential false auto-supersession (silent recall loss). recall = TP/(TP+FN).
 *
 * F0.5 is precision-weighted (β=0.5), mirroring D1/D3: a misroute is destructive
 * and only abstentions are cheap, so we favour precision. The chosen-cell rule is
 * a precision FLOOR (0.95 for this harder multi-class task vs D3's 0.98 binary):
 * among (τ,margin) cells clearing the floor, pick the MAX-recall cell (tie-break
 * higher precision, then lower margin, then lower τ). If none clears the floor,
 * report diagnostics and the CLI prints the GATE: do NOT flip — escalate to the
 * deferred LlmClassifier (spec §2 / §3.3) rather than ship a low-precision router.
 *
 * FAITHFULNESS: the decision is made by the REAL classifyByCentroid (injected as
 * `classify` into sweepGrid) — the eval never re-implements argmax/threshold/margin,
 * so it cannot drift from production. cosineStrict (lib/vector.mjs, FAIL-LOUD) is
 * used only for the separability diagnostic (top-centroid cosine distribution by
 * outcome) — a malformed vector there is a bug that must surface, not score 0.
 *
 * DETERMINISM: centroids are a pure function of the taxonomy + embed model; the
 * classifier decision is pure given the vectors. The only nondeterminism is the
 * embedding provider itself, so — like D1/D3 — we run TWICE and compare. The
 * embed model is recorded in the result JSON (`model`).
 *
 * NOTE (run provenance): run1.json and run2.json are two SEPARATE invocations;
 * lane-latest.json is a copy of the last run. Re-run via:
 *   node --env-file=.env eval/lane-eval.mjs \
 *     --fixture eval/lane-classifier-set.jsonl \
 *     --out eval/results/<date>-lane-run1.json
 *
 * This file is harness + CLI ONLY. It does not, and must not, modify any
 * production code or the fixture.
 */

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const F_BETA = 0.5;
const F_BETA_SQ = F_BETA * F_BETA;          // 0.25
const F_PREFIX = 1 + F_BETA_SQ;             // 1.25
const PRECISION_FLOOR = 0.95;               // chosen-cell rule (spec §5)
const NULL_KEY = 'null';                    // confusion-matrix key for the abstain axis

// ---------------------------------------------------------------------------
// PURE functions (no I/O) — unit-tested directly in test/lane-eval.test.mjs.
// ---------------------------------------------------------------------------

/** F0.5 (precision-weighted, β=0.5). 0 when P/R null or denom 0. */
function fHalfFrom(precision, recall) {
  if (precision == null || recall == null) return 0;
  const denom = F_BETA_SQ * precision + recall;
  if (denom === 0) return 0;
  return (F_PREFIX * precision * recall) / denom;
}

/** F1 (balanced). 0 when P/R null or denom 0. */
function f1From(precision, recall) {
  if (precision == null || recall == null) return 0;
  const denom = precision + recall;
  if (denom === 0) return 0;
  return (2 * precision * recall) / denom;
}

/**
 * Routing confusion at one (τ, margin) cell over an array of predictions.
 * Each prediction is `{ predicted: string|null, expected: string|null }`.
 *
 * precision = (tp+fp)===0 ? null : tp/(tp+fp)
 * recall    = (tp+fn)===0 ? null : tp/(tp+fn)
 *
 * @param {Array<{predicted, expected}>} predictions
 * @param {{tau:number, margin:number}} cell
 */
export function computeMetrics(predictions, { tau, margin }) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const { predicted, expected } of predictions) {
    const routed = predicted != null;
    const shouldRoute = expected != null;
    if (routed && predicted === expected) tp++;       // correct route
    else if (routed) fp++;                             // wrong lane OR routed a null-expected fact
    else if (shouldRoute) fn++;                        // abstained but should have routed
    else tn++;                                         // correct abstention
  }
  const precision = (tp + fp) === 0 ? null : tp / (tp + fp);
  const recall = (tp + fn) === 0 ? null : tp / (tp + fn);
  return {
    tau, margin,
    tp, fp, fn, tn,
    routed: tp + fp,
    shouldRoute: tp + fn,
    precision, recall,
    f1: f1From(precision, recall),
    fHalf: fHalfFrom(precision, recall),
  };
}

/**
 * Sweep the full τ × margin grid. `classify(row, {threshold, margin}) -> lane|null`
 * is INJECTED — the CLI passes a closure over the real classifyByCentroid (so no
 * decision logic is re-implemented here); unit tests pass a stub. One metrics row
 * per (τ, margin) cell.
 *
 * @param {{rows:Array, taus:number[], margins:number[], classify:Function}} args
 */
export function sweepGrid({ rows, taus, margins, classify }) {
  const grid = [];
  for (const tau of taus) {
    for (const margin of margins) {
      const predictions = rows.map((row) => ({
        predicted: classify(row, { threshold: tau, margin }),
        expected: row.expected_lane,
        category: row.category,
      }));
      grid.push(computeMetrics(predictions, { tau, margin }));
    }
  }
  return grid;
}

/**
 * Pick τ_lane (+ margin) via a precision FLOOR. Among grid cells with non-null
 * precision ≥ floor, return the MAX-recall cell — tie-break by higher precision,
 * then lower margin, then lower τ (prefer the simplest, most precise config at the
 * best achievable recall). If none clears the floor, return diagnostics (best
 * observed precision + the cell that produced it) so the CLI can fire the GATE.
 *
 * @param {Array} grid — sweepGrid output
 * @param {{precisionFloor:number}} opts
 */
export function pickThreshold(grid, { precisionFloor }) {
  const feasible = grid.filter((c) => c.precision != null && c.precision >= precisionFloor);
  if (feasible.length > 0) {
    feasible.sort((a, b) =>
      (b.recall - a.recall) ||
      (b.precision - a.precision) ||
      (a.margin - b.margin) ||
      (a.tau - b.tau));
    const c = feasible[0];
    return {
      meetsFloor: true,
      tau: c.tau, margin: c.margin,
      precision: c.precision, recall: c.recall,
      f1: c.f1, fHalf: c.fHalf,
      tp: c.tp, fp: c.fp, fn: c.fn, tn: c.tn,
    };
  }
  let best = null;
  for (const c of grid) {
    if (c.precision == null) continue;
    if (best == null || c.precision > best.precision) best = c;
  }
  return {
    meetsFloor: false,
    precisionFloor,
    bestPrecision: best?.precision ?? null,
    bestPrecisionTau: best?.tau ?? null,
    bestPrecisionMargin: best?.margin ?? null,
    bestPrecisionRecall: best?.recall ?? null,
  };
}

/**
 * Per-lane confusion matrix: matrix[expected][predicted] counts, with the null
 * (abstain) axis included on both sides. Shows which lanes bleed into which
 * (spec §5). Tolerates label values outside `lanes` by extending the matrix.
 *
 * @param {Array<{predicted, expected}>} predictions
 * @param {string[]} lanes
 */
export function buildConfusion(predictions, lanes) {
  const axis = [...lanes, NULL_KEY];
  const matrix = {};
  for (const e of axis) {
    matrix[e] = {};
    for (const p of axis) matrix[e][p] = 0;
  }
  for (const { predicted, expected } of predictions) {
    const e = expected == null ? NULL_KEY : expected;
    const p = predicted == null ? NULL_KEY : predicted;
    matrix[e] ??= {};
    matrix[e][p] = (matrix[e][p] ?? 0) + 1;
  }
  return { lanes, matrix };
}

// --- distribution helpers (shared by analyzeScores) -------------------------

/** Nearest-rank percentile over a SORTED ascending array. */
function nearestRank(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
  return sortedAsc[rank - 1];
}

/** Distribution stats for a numeric sample. Nulls when empty. */
function distStats(values) {
  const n = values.length;
  if (n === 0) return { count: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: n,
    min: sorted[0],
    p25: nearestRank(sorted, 0.25),
    median: nearestRank(sorted, 0.50),
    p75: nearestRank(sorted, 0.75),
    max: sorted[n - 1],
    mean: sum / n,
  };
}

/**
 * Top-centroid cosine distribution split by routing outcome at the chosen cell.
 * `scoredRows` carry `{ top1:number, outcome:'correct'|'misroute'|'missed'|'abstain_ok' }`.
 * The separation between the `correct` group (true lane facts, high top1) and the
 * null-expected groups grounds where τ_lane should sit.
 */
export function analyzeScores(scoredRows) {
  const groups = { correct: [], misroute: [], missed: [], abstain_ok: [] };
  for (const r of scoredRows) {
    if (groups[r.outcome] && typeof r.top1 === 'number') groups[r.outcome].push(r.top1);
  }
  return {
    correct: distStats(groups.correct),
    misroute: distStats(groups.misroute),
    missed: distStats(groups.missed),
    abstain_ok: distStats(groups.abstain_ok),
  };
}

// ---------------------------------------------------------------------------
// Pretty-print (pure) — mirrors d3-eval's formatSummaryTable.
// ---------------------------------------------------------------------------

function fmtNum(x, digits = 2) {
  return typeof x === 'number' && !Number.isNaN(x) ? x.toFixed(digits) : 'n/a';
}
function fmtPct(x) {
  return typeof x === 'number' && !Number.isNaN(x) ? x.toFixed(3) : 'n/a';
}

/**
 * Multi-line human summary: fixture counts, the τ-sweep table (margin=0 slice +
 * the chosen margin slice if non-zero), the chosen-cell line (or the GATE-miss
 * diagnostic), the per-lane confusion matrix, and the top-cosine-by-outcome block.
 */
export function formatSummaryTable(result) {
  const { fixtureCounts, grid, chosen, confusion, scores, precisionFloor } = result;
  const floor = precisionFloor ?? PRECISION_FLOOR;
  const lines = [];

  lines.push('=== Gap-5 Lane Classifier Threshold Eval ===');
  if (fixtureCounts) {
    lines.push(`Rows: ${fixtureCounts.total ?? 'n/a'}`);
    const byLane = fixtureCounts.byExpectedLane ?? {};
    lines.push('By expected lane: ' + Object.keys(byLane).sort().map((k) => `${k}=${byLane[k]}`).join(' '));
    const byCat = fixtureCounts.byCategory ?? {};
    lines.push('By category: ' + Object.keys(byCat).sort().map((k) => `${k}=${byCat[k]}`).join(' '));
  }
  lines.push('');
  lines.push('Routing metric over ALL rows: TP=correct-route  FP=misroute|routed-null  FN=missed  TN=correct-abstain.');
  lines.push('');

  // τ-sweep table — margin=0 slice + the chosen-margin slice (if non-zero).
  const chosenMargin = chosen?.meetsFloor ? chosen.margin : 0;
  const shownMargins = chosenMargin === 0 ? [0] : [0, chosenMargin];
  const tableRows = (grid ?? [])
    .filter((r) => shownMargins.includes(r.margin))
    .sort((a, b) => (a.margin - b.margin) || (a.tau - b.tau));
  lines.push('  τ    | m    | TP | FP | FN | TN | precision | recall | F1   | F0.5');
  lines.push('  -----+------+----+----+----+----+-----------+--------+------+------');
  for (const row of tableRows) {
    lines.push(
      `  ${fmtNum(row.tau)} | ${fmtNum(row.margin)} | ` +
      `${String(row.tp).padStart(2)} | ${String(row.fp).padStart(2)} | ${String(row.fn).padStart(2)} | ${String(row.tn).padStart(2)} | ` +
      `${fmtPct(row.precision).padStart(9)} | ${fmtPct(row.recall).padStart(6)} | ` +
      `${fmtNum(row.f1).padStart(4)} | ${fmtNum(row.fHalf).padStart(4)}`,
    );
  }
  lines.push('');

  // Chosen-cell line / GATE-miss diagnostic.
  if (chosen?.meetsFloor) {
    lines.push(
      `Chosen (precision floor ${floor}): τ=${fmtNum(chosen.tau)} margin=${fmtNum(chosen.margin)}  ` +
      `precision=${fmtPct(chosen.precision)} recall=${fmtPct(chosen.recall)} ` +
      `F1=${fmtNum(chosen.f1)} F0.5=${fmtNum(chosen.fHalf)}`,
    );
  } else if (chosen) {
    lines.push(
      `Chosen: NONE meets precision floor ${floor}. ` +
      `Best precision=${fmtPct(chosen.bestPrecision)} at τ=${fmtNum(chosen.bestPrecisionTau)} ` +
      `margin=${fmtNum(chosen.bestPrecisionMargin)} (recall=${fmtPct(chosen.bestPrecisionRecall)}).`,
    );
  }
  lines.push('');

  // Confusion matrix (rows = expected, cols = predicted; "·" = abstain/null).
  if (confusion) {
    lines.push('Confusion (rows = expected, cols = predicted; "·" = abstain/null):');
    const axis = [...(confusion.lanes ?? []), NULL_KEY];
    const cell = (s) => String(s).padStart(9);
    lines.push('  expected \\ pred ' + axis.map((a) => cell(a === NULL_KEY ? '·' : a)).join(''));
    for (const e of axis) {
      const label = (e === NULL_KEY ? '·' : e).padEnd(15);
      const row = axis.map((p) => cell(confusion.matrix?.[e]?.[p] ?? 0)).join('');
      lines.push('  ' + label + row);
    }
    lines.push('');
  }

  // Top-centroid cosine by outcome (at the chosen cell).
  if (scores) {
    lines.push('Top-centroid cosine by outcome (at the chosen cell):');
    const fmtS = (s) => s.count === 0
      ? 'count=0 (no data)'
      : `count=${s.count} min=${fmtPct(s.min)} p25=${fmtPct(s.p25)} median=${fmtPct(s.median)} p75=${fmtPct(s.p75)} max=${fmtPct(s.max)} mean=${fmtPct(s.mean)}`;
    if (scores.correct) lines.push(`  correct:    ${fmtS(scores.correct)}`);
    if (scores.misroute) lines.push(`  misroute:   ${fmtS(scores.misroute)}`);
    if (scores.missed) lines.push(`  missed:     ${fmtS(scores.missed)}`);
    if (scores.abstain_ok) lines.push(`  abstain_ok: ${fmtS(scores.abstain_ok)}`);
    lines.push(
      '  NOTE: τ_lane should sit ABOVE the null-expected groups (misroute/abstain_ok) ' +
      'and at/below the correct group to route true lane facts while abstaining on the rest.',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fixture loader (I/O, no live calls) — JSON-Lines, one object per line.
// ---------------------------------------------------------------------------

/**
 * Read a JSON-Lines fixture: utf8, split on /\r?\n/, drop blank lines, parse each
 * remaining line. Throws WITH the 1-based line number on a malformed line.
 */
export async function loadFixtureJsonl(path) {
  const raw = await readFile(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`loadFixtureJsonl: malformed JSON on line ${i + 1} of ${path}: ${err.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sweep ranges.
// ---------------------------------------------------------------------------

function buildRange(min, max, step) {
  const out = [];
  for (let t = min; t <= max + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

/** τ sweep: 0.30..0.80 step 0.02 (26 values), each rounded to 2 decimals. */
export function defaultTaus() {
  return buildRange(0.30, 0.80, 0.02);
}

/** Margin (top1−top2) sweep: 0 (baseline) .. 0.10. A precision lever per spec §3.5. */
export function defaultMargins() {
  return [0, 0.02, 0.04, 0.06, 0.08, 0.10];
}

// ---------------------------------------------------------------------------
// CLI shim — only runs when invoked directly. Live deps lazy-imported inside
// runOnce so importing this module from a unit test stays offline. Windows-
// correct IS_MAIN guard via fileURLToPath.
// ---------------------------------------------------------------------------

function md5Hex(s) {
  return createHash('md5').update(s).digest('hex');
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--out-prefix') args.outPrefix = argv[++i];
    else if (a === '--taxonomy') args.taxonomy = argv[++i];
  }
  return args;
}

/**
 * Embed the fixture + taxonomy ONCE, build centroids via the same embed model,
 * then sweep the τ×margin grid using the REAL classifyByCentroid. Live deps are
 * lazy-imported here. Returns the canonical result JSON.
 *
 * @param {{rows:Array, fixturePath:string, taxonomyPath?:string}} args
 */
async function runOnce({ rows, fixturePath, taxonomyPath }) {
  const { embed } = await import('../lib/embed.mjs');
  const { NOOP_METRICS } = await import('../lib/metrics.mjs');
  const { loadLaneTaxonomy, buildCentroids, classifyByCentroid } = await import('../lib/lane-classifier.mjs');
  const { cosineStrict } = await import('../lib/vector.mjs');

  const taxonomy = loadLaneTaxonomy(taxonomyPath ? { UM_LANE_TAXONOMY_PATH: taxonomyPath } : process.env);
  if (taxonomy.length === 0) {
    throw new Error('lane-eval: taxonomy resolved empty — set UM_LANE_TAXONOMY_PATH or check the default taxonomy file');
  }
  const lanes = taxonomy.map((t) => t.slug);

  const cost = { tokensIn: 0, tokensOut: 0 };
  async function embedText(text) {
    const r = await embed(text, { metrics: NOOP_METRICS });
    cost.tokensIn += r.tokensIn ?? 0;
    cost.tokensOut += r.tokensOut ?? 0;
    return r.vector;
  }

  // Centroids via the SAME embed model the facts use (same vector space).
  const centroids = await buildCentroids(taxonomy, async (t) => ({ vector: await embedText(t) }));

  // Embed each fixture row ONCE (cache by text).
  const vecCache = new Map();
  for (const row of rows) {
    if (!vecCache.has(row.text)) vecCache.set(row.text, await embedText(row.text));
  }
  const vecOf = (row) => vecCache.get(row.text);

  // The decision is the REAL classifier — no re-implementation, no drift.
  const classify = (row, opts) => classifyByCentroid(vecOf(row), centroids, opts).lane;

  const taus = defaultTaus();
  const margins = defaultMargins();
  const grid = sweepGrid({ rows, taus, margins, classify });
  const chosen = pickThreshold(grid, { precisionFloor: PRECISION_FLOOR });

  // Diagnostics at the chosen cell (or the best-precision cell when the floor is unmet).
  const cell = chosen.meetsFloor
    ? { threshold: chosen.tau, margin: chosen.margin }
    : { threshold: chosen.bestPrecisionTau ?? 0.5, margin: chosen.bestPrecisionMargin ?? 0 };

  const predictionsAtCell = rows.map((row) => ({
    predicted: classify(row, cell),
    expected: row.expected_lane,
    category: row.category,
  }));
  const confusion = buildConfusion(predictionsAtCell, lanes);

  const scoredRows = rows.map((row) => {
    const vec = vecOf(row);
    // cosineStrict (FAIL-LOUD): a dimension mismatch here is a bug, not a 0.
    const scored = centroids
      .map((c) => ({ slug: c.slug, score: cosineStrict(vec, c.centroid) }))
      .sort((a, b) => b.score - a.score);
    const predicted = classify(row, cell);
    const expected = row.expected_lane;
    let outcome;
    if (predicted != null && predicted === expected) outcome = 'correct';
    else if (predicted != null) outcome = 'misroute';
    else if (expected != null) outcome = 'missed';
    else outcome = 'abstain_ok';
    return {
      text: row.text,
      expected, predicted,
      top1: scored[0]?.score ?? null,
      top2: scored[1]?.score ?? null,
      outcome,
    };
  });
  const scores = analyzeScores(scoredRows);

  return await buildResultJson({ rows, fixturePath, taus, margins, grid, chosen, confusion, scores, scoredRows, lanes, cost });
}

/** Assemble the canonical result JSON (mirrors D1/D3 buildResultJson shape). */
async function buildResultJson({ rows, fixturePath, taus, margins, grid, chosen, confusion, scores, scoredRows, lanes, cost }) {
  const provider = process.env.UM_EMBEDDING_PROVIDER ?? process.env.UM_PROVIDER ?? 'openai';
  const model = process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small (provider default)';

  const byCategory = {};
  const byExpectedLane = {};
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    const lane = r.expected_lane == null ? NULL_KEY : r.expected_lane;
    byExpectedLane[lane] = (byExpectedLane[lane] ?? 0) + 1;
  }

  const fixtureRev = md5Hex(await readFile(fixturePath, 'utf8'));

  return {
    timestamp: new Date().toISOString(),
    provider,
    model,
    fixtureRev,
    fixtureCounts: { byCategory, byExpectedLane, total: rows.length },
    env: { node: process.version, platform: process.platform },
    taus,
    margins,
    precisionFloor: PRECISION_FLOOR,
    grid,
    chosen,
    confusion,
    scores,
    scoredRows,
    lanes,
    cost,
  };
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.fixture) {
    console.error('Usage: lane-eval.mjs --fixture <path> [--out <path> | --out-prefix <path>] [--taxonomy <path>]');
    process.exit(2);
  }
  if (!existsSync(args.fixture)) {
    console.error(`[lane-eval] Fixture not found: ${args.fixture}`);
    process.exit(2);
  }

  const rows = await loadFixtureJsonl(args.fixture);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error('[lane-eval] Fixture must be a non-empty JSON-Lines file of labelled rows');
    process.exit(2);
  }

  // Preflight: the default embedder is OpenAI → needs OPENAI_API_KEY. Try ./.env
  // (Node ≥20.12) since the project keeps keys in server/.env with no dotenv dep.
  if (!process.env.OPENAI_API_KEY) {
    try { process.loadEnvFile?.(); } catch { /* no ./.env — fall through */ }
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      '[lane-eval] OPENAI_API_KEY not set — the eval embeds the fixture + taxonomy via the live embedder.\n' +
      `  run: node --env-file=.env eval/lane-eval.mjs --fixture ${args.fixture}`,
    );
    process.exit(2);
  }

  console.log(`[lane-eval] Embedding ${rows.length} rows + taxonomy, building centroids, sweeping τ×margin...`);
  const result = await runOnce({ rows, fixturePath: args.fixture, taxonomyPath: args.taxonomy });

  const resultsDir = args.outPrefix ? dirname(args.outPrefix) : args.out ? dirname(args.out) : 'eval/results';
  const primaryPath = args.out ?? `${args.outPrefix ?? join(resultsDir, 'lane-eval')}-run1.json`;
  const latestPath = join(resultsDir, 'lane-latest.json');

  await writeJson(primaryPath, result);
  await writeJson(latestPath, result);
  console.log(`[lane-eval] Result written to ${primaryPath} and ${latestPath}`);
  console.log('');
  console.log(formatSummaryTable(result));
  console.log('');
  if (result.chosen.meetsFloor) {
    console.log(`[lane-eval] Recommended τ_lane = ${result.chosen.tau} (margin ${result.chosen.margin}); precision=${fmtPct(result.chosen.precision)} recall=${fmtPct(result.chosen.recall)} floor=${result.precisionFloor}`);
  } else {
    console.log(`[lane-eval] Recommended τ_lane = NONE — no (τ,margin) cell reaches precision floor ${result.precisionFloor} (best=${fmtPct(result.chosen.bestPrecision)} at τ=${fmtNum(result.chosen.bestPrecisionTau)}).`);
    console.log('[lane-eval] GATE: do NOT flip the classifier. Escalate to the deferred LlmClassifier (spec §2 / §3.3), or curate more separable exemplars and re-run.');
  }
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  cliMain().catch((e) => {
    console.error('[lane-eval] FATAL:', e);
    process.exit(1);
  });
}
