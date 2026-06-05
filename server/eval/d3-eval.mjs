/**
 * server/eval/d3-eval.mjs — D3.3 labelled-contradiction threshold-eval harness.
 *
 * Sibling of eval/dedup-threshold-sweep.mjs (D1). Same structural contract:
 * pure exported functions (no I/O, unit-tested directly) + a CLI shim guarded
 * by `IS_MAIN` whose live dependencies (judgeContradiction / embed / cosine)
 * are LAZY-imported inside runOnce — so importing this module from a unit test
 * never pulls the LLM/embed SDK into test scope.
 *
 * Purpose: run the shipped judge (lib/contradiction-judge.mjs) over the
 * labelled fixture (eval/d3-contradiction-set.jsonl) and report precision /
 * recall across confidence thresholds, so a human can pin the supersession
 * threshold τ. The metric is computed ONLY over *comparable* pairs — pairs
 * that share a non-absent lane OR a non-absent persona (the R1-B1 eligibility
 * gate). Cross-lane / cross-persona rows are NON-comparable: they sit in the
 * fixture to demonstrate what lane-scoping prevents and are EXCLUDED from
 * precision/recall.
 *
 * F0.5 is precision-weighted (β=0.5): a false supersession destroys recall
 * irreversibly, so we favour precision when pinning τ. The chosen-τ rule is a
 * precision-FLOOR (default 0.98): pick the LOWEST τ whose precision clears the
 * floor (which also maximizes recall, since recall is non-increasing in τ).
 *
 * NOTE (reproducibility): the shipped judge invoke now sets temperature 0 on
 * every provider (D3.3 follow-up, 2026-06-03) for deterministic supersession
 * decisions. Re-validated at temp 0 (eval/results/2026-06-03-d3-openai-temp0.json):
 * precision 1.000 AND recall 1.000 from τ=0.70 through τ≥0.85 — the recall plateau
 * WIDENED vs the original default-temp runs (where one true-contradiction confidence
 * dipped to 0.80). The pinned judge τ=0.80 sits solidly in that plateau. The original
 * default-temperature sweeps are kept for the record: 2026-06-02-d3-openai-run{1,2}.
 *
 * NOTE (run provenance): run1.json and run2.json are two SEPARATE invocations
 * (distinct timestamps); d3-latest.json is a copy of the last run — this harness
 * has no REPEAT-mode synthesis (unlike D1's dedup-threshold-sweep). Re-run via:
 *   node --env-file=.env eval/d3-eval.mjs \
 *     --fixture eval/d3-contradiction-set.jsonl \
 *     --out eval/results/<date>-<provider>-runN.json
 *
 * NOTE (coverage caveats): the precision claim is conditioned on the fixture's
 * hand-authored category coverage (contradiction / temporal-noncontradiction /
 * unrelated / cross-partition). Production same-partition retrieval at the 0.45
 * cosine cutoff may surface candidate types under-represented here (near-duplicate
 * paraphrases, incremental numeric updates); grow the fixture against real
 * retrieved candidates once the flag is live behind monitoring. The persona axis
 * is illustrative only (3/56 rows) — lane carries the statistical signal.
 *
 * This file is harness + CLI ONLY. It does not, and must not, modify any
 * production code or the fixture.
 */

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fHalfFrom, f1From } from './fbeta.mjs';

const PRECISION_FLOOR = 0.98;               // chosen-τ rule (DP: false-merge is destructive)

// ---------------------------------------------------------------------------
// PURE functions (no I/O) — unit-tested directly in test/d3-eval.test.mjs.
// ---------------------------------------------------------------------------

/**
 * A pair is COMPARABLE iff it shares a non-absent lane OR a non-absent persona
 * — exactly the R1-B1 eligibility gate that drives a real supersession in
 * production. Cross-lane / cross-persona rows are non-comparable.
 *
 * @param {object} pair
 * @returns {boolean}
 */
export function isComparable(pair) {
  return Boolean(
    (pair.olderLane && pair.olderLane === pair.newerLane) ||
    (pair.olderPersona && pair.olderPersona === pair.newerPersona),
  );
}

/**
 * Confusion-matrix metrics at a single confidence threshold τ. Considers ONLY
 * rows where `comparable === true`. For each comparable row:
 *   predictedPositive = (contradicts === true && confidence >= tau)
 *   actualPositive    = (label === 'contradiction')
 *
 * precision = (tp+fp)===0 ? null : tp/(tp+fp)
 * recall    = (tp+fn)===0 ? null : tp/(tp+fn)
 *
 * @param {Array<{label, contradicts, confidence, comparable}>} judged
 * @param {number} tau
 */
