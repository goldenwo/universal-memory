/**
 * server/eval/dedup-threshold-sweep.mjs — D1 threshold-tuning sweep harness.
 *
 * Spec: docs/plans/2026-05-09-d1-threshold-eval-spec.md (gitignored)
 * Plan: docs/plans/2026-05-09-d1-threshold-eval-plan.md (gitignored)
 *
 * Lives at server/eval/ (NOT server/test/) so the npm-test glob does not
 * invoke this file. The companion smoke test lives at
 * server/test/eval-dedup-threshold-sweep.test.mjs (prefix-style filename).
 *
 * Module exports (per plan C.1):
 *   - sweepThresholds({ pairs, embedder, thresholds }): per-pair cosine
 *     scores + per-threshold metric records. Pure: no I/O.
 *   - pickElbow(perThreshold): CI-overlap band detection + plateau handling
 *     + highest-τ tie-breaker. Accepts raw `{ tau, fHalf, fHalfCi }` records
 *     so it is unit-testable without an embedder.
 *   - cosine(a, b): full formula (provider-agnostic; idempotent on L2-norm
 *     inputs). Defensive normalization per spec R4.
 *   - wilsonCi(k, n, z=1.96): standard Wilson 95% CI for binomial proportion.
 *   - bootstrapCi(pairScoresPerTier, perTau, iterations=1000): bootstrap
 *     95% CI on F_0.5 by resampling pairs.
 *   - formatSummaryTable(result): pretty-prints to stdout for human review.
 *   - synthesizeRepeatabilityResult(run1, run2): pairs runs by (aHash,bHash)
 *     cosine, fills repeatability.maxPairCosineDelta, and picks the more
 *     conservative τ across the two runs if delta > 0.005 (spec R7).
 *
 * CLI shim default mode is REPEAT (two runs with --gap-seconds gap, default
 * 600s) — operational reviewer N7. Use --no-repeat for single-shot dev runs.
 *
 * F_0.5 = (1 + β²) × P × R / (β² × P + R) with β=0.5 → 1.25 × P × R / (0.25 × P + R).
 * P = unrelated_precision, R = paraphrase_recall. Precision-weighted because
 * false-merge is destructive and irreversible (spec §4.4 / DP2).
 */

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cosineStrict } from '../lib/vector.mjs';

const F_BETA = 0.5;
const F_BETA_SQ = F_BETA * F_BETA;          // 0.25
const F_PREFIX = 1 + F_BETA_SQ;              // 1.25
const REPEAT_DELTA_THRESHOLD = 0.005;        // spec R7
const PLATEAU_BAND_MIN = 6;                  // > 5 → plateau (spec §4.5 step 5)

// ---------------------------------------------------------------------------
// Vector arithmetic — shared with the production classifier + lane-eval via
// lib/vector.mjs (rule of three). This harness wants the FAIL-LOUD contract (a
// malformed fixture vector is a bug, not a silent 0), so it re-exports
// cosineStrict under the long-standing `cosine` name its tests + d3-eval import.
// ---------------------------------------------------------------------------

export const cosine = cosineStrict; // local binding (used internally) + public re-export

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Wilson 95% CI for a binomial proportion (k successes in n trials).
 * Returns [lo, hi]. z=1.96 for 95% confidence.
 *
 * For n=0 returns [0, 1] (no information).
 */
export function wilsonCi(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * Bootstrap 95% CI on F_0.5 by resampling pair-level results.
 * `pairResults` is an array of { label, merged } per pair at the given τ.
 * Each iteration draws n samples with replacement, recomputes
 * paraphrase_recall + unrelated_precision + F_0.5, then takes the
 * [2.5%, 97.5%] percentiles across iterations.
 *
 * Returns [lo, hi]. Uses Math.random — non-seedable for the v1.1 budget;
 * if reproducibility-of-CI itself becomes important, swap to a seeded PRNG.
 */
export function bootstrapCi(pairResults, iterations = 1000) {
  if (pairResults.length === 0) return [0, 0];
  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let pTotal = 0, pMerged = 0, uTotal = 0, uMerged = 0;
    for (let j = 0; j < pairResults.length; j++) {
      const pick = pairResults[Math.floor(Math.random() * pairResults.length)];
      if (pick.label === 'paraphrase') {
        pTotal++;
        if (pick.merged) pMerged++;
      } else if (pick.label === 'unrelated') {
        uTotal++;
        if (pick.merged) uMerged++;
      }
    }
    const recall = pTotal > 0 ? pMerged / pTotal : 0;
    const precision = uTotal > 0 ? 1 - uMerged / uTotal : 1;
    samples[i] = fHalfFrom(precision, recall);
  }
  samples.sort((a, b) => a - b);
  const loIdx = Math.floor(iterations * 0.025);
  const hiIdx = Math.floor(iterations * 0.975);
  return [samples[loIdx], samples[hiIdx]];
}

function fHalfFrom(precision, recall) {
  const denom = F_BETA_SQ * precision + recall;
  if (denom === 0) return 0;
  return (F_PREFIX * precision * recall) / denom;
}

function expectedCostFrom(unrelatedMerged, paraphraseUnmerged) {
  // 5:1 cost ratio per spec §4.4 (false-merge irreversible vs missed-merge benign).
  return 5 * unrelatedMerged + 1 * paraphraseUnmerged;
}

function f1From(precision, recall) {
  const denom = precision + recall;
  if (denom === 0) return 0;
  return (2 * precision * recall) / denom;
}

// ---------------------------------------------------------------------------
// Sweep core
// ---------------------------------------------------------------------------

function md5Hex(s) {
  return createHash('md5').update(s).digest('hex');
}

/**
 * Per spec §4.4 + §6.4 schema. Pure async — no I/O.
 *
 * @param {object} args
 * @param {Array<{a, b, label, source, projectContext}>} args.pairs
 * @param {(text: string) => Promise<{vector: number[]}>} args.embedder
 * @param {number[]} args.thresholds  — sweep range, e.g. 0.80..1.00 step 0.01
 * @returns {Promise<{
 *   pairScores: Array,
 *   perThreshold: Array,
 *   fixtureCounts: object,
 *   fixtureNoisyRealCount: number,
 *   maxCosinePerTier: object,
 *   hashCollisionRate: number,
 * }>}
 */
export async function sweepThresholds({ pairs, embedder, thresholds }) {
  // 1. Embed every text (deduped) and compute per-pair cosine.
  const textCache = new Map();
  async function embedOnce(text) {
    if (textCache.has(text)) return textCache.get(text);
    const { vector } = await embedder(text);
    textCache.set(text, vector);
    return vector;
  }

  const pairScores = [];
  for (const pair of pairs) {
    const vA = await embedOnce(pair.a);
    const vB = await embedOnce(pair.b);
    pairScores.push({
      aHash: md5Hex(pair.a),
      bHash: md5Hex(pair.b),
      label: pair.label,
      source: pair.source,
      projectContext: pair.projectContext,
      cosine: cosine(vA, vB),
    });
  }

  // 2. Fixture stats.
  const fixtureCounts = pairScores.reduce(
    (acc, p) => {
      acc[p.label]++;
      acc.total++;
      return acc;
    },
    { identical: 0, paraphrase: 0, unrelated: 0, total: 0 },
  );
  const fixtureNoisyRealCount = pairs.filter((p) => p.source === 'noisy_real').length;

  const maxCosinePerTier = pairScores.reduce(
    (acc, p) => {
      if (p.cosine > acc[p.label]) acc[p.label] = p.cosine;
      return acc;
    },
    { identical: -Infinity, paraphrase: -Infinity, unrelated: -Infinity },
  );
  for (const k of Object.keys(maxCosinePerTier)) {
    if (maxCosinePerTier[k] === -Infinity) maxCosinePerTier[k] = null;
  }

  const hashCollisionPairs = pairs.filter((p) => p.label === 'identical' && p.a === p.b).length;
  const hashCollisionRate = fixtureCounts.identical > 0
    ? hashCollisionPairs / fixtureCounts.identical
    : 0;

  // 3. Per-threshold metrics + Wilson CI + bootstrap CI on F_0.5.
  const perThreshold = thresholds.map((tau) => {
    let idMerged = 0, paMerged = 0, unMerged = 0;
    const tauPairResults = [];
    for (const ps of pairScores) {
      const merged = ps.cosine >= tau;
      tauPairResults.push({ label: ps.label, merged });
      if (ps.label === 'identical' && merged) idMerged++;
      if (ps.label === 'paraphrase' && merged) paMerged++;
      if (ps.label === 'unrelated' && merged) unMerged++;
    }
    const paraphraseRecall = fixtureCounts.paraphrase > 0
      ? paMerged / fixtureCounts.paraphrase
      : 0;
    const unrelatedPrecision = fixtureCounts.unrelated > 0
      ? 1 - unMerged / fixtureCounts.unrelated
      : 1;
    const identicalRecall = fixtureCounts.identical > 0
      ? idMerged / fixtureCounts.identical
      : 1;

    const fHalf = fHalfFrom(unrelatedPrecision, paraphraseRecall);
    const combined = paraphraseRecall * unrelatedPrecision;
    const paraphraseF1 = f1From(unrelatedPrecision, paraphraseRecall);
    const expectedCost = expectedCostFrom(unMerged, fixtureCounts.paraphrase - paMerged);

    const paraphraseRecallCi = wilsonCi(paMerged, fixtureCounts.paraphrase);
    const unrelatedPrecisionCi = wilsonCi(
      fixtureCounts.unrelated - unMerged,
      fixtureCounts.unrelated,
    );
    const fHalfCi = bootstrapCi(tauPairResults);

    return {
      tau,
      paraphraseRecall, paraphraseRecallCi,
      unrelatedPrecision, unrelatedPrecisionCi,
      identicalRecall,
      fHalf, fHalfCi,
      combined,
      paraphraseF1,
      expectedCost,
    };
  });

  return {
    pairScores,
    perThreshold,
    fixtureCounts,
    fixtureNoisyRealCount,
    maxCosinePerTier,
    hashCollisionRate,
  };
}