export function computeMetrics(judged, tau) {
  let tp = 0, fp = 0, fn = 0, tn = 0, comparableCount = 0;
  for (const row of judged) {
    if (row.comparable !== true) continue;
    comparableCount++;
    const predictedPositive = row.contradicts === true && row.confidence >= tau;
    const actualPositive = row.label === 'contradiction';
    if (predictedPositive && actualPositive) tp++;
    else if (predictedPositive && !actualPositive) fp++;
    else if (!predictedPositive && actualPositive) fn++;
    else tn++;
  }
  const precision = (tp + fp) === 0 ? null : tp / (tp + fp);
  const recall = (tp + fn) === 0 ? null : tp / (tp + fn);
  const f1 = f1From(precision, recall);
  const fHalf = fHalfFrom(precision, recall);
  return {
    tau,
    tp, fp, fn, tn,
    comparableCount,
    predictedPositives: tp + fp,
    actualPositives: tp + fn,
    precision, recall, f1, fHalf,
  };
}

/**
 * Run computeMetrics across an array of thresholds.
 * @param {{judged: Array, thresholds: number[]}} args
 * @returns {Array} one metrics row per threshold
 */
export function sweepThresholds({ judged, thresholds }) {
  return thresholds.map((t) => computeMetrics(judged, t));
}

/**
 * Pick the supersession threshold via a precision FLOOR. Among sweep rows with
 * a non-null precision >= precisionFloor, return the one with the LOWEST τ —
 * which also maximizes recall, since recall is non-increasing in τ. If none
 * qualify, return diagnostics: the best observed precision and its τ.
 *
 * @param {Array} perThreshold  — the sweepThresholds output
 * @param {{precisionFloor: number}} opts
 */
export function pickThreshold(perThreshold, { precisionFloor }) {
  const sorted = [...perThreshold].sort((a, b) => a.tau - b.tau);
  const qualifying = sorted.filter((r) => r.precision != null && r.precision >= precisionFloor);
  if (qualifying.length > 0) {
    const chosen = qualifying[0]; // lowest τ (sorted ascending)
    return {
      meetsFloor: true,
      tau: chosen.tau,
      precision: chosen.precision,
      recall: chosen.recall,
      f1: chosen.f1,
      fHalf: chosen.fHalf,
      tp: chosen.tp,
      fp: chosen.fp,
      fn: chosen.fn,
      tn: chosen.tn,
    };
  }
  // None reached the floor — report the best observed precision + its τ.
  let bestPrecision = null;
  let bestPrecisionTau = null;
  for (const r of sorted) {
    if (r.precision == null) continue;
    if (bestPrecision == null || r.precision > bestPrecision) {
      bestPrecision = r.precision;
      bestPrecisionTau = r.tau;
    }
  }
  return { meetsFloor: false, precisionFloor, bestPrecision, bestPrecisionTau };
}

/**
 * Simple nearest-rank percentile over a SORTED ascending array.
 * rank = ceil(p · n), clamped to [1, n]; returns the (rank-1)th element.
 */
function nearestRank(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
  return sortedAsc[rank - 1];
}