// ---------------------------------------------------------------------------
// Elbow selection
// ---------------------------------------------------------------------------

/**
 * pickElbow per spec §4.5:
 *   1. Find τ_max with highest fHalf point estimate.
 *   2. Band = all τ whose fHalfCi intersects the CI of τ_max.
 *   3. If band length ≥ PLATEAU_BAND_MIN (>5) → plateau, return midpoint
 *      via floor(length/2). Otherwise return highest τ in band (DP3).
 *   4. runnerUpTau = second-highest τ in band; delta = elbow.fHalf - runnerUp.fHalf.
 *
 * Accepts raw `perThreshold` records of shape `{ tau, fHalf, fHalfCi: [lo, hi] }`
 * for unit-testability. Plus other fields are passed through unread.
 */
export function pickElbow(perThreshold) {
  if (!Array.isArray(perThreshold) || perThreshold.length === 0) {
    throw new Error('pickElbow: perThreshold must be a non-empty array');
  }
  // Sort ascending by τ to make band/runnerUp logic deterministic.
  const sorted = [...perThreshold].sort((a, b) => a.tau - b.tau);

  // Find max-fHalf row.
  let maxIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].fHalf > sorted[maxIdx].fHalf) maxIdx = i;
  }
  const maxRow = sorted[maxIdx];
  const [maxLo, maxHi] = maxRow.fHalfCi;

  // Collect band — every τ whose CI overlaps [maxLo, maxHi].
  const band = sorted.filter((row) => {
    const [lo, hi] = row.fHalfCi;
    return !(hi < maxLo || lo > maxHi);
  });
  const bandTaus = band.map((r) => r.tau);
  const plateau = band.length >= PLATEAU_BAND_MIN;

  let chosen;
  if (plateau) {
    chosen = band[Math.floor(band.length / 2)];
  } else {
    // Highest-τ tie-breaker (DP3).
    chosen = band[band.length - 1];
  }

  // runnerUp = second-highest τ in band (or the chosen-1 in the plateau case).
  let runnerUp = null;
  if (band.length > 1) {
    const idx = band.indexOf(chosen);
    runnerUp = idx > 0 ? band[idx - 1] : band[idx + 1];
  }

  return {
    tau: chosen.tau,
    fHalf: chosen.fHalf,
    fHalfCi: chosen.fHalfCi,
    runnerUpTau: runnerUp?.tau ?? null,
    delta: runnerUp ? chosen.fHalf - runnerUp.fHalf : null,
    bandTaus,
    plateau,
  };
}

// ---------------------------------------------------------------------------
// Pretty-print
// ---------------------------------------------------------------------------