/** Distribution stats for a numeric sample. Returns nulls when empty. */
function distStats(values) {
  const n = values.length;
  if (n === 0) {
    return { count: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null };
  }
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
 * Over comparable rows that carry a numeric `cosine`, split by label and report
 * the cosine distribution per group. The contradiction group's distribution
 * shows how LOW the embedding retrieval threshold must sit to retrieve true
 * targets — grounding the case for decoupling the (low) retrieval threshold
 * from the (high) judge threshold. Rows without a numeric cosine are skipped.
 *
 * @param {Array<{label, comparable, cosine}>} judged
 * @returns {{contradiction: object, not: object}}
 */
export function analyzeRetrieval(judged) {
  const groups = { contradiction: [], not: [] };
  for (const row of judged) {
    if (row.comparable !== true) continue;
    if (typeof row.cosine !== 'number' || Number.isNaN(row.cosine)) continue;
    const key = row.label === 'contradiction' ? 'contradiction' : 'not';
    groups[key].push(row.cosine);
  }
  return {
    contradiction: distStats(groups.contradiction),
    not: distStats(groups.not),
  };
}

// ---------------------------------------------------------------------------
// Pretty-print (pure) — mirrors D1's formatSummaryTable.
// ---------------------------------------------------------------------------

function fmtNum(x, digits = 2) {
  return typeof x === 'number' && !Number.isNaN(x) ? x.toFixed(digits) : 'n/a';
}

function fmtPct(x) {
  return typeof x === 'number' && !Number.isNaN(x) ? x.toFixed(3) : 'n/a';
}

/**
 * Multi-line human summary: fixture counts (by category + comparable split),
 * the τ-sweep table, the chosen-τ line (precision-floor), and the retrieval
 * cosine block. Tolerates null cells ('n/a').
 *
 * @param {object} result  — the buildResultJson output (or a compatible subset)
 */
export function formatSummaryTable(result) {
  const { fixtureCounts, sweep, chosen, retrieval, precisionFloor } = result;
  const floor = precisionFloor ?? PRECISION_FLOOR;
  const lines = [];

  lines.push('=== D3 Contradiction Threshold Eval ===');
  if (fixtureCounts) {
    const byCat = fixtureCounts.byCategory ?? {};
    const cats = Object.keys(byCat).sort();
    lines.push(`Comparable: ${fixtureCounts.comparable ?? 'n/a'}   Non-comparable: ${fixtureCounts.nonComparable ?? 'n/a'}`);
    lines.push('By category:');
    for (const c of cats) lines.push(`  ${c}: ${byCat[c]}`);
    if (fixtureCounts.byLabel) {
      const bl = fixtureCounts.byLabel;
      lines.push(`By label: contradiction=${bl.contradiction ?? 0} not=${bl.not ?? 0}`);
    }
  }
  lines.push('');
  lines.push('Metric is computed over COMPARABLE pairs only (shared lane or persona; R1-B1 gate).');
  lines.push('');

  // τ-sweep table.
  lines.push('  τ     | TP | FP | FN | precision | recall | F1   | F0.5');
  lines.push('  ------+----+----+----+-----------+--------+------+------');
  for (const row of sweep ?? []) {
    lines.push(
      `  ${fmtNum(row.tau)}  | ` +
      `${String(row.tp).padStart(2)} | ${String(row.fp).padStart(2)} | ${String(row.fn).padStart(2)} | ` +
      `${fmtPct(row.precision).padStart(9)} | ${fmtPct(row.recall).padStart(6)} | ` +
      `${fmtNum(row.f1).padStart(4)} | ${fmtNum(row.fHalf).padStart(4)}`,
    );
  }
  lines.push('');

  // Chosen-τ line.
  if (chosen?.meetsFloor) {
    lines.push(
      `Chosen τ (precision floor ${floor}): τ=${fmtNum(chosen.tau)}  ` +
      `precision=${fmtPct(chosen.precision)}  recall=${fmtPct(chosen.recall)}  ` +
      `F1=${fmtNum(chosen.f1)}  F0.5=${fmtNum(chosen.fHalf)}`,
    );
  } else if (chosen) {
    lines.push(
      `Chosen τ: NONE meets precision floor ${floor}. ` +
      `Best observed precision=${fmtPct(chosen.bestPrecision)} at τ=${fmtNum(chosen.bestPrecisionTau)}.`,
    );
  }
  lines.push('');

  // Retrieval cosine block.
  if (retrieval) {
    lines.push('Retrieval cosine (comparable pairs):');
    const fmtStats = (s) =>
      s.count === 0
        ? 'count=0 (no data)'
        : `count=${s.count} min=${fmtPct(s.min)} p25=${fmtPct(s.p25)} median=${fmtPct(s.median)} ` +
          `p75=${fmtPct(s.p75)} max=${fmtPct(s.max)} mean=${fmtPct(s.mean)}`;
    lines.push(`  contradiction: ${fmtStats(retrieval.contradiction)}`);
    lines.push(`  not:           ${fmtStats(retrieval.not)}`);
    lines.push(
      '  NOTE: retrieval τ must sit at/below the contradiction-group min/p25 ' +
      'to retrieve true targets — i.e. retrieval τ should be DECOUPLED from (and ' +
      'far below) the high judge confidence τ.',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fixture loader (I/O, but no live calls) — JSON-Lines, one object per line.
// ---------------------------------------------------------------------------

/**
 * Read a JSON-Lines fixture: utf8, split on /\r?\n/, drop blank lines, parse
 * each remaining line. Throws a clear error WITH the 1-based line number on a
 * malformed line.
 *
 * @param {string} path
 * @returns {Promise<Array<object>>}
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
// CLI shim — only runs when invoked directly. Live deps are lazy-imported
// inside runOnce so importing this module from a unit test stays offline.
// Windows-correct IS_MAIN guard via fileURLToPath.
// ---------------------------------------------------------------------------

function md5Hex(s) {
  return createHash('md5').update(s).digest('hex');
}

export function parseArgs(argv) {
  const args = { doEmbed: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--out-prefix') args.outPrefix = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--no-embed') args.doEmbed = false;
    else if (a === '--thresholds-min') args.thresholdsMin = parseFloat(argv[++i]);
    else if (a === '--thresholds-max') args.thresholdsMax = parseFloat(argv[++i]);
    else if (a === '--thresholds-step') args.thresholdsStep = parseFloat(argv[++i]);
  }
  return args;
}

/** 0.70..0.99 step 0.01 → ~30 thresholds, each rounded to 2 decimals. */
export function defaultThresholds() {
  return buildThresholds(0.70, 0.99, 0.01);
}

function buildThresholds(min, max, step) {
  const out = [];
  for (let t = min; t <= max + 1e-9; t += step) {
    out.push(Math.round(t * 100) / 100);
  }
  return out;
}

/** Resolve the contradiction provider name from env (judge resolution order). */
function resolveProvider() {
  return process.env.UM_CONTRADICTION_PROVIDER ?? process.env.UM_SUMMARIZER_PROVIDER ?? 'openai';
}

/** Map a provider to its API-key env var(s). ollama needs none. */
function providerKeyVars(provider) {
  switch (provider) {
    case 'openai': return ['OPENAI_API_KEY'];
    case 'anthropic': return ['ANTHROPIC_API_KEY'];
    case 'google': return ['GOOGLE_API_KEY', 'GEMINI_API_KEY'];
    case 'ollama': return [];
    default: return [];
  }
}

/**
 * Run the judge (and optionally the embedder) over every pair ONCE, then sweep
 * thresholds + pick τ + analyze retrieval. Returns the canonical result JSON.
 * Live deps are lazy-imported here.
 *
 * @param {{pairs: Array, fixturePath: string, doEmbed: boolean, thresholds?: number[]}} args
 */
async function runOnce({ pairs, fixturePath, doEmbed, thresholds }) {
  const { judgeContradiction } = await import('../lib/contradiction-judge.mjs');

  let embed = null;
  let cosine = null;
  let NOOP_METRICS = null;
  if (doEmbed) {
    ({ embed } = await import('../lib/embed.mjs'));
    ({ NOOP_METRICS } = await import('../lib/metrics.mjs'));
    ({ cosine } = await import('./dedup-threshold-sweep.mjs'));
  }

  const cost = { tokensIn: 0, tokensOut: 0 };

  // Cache embed vectors per unique text to avoid duplicate embed calls.
  const vecCache = new Map();
  async function embedOnce(text) {
    if (vecCache.has(text)) return vecCache.get(text);
    const r = await embed(text, { metrics: NOOP_METRICS });
    vecCache.set(text, r.vector);
    cost.tokensIn += r.tokensIn ?? 0;
    cost.tokensOut += r.tokensOut ?? 0;
    return r.vector;
  }

  const judged = [];
  for (const pair of pairs) {
    const verdict = await judgeContradiction(pair.olderFact, pair.newerFact);
    cost.tokensIn += verdict.usage?.tokensIn ?? 0;
    cost.tokensOut += verdict.usage?.tokensOut ?? 0;

    const comparable = isComparable(pair);

    let cos = null;
    if (doEmbed) {
      const vA = await embedOnce(pair.olderFact);
      const vB = await embedOnce(pair.newerFact);
      cos = cosine(vA, vB);
    }

    judged.push({
      olderFact: pair.olderFact,
      newerFact: pair.newerFact,
      olderLane: pair.olderLane ?? null,
      newerLane: pair.newerLane ?? null,
      olderPersona: pair.olderPersona ?? null,
      newerPersona: pair.newerPersona ?? null,
      label: pair.label,
      category: pair.category,
      comparable,
      contradicts: verdict.contradicts,
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
      cosine: cos,
    });
  }

  const sweep = sweepThresholds({ judged, thresholds });
  const chosen = pickThreshold(sweep, { precisionFloor: PRECISION_FLOOR });
  const retrieval = doEmbed ? analyzeRetrieval(judged) : null;

  return await buildResultJson({ pairs, fixturePath, thresholds, sweep, chosen, retrieval, judged, cost });
}

/**
 * Assemble the canonical result JSON (mirrors D1's buildResultJson shape).
 */
async function buildResultJson({ pairs, fixturePath, thresholds, sweep, chosen, retrieval, judged, cost }) {
  const provider = resolveProvider();
  const model = process.env.UM_CONTRADICTION_MODEL ?? '(provider default)';

  const byCategory = {};
  const byLabel = { contradiction: 0, not: 0 };
  let comparable = 0;
  let nonComparable = 0;
  for (const p of pairs) {
    byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    if (p.label === 'contradiction') byLabel.contradiction++;
    else byLabel.not++;
    if (isComparable(p)) comparable++;
    else nonComparable++;
  }

  const fixtureRev = md5Hex(await readFile(fixturePath, 'utf8'));

  return {
    timestamp: new Date().toISOString(),
    provider,
    model,
    fixtureRev,
    fixtureCounts: { byCategory, byLabel, comparable, nonComparable },
    env: { node: process.version, platform: process.platform },
    thresholds,
    precisionFloor: PRECISION_FLOOR,
    sweep,
    chosen,
    retrieval,
    judged,
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
    console.error('Usage: d3-eval.mjs --fixture <path> [--out-prefix <path> | --out <path>] [--no-embed] [--thresholds-min N --thresholds-max N --thresholds-step N]');
    process.exit(2);
  }
  if (!existsSync(args.fixture)) {
    console.error(`[d3-eval] Fixture not found: ${args.fixture}`);
    process.exit(2);
  }

  const pairs = await loadFixtureJsonl(args.fixture);
  if (!Array.isArray(pairs) || pairs.length === 0) {
    console.error('[d3-eval] Fixture must be a non-empty JSON-Lines file of pair records');
    process.exit(2);
  }

  // Preflight provider-key check. Try process.loadEnvFile() (Node ≥20.12 loads
  // ./.env) before giving up — the project keeps keys in server/.env with no
  // dotenv dependency.
  const provider = resolveProvider();
  const keyVars = providerKeyVars(provider);
  if (keyVars.length > 0) {
    const hasKey = () => keyVars.some((v) => process.env[v]);
    if (!hasKey()) {
      try { process.loadEnvFile?.(); } catch { /* no ./.env — fall through */ }
    }
    if (!hasKey()) {
      console.error(
        `[d3-eval] Provider '${provider}' requires one of: ${keyVars.join(', ')} — none set.\n` +
        `  set ${keyVars[0]} or run: node --env-file=.env eval/d3-eval.mjs --fixture ${args.fixture}`,
      );
      process.exit(2);
    }
  }

  const thresholds = (args.thresholdsMin != null && args.thresholdsMax != null && args.thresholdsStep != null)
    ? buildThresholds(args.thresholdsMin, args.thresholdsMax, args.thresholdsStep)
    : defaultThresholds();

  console.log(`[d3-eval] Judging ${pairs.length} pairs over ${thresholds.length} thresholds (embed=${args.doEmbed}, provider=${provider})...`);
  const result = await runOnce({ pairs, fixturePath: args.fixture, doEmbed: args.doEmbed, thresholds });

  const resultsDir = args.outPrefix
    ? dirname(args.outPrefix)
    : args.out
      ? dirname(args.out)
      : 'eval/results';
  const primaryPath = args.out ?? `${args.outPrefix ?? join(resultsDir, 'd3-eval')}-run1.json`;
  // D3-specific 'latest' pointer: must NOT be 'latest.json' — that path is
  // owned by the D1 dedup sweep harness in the same results dir (collision).
  const latestPath = join(resultsDir, 'd3-latest.json');

  await writeJson(primaryPath, result);
  await writeJson(latestPath, result);
  console.log(`[d3-eval] Result written to ${primaryPath} and ${latestPath}`);
  console.log('');
  console.log(formatSummaryTable(result));
  console.log('');
  if (result.chosen.meetsFloor) {
    console.log(`[d3-eval] Recommended τ = ${result.chosen.tau} (precision=${fmtPct(result.chosen.precision)}, recall=${fmtPct(result.chosen.recall)}, floor=${result.precisionFloor})`);
  } else {
    console.log(`[d3-eval] Recommended τ = NONE — no threshold reaches precision floor ${result.precisionFloor} (best=${fmtPct(result.chosen.bestPrecision)} at τ=${fmtNum(result.chosen.bestPrecisionTau)}). Widen the fixture or revisit the judge.`);
  }
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  cliMain().catch((e) => {
    console.error('[d3-eval] FATAL:', e);
    process.exit(1);
  });
}