export function formatSummaryTable(result) {
  // Accept either the canonical schema (result.sweep) or the raw sweepThresholds
  // output (result.perThreshold) for caller convenience.
  const perThreshold = result.sweep ?? result.perThreshold;
  const { fixtureCounts, maxCosinePerTier, hashCollisionRate } = result;
  const lines = [];
  lines.push('=== D1 Threshold Sweep Summary ===');
  lines.push(`Fixture: id=${fixtureCounts.identical} pa=${fixtureCounts.paraphrase} un=${fixtureCounts.unrelated} (total ${fixtureCounts.total})`);
  lines.push(`Hash collision rate (identical tier): ${(hashCollisionRate * 100).toFixed(1)}%`);
  lines.push(`Max cosine per tier: id=${maxCosinePerTier.identical?.toFixed(3) ?? 'n/a'} pa=${maxCosinePerTier.paraphrase?.toFixed(3) ?? 'n/a'} un=${maxCosinePerTier.unrelated?.toFixed(3) ?? 'n/a'}`);
  lines.push('');
  lines.push('  τ      P_recall    U_precision   id_recall   F_0.5  (CI)             combined  exp_cost');
  for (const row of perThreshold) {
    const ci = `[${row.fHalfCi[0].toFixed(2)},${row.fHalfCi[1].toFixed(2)}]`;
    lines.push(
      `  ${row.tau.toFixed(2)}    ${row.paraphraseRecall.toFixed(2)}        ` +
      `${row.unrelatedPrecision.toFixed(2)}          ${row.identicalRecall.toFixed(2)}        ` +
      `${row.fHalf.toFixed(2)}   ${ci}   ${row.combined.toFixed(2)}      ${row.expectedCost}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Repeatability synthesis (spec R7)
// ---------------------------------------------------------------------------

/**
 * Diff two run JSONs by `pairScores[].cosine` keyed on (aHash, bHash).
 * Returns the canonical latest.json shape with repeatability filled in.
 * If maxPairCosineDelta > REPEAT_DELTA_THRESHOLD, returns the more
 * conservative (higher τ) elbow across the two runs.
 */
export function synthesizeRepeatabilityResult(run1, run2) {
  const map2 = new Map(run2.pairScores.map((p) => [`${p.aHash}|${p.bHash}`, p.cosine]));
  let maxDelta = 0;
  for (const p of run1.pairScores) {
    const c2 = map2.get(`${p.aHash}|${p.bHash}`);
    if (c2 == null) continue;
    const d = Math.abs(p.cosine - c2);
    if (d > maxDelta) maxDelta = d;
  }
  const moreConservative = run2.elbow?.tau > run1.elbow?.tau ? run2 : run1;
  const canonical = (maxDelta > REPEAT_DELTA_THRESHOLD) ? moreConservative : run1;
  return {
    ...canonical,
    repeatability: {
      secondRun: run2.timestamp,
      maxPairCosineDelta: maxDelta,
      conservativeFallbackApplied: maxDelta > REPEAT_DELTA_THRESHOLD,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI shim — Windows-correct IS_MAIN guard via fileURLToPath.
// Default mode is REPEAT (per plan C.1 + spec R7).
// ---------------------------------------------------------------------------

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const args = { repeat: true, gapSeconds: 600 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--out-prefix') args.outPrefix = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--gap-seconds') args.gapSeconds = parseInt(argv[++i], 10);
    else if (a === '--no-repeat') args.repeat = false;
  }
  return args;
}

function defaultThresholds() {
  // [0.80, 0.81, ..., 1.00] = 21 thresholds per spec §4.3.
  const out = [];
  for (let t = 0.80; t <= 1.00 + 1e-9; t += 0.01) {
    out.push(Math.round(t * 100) / 100);
  }
  return out;
}

async function loadFixture(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function buildResultJson({ fixture, fixturePath, sweep, providerName, modelName, costAccumulator }) {
  const elbow = pickElbow(sweep.perThreshold);
  const fixtureRev = md5Hex(await readFile(fixturePath, 'utf8'));
  let openaiSdkVersion = null;
  try {
    const pkgPath = new URL('../node_modules/openai/package.json', import.meta.url);
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    openaiSdkVersion = pkg.version;
  } catch {
    // Optional metadata; harmless if missing (e.g., test env).
  }

  return {
    timestamp: new Date().toISOString(),
    provider: providerName,
    model: modelName,
    fixtureRev,
    fixtureCounts: sweep.fixtureCounts,
    fixtureNoisyRealCount: sweep.fixtureNoisyRealCount,
    env: { node: process.version, platform: process.platform, openaiSdkVersion },
    sweep: sweep.perThreshold,
    elbow,
    maxCosinePerTier: sweep.maxCosinePerTier,
    hashCollisionRate: sweep.hashCollisionRate,
    pairScores: sweep.pairScores,
    cost: costAccumulator,
    repeatability: null,
  };
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function runOnce({ fixture, fixturePath }) {
  // Lazy-import production embedder so `import` of this module from tests
  // (with mocked embedder) does not pull mem0/openai/etc. into test scope.
  const { embed } = await import('../lib/embed.mjs');
  const { NOOP_METRICS } = await import('../lib/metrics.mjs');

  const providerName = process.env.UM_EMBEDDING_PROVIDER ?? 'openai';
  const modelName = process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small';

  const cost = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const embedder = async (text) => {
    const r = await embed(text, { metrics: NOOP_METRICS });
    cost.tokensIn += r.tokensIn ?? 0;
    cost.tokensOut += r.tokensOut ?? 0;
    cost.costUsd += r.costUsd ?? 0;
    return { vector: r.vector };
  };

  const sweep = await sweepThresholds({
    pairs: fixture,
    embedder,
    thresholds: defaultThresholds(),
  });
  const result = await buildResultJson({
    fixture,
    fixturePath,
    sweep,
    providerName,
    modelName,
    costAccumulator: cost,
  });
  return result;
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.fixture) {
    console.error('Usage: dedup-threshold-sweep.mjs --fixture <path> --out-prefix <path> [--gap-seconds N] [--no-repeat]');
    process.exit(2);
  }
  if (!existsSync(args.fixture)) {
    console.error(`Fixture not found: ${args.fixture}`);
    process.exit(2);
  }
  const fixture = await loadFixture(args.fixture);
  if (!Array.isArray(fixture) || fixture.length === 0) {
    console.error('Fixture must be a non-empty JSON array of pair records');
    process.exit(2);
  }

  // latestPath lives next to the dated output (whichever of --out / --out-prefix
  // the caller used). Avoids assuming CWD is the project root.
  const resultsDir = args.outPrefix
    ? dirname(args.outPrefix)
    : args.out
    ? dirname(args.out)
    : 'eval/results';
  const latestPath = join(resultsDir, 'latest.json');

  console.log(`[sweep] Run 1 starting (${fixture.length} pairs, ${defaultThresholds().length} thresholds)...`);
  const run1 = await runOnce({ fixture, fixturePath: args.fixture });
  if (args.outPrefix) {
    await writeJson(`${args.outPrefix}-run1.json`, run1);
    console.log(`[sweep] Run 1 written to ${args.outPrefix}-run1.json`);
  } else if (args.out) {
    await writeJson(args.out, run1);
  }

  let canonical = { ...run1, repeatability: null };

  if (args.repeat) {
    console.log(`[sweep] Sleeping ${args.gapSeconds}s before run 2 (R7 repeatability check)...`);
    await new Promise((res) => setTimeout(res, args.gapSeconds * 1000));
    console.log('[sweep] Run 2 starting...');
    const run2 = await runOnce({ fixture, fixturePath: args.fixture });
    if (args.outPrefix) {
      await writeJson(`${args.outPrefix}-run2.json`, run2);
      console.log(`[sweep] Run 2 written to ${args.outPrefix}-run2.json`);
    }
    canonical = synthesizeRepeatabilityResult(run1, run2);
    if (canonical.repeatability.maxPairCosineDelta > REPEAT_DELTA_THRESHOLD) {
      console.warn(
        `[sweep] WARN: max per-pair cosine delta = ${canonical.repeatability.maxPairCosineDelta.toFixed(4)} > ${REPEAT_DELTA_THRESHOLD}; ` +
        'picked the more conservative (higher-τ) elbow per spec R7.',
      );
    }
  }

  await writeJson(latestPath, canonical);
  console.log(`[sweep] Canonical result written to ${latestPath}`);
  console.log('');
  console.log(formatSummaryTable(canonical));
  console.log('');
  console.log(`[sweep] Recommended τ = ${canonical.elbow.tau} (F_0.5 = ${canonical.elbow.fHalf.toFixed(3)}, plateau = ${canonical.elbow.plateau})`);
}

if (IS_MAIN) {
  cliMain().catch((err) => {
    console.error('[sweep] FATAL:', err);
    process.exit(1);
  });
}
