/**
 * server/eval/memory-quality-eval.mjs — END-TO-END memory-quality eval harness.
 *
 * Sibling of eval/lane-eval.mjs (lane), eval/d3-eval.mjs (supersession judge), and
 * eval/dedup-threshold-sweep.mjs (dedup). SAME structural contract:
 *   - PURE exported scoring functions (no I/O) — unit-tested directly in
 *     test/memory-quality-eval.test.mjs (importing this module pulls NO live SDK
 *     into test scope).
 *   - A CLI shim guarded by IS_MAIN whose live deps (umAdd / doSearch / embed /
 *     detectContradictionsInBatch / supersedePoint / mem0 Memory + QdrantClient)
 *     are LAZY-imported inside runOnce — so a plain `import { ... }` here stays offline.
 *
 * Spec : docs/plans/2026-06-15-memory-quality-eval-spec.md  (WHAT/WHY — metrics, design)
 * Plan : docs/plans/2026-06-15-memory-quality-eval-plan.md  (HOW/WHEN — phased build)
 *
 * Unlike the component evals (which tune a single threshold), this measures whether the
 * ASSEMBLED system recalls correctly + currently. It INJECTS the real umAdd/doSearch so
 * the eval cannot drift from production (the lane/d3 faithfulness contract). This pass
 * (Tier-1 baseline): #1 recall@k + MRR, #3 stale-return (via the real session-end
 * detector path), and #6 no-answer precision if run-stable. BASELINE-FIRST — no CI gate.
 *
 * This file is harness + CLI ONLY. It does not, and must not, modify any production code.
 *
 * PHASE STATUS: Phase 1 (pure scoring core) implemented below. Phase 2 (runOnce + CLI
 * live wiring) is appended once the gated smoke (test/eval-memory-quality.smoke.test.mjs)
 * confirms the wiring against live qdrant.
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
// ranking.mjs is pure and import-free — safe at module top (no live dep is touched).
// assertDateCohorts uses the READ PATH's own predicate so the cohort guard cannot drift
// from what the ranker actually treats as dated.
import { isUsableDate } from '../lib/ranking.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bounceTopHit } from '../lib/bouncer.mjs';
import { percentile, summarize } from './lib/stats.mjs';

// ---------------------------------------------------------------------------
// PURE scoring functions (no I/O) — unit-tested directly.
// ---------------------------------------------------------------------------

/**
 * Per-query hit@k. For each k, 1 if ANY acceptable target id appears within the first
 * k ranked result ids, else 0. `rankedIds` is the result order from `doSearch` (top-1
 * first); k beyond the result count simply uses what is there.
 *
 * @param {string[]} rankedIds   result ids in rank order
 * @param {string[]} targetIds   acceptable target id(s) for this query
 * @param {number[]} ks          retrieval depths, e.g. [1,3,5,10]
 * @returns {Object<number, 0|1>}
 */
export function recallAtK(rankedIds, targetIds, ks) {
  const targets = new Set(targetIds ?? []);
  const out = {};
  for (const k of ks) {
    let hit = 0;
    const top = (rankedIds ?? []).slice(0, k);
    for (const id of top) {
      if (targets.has(id)) { hit = 1; break; }
    }
    out[k] = hit;
  }
  return out;
}

/**
 * Mean recall per k over an array of per-query recallAtK results. Empty input → null
 * per k (no data — mirrors the lane/d3 null-on-empty convention).
 *
 * @param {Array<Object<number,0|1>>} perQuery
 * @param {number[]} ks
 * @returns {Object<number, number|null>}
 */
export function aggregateRecall(perQuery, ks) {
  const out = {};
  const n = perQuery?.length ?? 0;
  for (const k of ks) {
    if (n === 0) { out[k] = null; continue; }
    let sum = 0;
    for (const q of perQuery) sum += (q[k] ?? 0);
    out[k] = sum / n;
  }
  return out;
}

/**
 * Reciprocal rank: 1/(1-based rank of the FIRST acceptable target in rankedIds), or 0
 * if no target is present.
 */
export function reciprocalRank(rankedIds, targetIds) {
  const targets = new Set(targetIds ?? []);
  const ids = rankedIds ?? [];
  for (let i = 0; i < ids.length; i++) {
    if (targets.has(ids[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Mean of a numeric sample; null when empty (shared by mrr + the rate metrics). */
function mean(values) {
  if (!values || values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Mean Reciprocal Rank over an array of per-query reciprocal ranks. Empty → null. */
export function mrr(reciprocalRanks) {
  return mean(reciprocalRanks);
}

/**
 * Binary-relevance nDCG@k. Gain is 1 for an acceptable target id, else 0; the rank
 * discount is 1/log2(rank+1) (1-based rank). IDCG@k places min(|targets|, k) relevant
 * items first, so a target at rank 1 scores 1.0 and an absent/empty/no-target query → 0.
 * Unlike recallAtK (0/1 presence), nDCG is rank-sensitive; with one acceptable target per
 * row it is a monotonic function of that target's rank — close to MRR, which is why the
 * eval-catalog spec (§7) deferred it. Kept anyway for scorecard completeness and to be
 * ready for a future graded / multi-target relevance fixture.
 *
 * @param {string[]} rankedIds   result ids in rank order (top-1 first)
 * @param {string[]} targetIds   acceptable target id(s) for this query
 * @param {number[]} ks          retrieval depths, e.g. [1,3,5,10]
 * @returns {Object<number, number>}  nDCG@k in [0,1] (0 when no target is reachable)
 */
export function ndcgAtK(rankedIds, targetIds, ks) {
  const targets = new Set(targetIds ?? []);
  const ids = rankedIds ?? [];
  const out = {};
  for (const k of ks) {
    let dcg = 0;
    const credited = new Set();  // a result list shouldn't repeat an id; if it does, credit each target once so nDCG stays ≤ 1 (mirrors recallAtK's first-match semantics)
    const top = ids.slice(0, k);
    for (let i = 0; i < top.length; i++) {
      if (targets.has(top[i]) && !credited.has(top[i])) {
        credited.add(top[i]);
        dcg += 1 / Math.log2(i + 2);  // 0-based i → 1-based rank i+1
      }
    }
    // IDCG@k: all relevant ranked first; binary gains → min(|targets|, k) leading 1s.
    let idcg = 0;
    const ideal = Math.min(targets.size, k);
    for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
    out[k] = idcg === 0 ? 0 : dcg / idcg;
  }
  return out;
}

/**
 * Stratify recall by paraphrase_level. Groups the recall pass's per-query details by
 * details[].paraphrase_level, aggregates recall@k per level (reusing aggregateRecall over
 * each group's recallByK maps), and reports the gap of each level vs the lexical anchor per
 * k, defined as (lexical − level) so a positive gap = that level recalls WORSE than lexical.
 * An absent level simply does not appear in byLevel/counts; gaps against an absent lexical
 * anchor are null per k (the lane/d3 null-on-empty convention).
 *
 * @param {Array<{paraphrase_level?: string, recallByK?: Object<number,0|1>}>} details
 * @param {number[]} ks
 * @returns {{ byLevel: Object<string,Object<number,number|null>>,
 *            counts: Object<string,number>,
 *            gaps: { paraphraseVsLexical: Object<number,number|null>,
 *                    obliqueVsLexical: Object<number,number|null> } }}
 */
export function recallByParaphraseLevel(details, ks) {
  const groups = {};
  for (const d of details ?? []) {
    const level = d.paraphrase_level ?? 'unknown';
    (groups[level] ??= []).push(d.recallByK ?? {});
  }
  const byLevel = {};
  const counts = {};
  for (const [level, maps] of Object.entries(groups)) {
    byLevel[level] = aggregateRecall(maps, ks);
    counts[level] = maps.length;
  }
  const gap = (anchor, level) => {
    const out = {};
    for (const k of ks) {
      const a = anchor?.[k];
      const b = level?.[k];
      out[k] = (typeof a === 'number' && typeof b === 'number') ? +(a - b).toFixed(3) : null;
    }
    return out;
  };
  const lex = byLevel.lexical ?? null;
  return {
    byLevel,
    counts,
    gaps: {
      paraphraseVsLexical: gap(lex, byLevel.paraphrase),
      obliqueVsLexical: gap(lex, byLevel.oblique),
    },
  };
}

/**
 * Content-contains recall@k for cross-session eval: for each query, rank = the 1-based
 * index of the first retrieved body that CONTAINS the (normalized) distinctive answer span;
 * 0 if none. Deterministic, no LLM judge — relies on session-recall-set.jsonl's verbatim
 * answer spans. Returns mean recall@k + MRR + the ids that missed. Empty → null per k / null
 * mrr (the lane/d3 null-on-empty convention).
 *
 * @param {Array<{id:string, answerNorm:string, bodies:string[]}>} perQuery
 * @param {number[]} ks
 * @returns {{ aggregate: Object<number, number|null>, mrr: number|null, misses: string[] }}
 */
export function crossSessionRecall(perQuery, ks) {
  const rows = perQuery ?? [];
  const hits = {};
  for (const k of ks) hits[k] = 0;
  const rrs = [];
  const misses = [];
  for (const q of rows) {
    let rank = 0;
    const bodies = q.bodies ?? [];
    for (let i = 0; i < bodies.length; i++) {
      if (q.answerNorm && bodies[i].includes(q.answerNorm)) { rank = i + 1; break; }
    }
    for (const k of ks) if (rank > 0 && rank <= k) hits[k]++;
    rrs.push(rank > 0 ? 1 / rank : 0);
    if (rank === 0) misses.push(q.id);
  }
  if (rows.length === 0) {
    const nullAgg = {};
    for (const k of ks) nullAgg[k] = null;
    return { aggregate: nullAgg, mrr: null, misses: [] };
  }
  const aggregate = {};
  for (const k of ks) aggregate[k] = +(hits[k] / rows.length).toFixed(3);
  const mrr = +(rrs.reduce((a, b) => a + b, 0) / rows.length).toFixed(3);
  return { aggregate, mrr, misses };
}

/**
 * Extraction fidelity: micro-averaged precision/recall of facts-extraction vs a gold set.
 * Each judged row carries COUNTS from the judge: goldTotal/goldMatched (recall — gold facts
 * present in the extracted set) and extractedTotal/extractedSupported (precision — extracted
 * facts supported by the input, i.e. not hallucinated). Parse-fail rows (ok!==true) are
 * EXCLUDED from denominators (never silently bias a rate). Noise rows (noiseRow flag or
 * goldTotal===0) are EXCLUDED from the precision/recall sums entirely (spec R2-G4:
 * empty-gold rows excluded from precision sums — metric-definition change, 40-row baseline
 * re-pinned) and tracked separately: noiseAbstained = noise rows that extracted nothing
 * (correctly produced no fact). Empty/zero-denominator → null.
 *
 * @param {Array<{id:string, ok:boolean, noiseRow?:boolean, stratum?:string,
 *                goldTotal:number, goldMatched:number,
 *                extractedTotal:number, extractedSupported:number}>} judgedRows
 * @returns {{ rows:number, graded:number, parseFails:number, precision:number|null,
 *            recall:number|null, f1:number|null, noiseAbstained:number, noiseTotal:number,
 *            perRow:Array }}
 */
export function extractionFidelity(judgedRows) {
  const rows = judgedRows ?? [];
  let sumSupported = 0, sumExtracted = 0, sumMatched = 0, sumGold = 0;
  let graded = 0, parseFails = 0, noiseTotal = 0, noiseAbstained = 0;
  const perRow = [];
  for (const r of rows) {
    if (r.ok !== true) {
      parseFails++;
      // judgeError marks an INVOKE-THREW failsafe (transient judge API error) so
      // gate evaluation can distinguish infra flakes from judge misalignment.
      perRow.push({ id: r.id, ok: false, ...(r.judgeError === true ? { judgeError: true } : {}) });
      continue;
    }
    graded++;
    if (r.noiseRow === true || (r.goldTotal ?? 0) === 0) {
      noiseTotal++;
      if ((r.extractedTotal ?? 0) === 0) noiseAbstained++;
      perRow.push({ id: r.id, ok: true, noiseRow: true, extractedTotal: r.extractedTotal ?? 0 });
      continue; // contributes ONLY to noise counters — never precision/recall sums
    }
    const goldTotal = r.goldTotal ?? 0;
    const extractedTotal = r.extractedTotal ?? 0;
    const goldMatched = r.goldMatched ?? 0;
    const extractedSupported = r.extractedSupported ?? 0;
    sumGold += goldTotal;
    sumMatched += goldMatched;
    sumExtracted += extractedTotal;
    sumSupported += extractedSupported;
    perRow.push({ id: r.id, ok: true, goldTotal, goldMatched, extractedTotal, extractedSupported });
  }
  const precision = sumExtracted === 0 ? null : +(sumSupported / sumExtracted).toFixed(3);
  const recall = sumGold === 0 ? null : +(sumMatched / sumGold).toFixed(3);
  const f1 = (precision == null || recall == null || precision + recall === 0)
    ? null
    : +((2 * precision * recall) / (precision + recall)).toFixed(3);
  return { rows: rows.length, graded, parseFails, precision, recall, f1, noiseAbstained, noiseTotal, perRow };
}

/**
 * Stratified extraction metrics: groups judged rows by their `stratum` field (fixture-carried;
 * absent → 'unknown') and reports per-stratum micro counts + rates, mirroring
 * recallByParaphraseLevel's grouping shape. Parse-fail rows are counted per stratum and
 * excluded from every rate; noise rows (noiseRow flag or empty gold) feed abstention only;
 * fact-bearing rows feed recall only. 3dp, null-on-empty (house convention).
 *
 * @param {Array<{id:string, ok:boolean, stratum?:string, noiseRow?:boolean,
 *                goldTotal?:number, goldMatched?:number, extractedTotal?:number}>} judgedRows
 * @returns {Object<string, { rows:number, parseFails:number, noiseTotal:number,
 *           noiseAbstained:number, abstentionRate:number|null,
 *           goldTotal:number, goldMatched:number, recall:number|null }>}
 */
export function extractionByStratum(judgedRows) {
  const out = {};
  for (const r of judgedRows ?? []) {
    const stratum = r.stratum ?? 'unknown';
    const s = (out[stratum] ??= {
      rows: 0, parseFails: 0, noiseTotal: 0, noiseAbstained: 0, abstentionRate: null,
      goldTotal: 0, goldMatched: 0, recall: null,
    });
    s.rows++;
    if (r.ok !== true) { s.parseFails++; continue; }
    if (r.noiseRow === true || (r.goldTotal ?? 0) === 0) {
      s.noiseTotal++;
      if ((r.extractedTotal ?? 0) === 0) s.noiseAbstained++;
      continue;
    }
    s.goldTotal += r.goldTotal ?? 0;
    s.goldMatched += r.goldMatched ?? 0;
  }
  for (const s of Object.values(out)) {
    s.abstentionRate = s.noiseTotal === 0 ? null : +(s.noiseAbstained / s.noiseTotal).toFixed(3);
    s.recall = s.goldTotal === 0 ? null : +(s.goldMatched / s.goldTotal).toFixed(3);
  }
  return out;
}

/**
 * Expected verdict for the judge-free CI guard: an explicit `expected_verdict` wins;
 * otherwise derived from the gold shape (non-empty expected_facts → 'extract', else
 * 'abstain') — the derivation lets legacy fixtures join the guard with zero edits.
 */
export function deriveExpectedVerdict(row) {
  return row?.expected_verdict ?? ((row?.expected_facts ?? []).length ? 'extract' : 'abstain');
}

/**
 * Judge-free verdict-gate aggregation over per-row {expected, observed} verdicts.
 * Rows flagged `unstable: true` are excluded from both pool denominators and counted
 * (A4b — the CI gate denominators hold only verdict-stable rows). matchRate is 3dp,
 * null-on-empty.
 *
 * @param {Array<{id:string, expected:'abstain'|'extract', observed:'abstain'|'extract',
 *                unstable?:boolean}>} rows
 * @returns {{ abstain:{total:number, matched:number, matchRate:number|null},
 *            extract:{total:number, matched:number, matchRate:number|null},
 *            excludedUnstable:number, mismatches:string[] }}
 */
export function computeVerdictGate(rows) {
  const pools = {
    abstain: { total: 0, matched: 0, matchRate: null },
    extract: { total: 0, matched: 0, matchRate: null },
  };
  let excludedUnstable = 0;
  let excludedUnknown = 0;
  const mismatches = [];
  for (const r of rows ?? []) {
    if (r.unstable === true) { excludedUnstable++; continue; }
    const pool = pools[r.expected];
    // Out-of-enum expected verdict (fixture typo): counted, never silently dropped —
    // the pool-size floors in the CI gate turn attrition into a breach.
    if (!pool) { excludedUnknown++; continue; }
    pool.total++;
    if (r.observed === r.expected) pool.matched++;
    else mismatches.push(r.id);
  }
  for (const pool of Object.values(pools)) {
    pool.matchRate = pool.total === 0 ? null : +(pool.matched / pool.total).toFixed(3);
  }
  return { ...pools, excludedUnstable, excludedUnknown, mismatches };
}

/** Fraction of true flags in a boolean array; null when empty. */
function rate(flags) {
  if (!flags || flags.length === 0) return null;
  let t = 0;
  for (const f of flags) if (f) t++;
  return t / flags.length;
}

/**
 * Stale-return rate over detector-FIRED staleness rows only: the fraction of fired
 * rows whose query still surfaces the demoted original fact. No fired rows → null
 * (unmeasurable — the detector never created a supersession to test).
 *
 * @param {Array<{surfacedOriginal:boolean}>} firedRows
 */
export function staleReturnRate(firedRows) {
  return rate((firedRows ?? []).map((r) => r.surfacedOriginal === true));
}

/**
 * No-answer precision over UNANSWERABLE queries (no relevant seed in the corpus): the
 * fraction whose top hit did NOT answer (a correct non-answer). `topHitAnswered` is the
 * LLM answer-grader's verdict on doSearch top-1. Empty → null. Parse-fail rows are
 * excluded by the caller (answerCorrectnessPass) before aggregation.
 *
 * @param {Array<{topHitAnswered:boolean}>} distractorRows
 */
export function noAnswerPrecision(distractorRows) {
  return rate((distractorRows ?? []).map((r) => r.topHitAnswered !== true));
}

/**
 * Answer-correctness over ANSWERABLE queries: the fraction whose top hit answered.
 * `topHitAnswered` is the LLM answer-grader's verdict on doSearch top-1. Empty → null.
 * Parse-fail rows are excluded by the caller before aggregation.
 *
 * @param {Array<{topHitAnswered:boolean}>} answerableRows
 */
export function answerCorrectnessRate(answerableRows) {
  return rate((answerableRows ?? []).map((r) => r.topHitAnswered === true));
}

/**
 * Detector fire-rate over ALL staleness rows: the fraction where the session-end
 * detector detected the contradiction (a free supersession-recall signal; the full #5
 * precision/recall treatment is deferred). Empty → null.
 *
 * @param {Array<{fired:boolean}>} stalenessRows
 */
export function fireRate(stalenessRows) {
  return rate((stalenessRows ?? []).map((r) => r.fired === true));
}

/** Effective corpus collapsed > `bound` below requested (dedup ate distinct points). */
export function dedupSaturated(requestedN, effectiveN, bound = 0.05) {
  if (!requestedN || requestedN <= 0) return false;
  return (requestedN - effectiveN) / requestedN > bound;
}

/** Twin-collision guard flagged too many rows → collision-excluded read is unreliable. */
export function guardSaturated(twinFlagged, queryCount, bound = 0.25) {
  if (!queryCount || queryCount <= 0) return false;
  return twinFlagged / queryCount > bound;
}

/**
 * The distractors applied no real retrieval pressure (their best query-neighbour cosine
 * never approaches the target band), so a flat recall curve is NOT evidence of robustness.
 * Unmeasured (null) → inert (fail-safe: never silently claim pressure we didn't verify).
 * `ratioFloor` = fraction of the target cosine the best distractor must reach to count as pressure.
 */
// ratioFloor 0.75 pinned from the 2026-06-25 keyed dry run: in-domain distractors drove a real
// recall@1 decline (0.955→0.833 over effectiveN 66→522) at a mean best/target cosine ratio of 0.78,
// which the prior 0.85 default false-flagged as inert. Foreign/out-of-domain filler sits well below
// 0.75, so the anti-inert guard still catches the failure mode it exists for.
export function isInert(meanTargetCos, meanBestDistractorCos, ratioFloor = 0.75) {
  if (typeof meanTargetCos !== 'number' || typeof meanBestDistractorCos !== 'number') return true;
  if (meanTargetCos <= 0) return true;
  return (meanBestDistractorCos / meanTargetCos) < ratioFloor;
}

/**
 * Aggregate the per-row pressure signals recallPass records (only when measurePressure:
 * true — i.e. the sweep's top rung) into mean target-cosine vs mean best-distractor-cosine,
 * and apply isInert() for the authoritative verdict. Rows that didn't measure both cosines
 * are ignored; an empty set → inert with null means (fail-safe: never claim pressure we
 * didn't verify). PURE (reuses the module mean + isInert; the returned `inert` is final).
 *
 * @param {{details?: Array<{targetCos?: number, bestNonTargetCos?: number}>}} recall
 */
export function computePressure(recall) {
  const ds = (recall?.details ?? []).filter((d) => typeof d.targetCos === 'number' && typeof d.bestNonTargetCos === 'number');
  if (ds.length === 0) return { inert: true, meanTargetCos: null, meanBestDistractorCos: null };
  const meanTargetCos = mean(ds.map((d) => d.targetCos));
  const meanBestDistractorCos = mean(ds.map((d) => d.bestNonTargetCos));
  return { inert: isInert(meanTargetCos, meanBestDistractorCos), meanTargetCos, meanBestDistractorCos };
}

// ---------------------------------------------------------------------------
// Operational baseline (PURE) — latency percentiles + provider-cost capture.
// Latency is wall-clock (environment-dependent: local ≠ Pi ≠ cloud) → RECORD,
// never gate. Cost is summed from the um_provider_* metrics embed()/facts()
// already emit (DRY: costUsd is computeCost()'d upstream — we only accumulate).
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile + the distribution summary now live in the shared eval
 * stats helper (single home for the rank formula, reused by lane/d3). `percentile`
 * is re-exported to keep the harness's unit-test surface stable.
 * @see ./lib/stats.mjs
 */
export { percentile };

/**
 * Summarize a latency sample (milliseconds): { count, p50, p95, min, max, mean }.
 * Thin wrapper over the shared summarize() with the operational p50/p95 set.
 * Empty → count 0 with null stats (unmeasurable); p50/p95 are nearest-rank. No
 * rounding here — kept exact for unit tests; the renderer rounds for display.
 *
 * @param {number[]} samples  per-call durations in ms
 */
export function summarizeLatency(samples) {
  return summarize(samples, [['p50', 0.5], ['p95', 0.95]]);
}

// Stable Prometheus scrape names embed()/facts() emit to (mirror of metrics.mjs
// PROVIDER_METRICS — duplicated as literals so importing this eval module never
// pulls prom-client into the offline unit-test scope).
const PROVIDER_TOKENS_TOTAL = 'um_provider_tokens_total';
const PROVIDER_COST_USD_TOTAL = 'um_provider_cost_usd_total';

/**
 * Capturing provider-cost sink. Duck-types the { counter, histogram } metrics
 * adapter that embed()/facts() emit to (metrics.mjs PROVIDER_METRICS_ADAPTER),
 * accumulating tokens by direction + USD cost with a per-surface breakdown.
 * Passed as umAdd's `metrics`, it captures the write's extract+embed spend even
 * though umAdd itself returns no usage. PURE (no I/O, no clock) — unit-tested
 * directly; the costUsd is already computeCost()'d upstream so we only sum it.
 *
 * @returns {{ totals: {tokensIn:number, tokensOut:number, costUsd:number,
 *             bySurface: Object<string,{tokensIn:number,tokensOut:number,costUsd:number}>},
 *            counter: Function, histogram: Function }}
 */
export function makeProviderCostSink() {
  const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0, bySurface: {} };
  const surf = (s) => (totals.bySurface[s] ??= { tokensIn: 0, tokensOut: 0, costUsd: 0 });
  return {
    totals,
    counter(name, labels = {}, value = 0) {
      const v = Number(value) || 0;
      if (name === PROVIDER_TOKENS_TOTAL) {
        const dir = labels.direction === 'in' ? 'tokensIn' : labels.direction === 'out' ? 'tokensOut' : null;
        if (!dir) return; // only directional token counters accumulate
        totals[dir] += v;
        if (labels.surface) surf(labels.surface)[dir] += v;
      } else if (name === PROVIDER_COST_USD_TOTAL) {
        totals.costUsd += v;
        if (labels.surface) surf(labels.surface).costUsd += v;
      }
      // unknown counter names (e.g. errors_total) are ignored — never a throw.
    },
    histogram() { /* provider-side duration ignored — wall-clock latency measured separately */ },
  };
}

// ---------------------------------------------------------------------------
// Drift-gate (PURE) — compares a runOnce() result against committed floors.
// ---------------------------------------------------------------------------

/** Pure deep-get by key path; undefined if any segment is missing or non-object. */
function getByPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * PURE drift-gate evaluation. For each threshold, deep-get its metric from `result`
 * and compare to the floor per `direction` ('min' → observed >= floor; 'max' →
 * observed <= floor). Floors are INCLUSIVE. A gated metric that is absent or
 * non-finite is a BREACH ('unmeasured') — never a silent pass (a dead detector or a
 * gutted corpus must not read as healthy; see spec §3.3).
 *
 * @param {object} result   a runOnce() result object
 * @param {{thresholds: Array<{metric:string, path:string[], direction:'min'|'max', floor:number}>}} config
 * @returns {{ pass:boolean, checked:number, breaches:Array<{metric,observed,floor,direction,reason}> }}
 */
export function evaluateGate(result, config) {
  const thresholds = config?.thresholds ?? [];
  const breaches = [];
  for (const t of thresholds) {
    const observed = getByPath(result, t.path);
    if (typeof observed !== 'number' || !Number.isFinite(observed)) {
      breaches.push({ metric: t.metric, observed: observed ?? null, floor: t.floor, direction: t.direction, reason: 'unmeasured' });
      continue;
    }
    const ok = t.direction === 'max' ? observed <= t.floor : observed >= t.floor;
    if (!ok) breaches.push({ metric: t.metric, observed, floor: t.floor, direction: t.direction, reason: 'below_floor' });
  }
  return { pass: breaches.length === 0, checked: thresholds.length, breaches };
}

/** PURE multi-line gate report (CI step-summary + console). */
export function formatGateReport(gate) {
  const lines = [`=== mq drift gate: ${gate.pass ? 'PASS' : 'FAIL'} (${gate.checked} floor(s) checked) ===`];
  for (const b of gate.breaches) {
    const cmp = b.direction === 'max' ? '<=' : '>=';
    lines.push(`  BREACH ${b.metric}: observed ${b.observed} fails ${cmp} ${b.floor} [${b.reason}]`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pretty-print (pure) — mirrors the d1/d3/lane formatSummaryTable shape.
// ---------------------------------------------------------------------------

function fmtPct(x) {
  return typeof x === 'number' && !Number.isNaN(x) ? x.toFixed(3) : 'n/a';
}

function fmtMs(x) { return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(1) : 'n/a'; }
function fmtUsd(x) { return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(6) : 'n/a'; }

/**
 * Multi-line human summary of a result object. Null-tolerant (a deferred/absent metric
 * renders as 'n/a'). Shape (subset): { provider, model, recall:{ks, queryCount,
 * aggregate, collisionExcludedAggregate, mrr}, staleness:{total, fired, fireRate,
 * staleReturnRate}, noAnswer:{total, precision}|null }.
 */
export function formatSummaryTable(result) {
  const lines = [];
  lines.push('=== Memory-Quality Eval (Tier-1 baseline) ===');
  lines.push(`Provider: ${result.provider ?? 'n/a'}  Model: ${result.model ?? 'n/a'}`);

  const rec = result.recall;
  if (rec) {
    lines.push('');
    lines.push(`Recall@k (n=${rec.queryCount ?? 'n/a'} queries):`);
    for (const k of rec.ks ?? []) {
      const raw = rec.aggregate?.[k];
      const ce = rec.collisionExcludedAggregate?.[k];
      lines.push(
        `  Recall@${String(k).padStart(2)}: ${fmtPct(raw)}` +
        (ce != null ? `  (collision-excluded: ${fmtPct(ce)})` : ''),
      );
    }
    lines.push(`  MRR: ${fmtPct(rec.mrr)}`);
    if (rec.ndcg) {
      lines.push('  nDCG@k: ' + (rec.ks ?? []).map((k) => `@${k} ${fmtPct(rec.ndcg?.[k])}`).join('  '));
    }

    const bpl = rec.byParaphraseLevel;
    if (bpl) {
      lines.push('  By paraphrase level (recall@1 / @5):');
      for (const level of ['lexical', 'paraphrase', 'oblique']) {
        const m = bpl.byLevel?.[level];
        if (!m) continue;
        const n = bpl.counts?.[level] ?? 0;
        lines.push(`    ${level.padEnd(10)} n=${String(n).padStart(2)}  @1 ${fmtPct(m[1])}  @5 ${fmtPct(m[5])}`);
      }
      lines.push(
        `    gap@5 vs lexical:  paraphrase ${fmtPct(bpl.gaps?.paraphraseVsLexical?.[5])}` +
        `  oblique ${fmtPct(bpl.gaps?.obliqueVsLexical?.[5])}`,
      );
    }
  }

  const st = result.staleness;
  if (st) {
    lines.push('');
    lines.push(
      `Stale-return (over detector-fired rows): ${fmtPct(st.staleReturnRate)}  ` +
      `[fired ${st.fired ?? 'n/a'}/${st.total ?? 'n/a'}, fire-rate ${fmtPct(st.fireRate)}]`,
    );
  }

  lines.push('');
  const ac = result.answerCorrectness;
  lines.push(`Answer-correctness@1 (answerable): ${ac ? fmtPct(ac.rate) : 'n/a (deferred)'}`);
  const na = result.noAnswer;
  lines.push(`No-answer precision: ${na ? fmtPct(na.precision) : 'n/a (deferred)'}`);

  // Operational baseline (Candidate B) — back-compat-guarded so pre-B result
  // JSON (and the recall-only render path) is unaffected when absent.
  const lat = result.latency;
  if (lat) {
    lines.push('');
    lines.push('Latency (ms, p50/p95 over N calls):');
    for (const op of ['umAdd', 'doSearch']) {
      const m = lat[op];
      if (!m) continue;
      lines.push(
        `  ${op.padEnd(9)} n=${String(m.count ?? 0).padStart(3)}  ` +
        `p50 ${fmtMs(m.p50)}  p95 ${fmtMs(m.p95)}  ` +
        `(min ${fmtMs(m.min)} max ${fmtMs(m.max)} mean ${fmtMs(m.mean)})`,
      );
    }
  }

  const cost = result.cost;
  if (cost) {
    lines.push('');
    lines.push('Cost (provider spend):');
    const w = cost.write;
    if (w) {
      lines.push(
        `  write (umAdd extract+embed): ${(w.tokensIn ?? 0) + (w.tokensOut ?? 0)} tokens ` +
        `(in ${w.tokensIn ?? 0} / out ${w.tokensOut ?? 0})  $${fmtUsd(w.costUsd)}`,
      );
    }
    const ee = cost.evalEmbed;
    if (ee) {
      lines.push(`  eval twin-embed overhead: ${(ee.tokensIn ?? 0) + (ee.tokensOut ?? 0)} tokens  $${fmtUsd(ee.costUsd)}`);
    }
    if (cost.note) lines.push(`  note: ${cost.note}`);
  }

  return lines.join('\n');
}

/** Pure render of result.corpusSweep — an effectiveN-keyed table with inert/saturation flags.
 *  Returns '' when no sweep is present (caller decides whether to print). */
export function formatCorpusSweep(result) {
  const cs = result?.corpusSweep;
  if (!cs || !Array.isArray(cs.rows) || cs.rows.length === 0) return '';
  const lines = [];
  lines.push('=== Corpus-size sweep (recall / latency / cost vs effective N) ===');
  if (cs.pressure?.inert) {
    lines.push('  !! INERT: distractors applied no retrieval pressure — a flat curve is NOT scale-robustness.');
  }
  lines.push('  effN (reqN)  recall@1  recall@5  ce@5  twinFlg  MRR  nDCG@5  seedP50/P95  searchP50/P95  $write  flags');
  for (const r of cs.rows) {
    const flags = [r.dedupSaturated ? 'dedup-saturated' : '', r.recall?.guardSaturated ? 'guard-saturated' : '', r.exactSearch ? '' : 'ANN']
      .filter(Boolean).join(',') || '-';
    lines.push(
      `  ${String(r.effectiveN).padStart(6)} (${r.requestedN})  ` +
      `${fmtPct(r.recall?.aggregate?.[1])}     ${fmtPct(r.recall?.aggregate?.[5])}    ` +
      `${fmtPct(r.recall?.collisionExcludedAggregate?.[5])}  ${String(r.recall?.twinFlagged ?? 0).padStart(3)}    ` +
      `${fmtPct(r.recall?.mrr)}  ${fmtPct(r.recall?.ndcg?.[5])}   ` +
      `${fmtMs(r.latency?.umAdd?.p50)}/${fmtMs(r.latency?.umAdd?.p95)}    ` +
      `${fmtMs(r.latency?.doSearch?.p50)}/${fmtMs(r.latency?.doSearch?.p95)}   ` +
      `$${fmtUsd(r.cost?.write?.costUsd)}  ${flags}`,
    );
  }
  return lines.join('\n');
}

const fmtMB = (b) => (b == null ? '   -  ' : (b / 1_048_576).toFixed(1).padStart(6));

/** Pure render of result.storageSweep — a footprint-vs-N table + the Pi RAM headline.
 *  Returns '' when no sweep is present (caller decides whether to print). */
export function formatStorageSweep(result) {
  const ss = result?.storageSweep;
  if (!ss || !Array.isArray(ss.rows) || ss.rows.length === 0) return '';
  const lines = [];
  lines.push('=== Storage & index growth (footprint vs N) ===');
  lines.push(`  dim=${ss.dim} distance=${ss.distance} hnswM=${ss.hnswM} indexingThreshold=${ss.indexingThreshold} payloadB/pt=${ss.payloadBytesPerPoint}`);
  lines.push('       N  pts  regime  vec MB  payld MB  proj RAM MB  measured MB  B/fact(vec+pay+idx)  flags');
  for (const r of ss.rows) {
    const flags = [r.seedIncomplete ? 'seed-incomplete' : '',
                   (r.indexedRegime === 'hnsw') !== indexedAtOrAbove(r.requestedN, ss.indexingThreshold) ? 'regime-divergence' : '']
      .filter(Boolean).join(',') || '-';
    const bf = r.bytesPerFact ?? {};
    lines.push(
      `  ${String(r.requestedN).padStart(6)}  ${String(r.pointsCount).padStart(5)}  ${(r.indexedRegime ?? '?').padEnd(5)}  ` +
      `${fmtMB(r.vectorBytes)}  ${fmtMB((r.payloadBytesPerPoint ?? 0) * r.requestedN)}  ${fmtMB(r.projected?.ramBytes)}     ` +
      `${fmtMB(r.measuredDiskBytes)}     ${bf.vector ?? 0}+${bf.payload ?? 0}+${bf.indexOverhead ?? 0}=${bf.total ?? 0}   ${flags}`,
    );
  }
  if (ss.piProjection) {
    lines.push('');
    lines.push(`  >> Pi headline: projected qdrant RAM at ${ss.piProjection.atN} facts ≈ ${fmtMB(ss.piProjection.ramBytesProjected).trim()} MB`);
  }
  return lines.join('\n');
}

/** Local helper: model-predicted HNSW regime (mirrors storage-model.indexed without importing it here). */
function indexedAtOrAbove(n, threshold) { return n >= threshold; }

// ---------------------------------------------------------------------------
// Fixture loader (I/O, no live calls) — JSON-Lines, one object per line.
// Identical contract to d3/lane: utf8, split on /\r?\n/, drop blank lines, throw
// WITH the 1-based line number on a malformed line.
// ---------------------------------------------------------------------------

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
// CLI arg parsing (pure).
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--recall') args.recall = argv[++i];
    else if (a === '--staleness') args.staleness = argv[++i];
    else if (a === '--no-answer') args.noAnswer = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--out-prefix') args.outPrefix = argv[++i];
    else if (a === '--gate') args.gate = argv[++i];
    else if (a === '--sweep') args.sweep = true;
    else if (a === '--undated-arm') args.undatedArm = true;
    else if (a === '--corpus-sweep') args.corpusSweep = true;
    else if (a === '--sweep-sizes') {
      // tolerate a missing/empty value (flag passed last) → undefined so the runner uses its default
      const parsed = (argv[++i] ?? '').split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
      args.sweepSizes = parsed.length ? parsed : undefined;
    }
    else if (a === '--seed') { const v = parseInt(argv[++i], 10); if (Number.isInteger(v)) args.seed = v; }
    else if (a === '--storage-sweep') args.storageSweep = true;
    else if (a === '--storage-sizes') {
      const parsed = (argv[++i] ?? '').split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
      args.storageSizes = parsed.length ? parsed : undefined;
    }
    else if (a === '--storage-dim') { const v = parseInt(argv[++i], 10); if (Number.isInteger(v) && v > 0) args.storageDim = v; }
  }
  return args;
}

// ===========================================================================
// Phase 2 — live wiring (runOnce + CLI). Live deps are LAZY-imported inside
// runOnce so importing this module from a unit test stays fully offline. The
// retrieval/ranking/supersession decisions are the REAL production functions —
// never re-implemented here (the lane/d3 faithfulness contract).
// ===========================================================================

const EVAL_USER = 'um-mq-eval';        // pinned write+read userId (review B1 reconciliation)
const VECTOR_DIM = 1536;               // text-embedding-3-small
const SCRATCH_PREFIX = 'eval_mq_';     // every scratch collection MUST start with this
const TWIN_COSINE = 0.90;              // a non-target seed this close can bury a target (review G3)

function md5Hex(s) { return createHash('md5').update(s).digest('hex'); }
function isoDate() { return new Date().toISOString().slice(0, 10); }

/** Time an async call (wall-clock ms via performance.now) and push the duration into
 *  `samples`; returns fn's result. finally-push so a throwing call still records its time. */
async function recordTimed(samples, fn) {
  const t0 = performance.now();
  try { return await fn(); }
  finally { samples.push(performance.now() - t0); }
}

/**
 * Fail-loud isolation guard (review B2/B3): refuse to create/drop/operate on any
 * collection that is not an `eval_mq_` scratch collection — and NEVER `memories`.
 */
function assertScratchSafe(name) {
  if (typeof name !== 'string' || !name.startsWith(SCRATCH_PREFIX) || name === 'memories') {
    throw new Error(
      `mq-eval: refusing non-scratch collection '${name}' — must start with '${SCRATCH_PREFIX}' and never be 'memories'`,
    );
  }
}

/** Idempotent reset of a scratch collection (delete-if-exists → create). 404 on delete is fine. */
async function ensureCollection(client, name, dim) {
  assertScratchSafe(name);
  try { await client.deleteCollection(name); } catch (e) { if (e?.status !== 404) throw e; }
  await client.createCollection(name, { vectors: { size: dim, distance: 'Cosine' } });
}

/** Best-effort drop of a scratch collection (guarded; 404 ignored). */
async function dropCollectionQuiet(client, name) {
  assertScratchSafe(name);
  try { await client.deleteCollection(name); } catch (e) { if (e?.status !== 404) throw e; }
}

/**
 * Clear all eval points from a scratch collection WITHOUT recreating it (recreating
 * races with mem0's Memory-constructor auto-create). `wait:true` makes the delete
 * synchronous so the next row starts from a clean, consistent state.
 */
async function clearPoints(client, name) {
  assertScratchSafe(name);
  await client.delete(name, { wait: true, filter: { must: [{ key: 'userId', match: { value: EVAL_USER } }] } });
}

/** Exact point count of a collection; null if it does not exist. */
async function countPoints(client, name) {
  try { return (await client.count(name, { exact: true })).count; }
  catch (e) { if (e?.status === 404) return null; throw e; }
}

/**
 * The undated arm's shape, PINNED IN ADVANCE.
 *
 * The arm size is fixed here, in code, before any number exists — a subset size chosen
 * after seeing results is a choice about the result. The fixture is checked against these
 * values by its own test, so drifting the file without a deliberate re-pin fails loudly.
 *
 * Deliberately SEPARATE from the default recall corpus: memory-quality-eval is the nightly
 * drift gate, whose floors carry "re-pin only with a committed 2-run re-measurement". This
 * arm gets its own fixture, its own scratch collection and its own entry point so the
 * default run stays byte-identical.
 */
export const UNDATED_ARM = Object.freeze({
  fixture: 'eval/undated-arm-set.jsonl',
  rows: 48,
  undatedGold: 24,
  dated: 24,
  /**
   * Semantic distractors seeded alongside the fixture — NOT queried, purely competition.
   *
   * WHY THIS EXISTS, learned the expensive way. The first before-arm run without them came
   * back at CEILING: 24/24 gold rows at rank 1, recall@5 = 1.0, mean rank exactly 1.0. The
   * 48 fixture facts are deliberately dissimilar (closest pair ~0.47 cosine, so nothing
   * dedups), which also means each query's target wins by a wide margin against only 47
   * distant competitors. A gate that returns 1.0 there would return 1.0 for ANY imputed
   * factor — exp(-1), exp(-5), 0.001 — so it measures the fixture, not the policy.
   *
   * 353 makes the arm's corpus 401 points, matching the live corpus measured 2026-08-05
   * (401 total / 215 dated / 186 undated). Distractors are lane-driven, so they compete by
   * semantic proximity rather than sitting harmlessly far away.
   *
   * They are DATED and back-dated across the fixture's own spread: post-policy a dated
   * competitor keeps ~0.8-0.99 of its score while an undated gold takes 0.368, so dated
   * distractors are exactly the pressure the gate needs to be able to fail.
   */
  distractors: 353,
  distractorSeed: 7,
});

/**
 * WIRING NOTE — the fixture's rows are NOT seedable as loaded.
 *
 * They carry `days_ago`, not `valid_from`. Feeding them straight to seedCorpus looks
 * correct and fails silently: seedCorpus reads only `f.valid_from`, so add.mjs stamps
 * `now` on all of them and the entire dated cohort collapses to age 0 — the ~0-day corner
 * the back-dating exists to avoid. Worse, assertDateCohorts STILL PASSES (the undated ids
 * genuinely lack the key; the dated ids genuinely carry a usable date — just today's).
 *
 * Always: rows = materialiseValidFrom(await loadFixtureJsonl(UNDATED_ARM.fixture)), and
 * build assertBackdated's expectation map from THOSE rows, so the check and the seed share
 * one source of truth. assertBackdated is the only guard that catches this.
 */

/**
 * Materialise each seed fact's `days_ago` into a `valid_from` ISO string relative to `now`.
 *
 * The fixture stores AGES, not dates. A hardcoded absolute date would drift one day older
 * every day, silently changing the decay factors the fixture exists to hold fixed — the
 * spread would stop mirroring the live corpus the moment it was committed. Deriving at
 * seed time keeps the fixture reproducible for as long as it lives.
 *
 * Pure: returns new rows, mutates nothing. Seed facts without `days_ago` pass through
 * untouched, so this is safe to run over any fixture.
 */
export function materialiseValidFrom(rows, now = Date.now()) {
  return (rows ?? []).map((row) => ({
    ...row,
    seed_facts: (row.seed_facts ?? []).map((f) => (
      f.days_ago === undefined ? { ...f } : { ...f, valid_from: backdatedIso(f.days_ago, now) }
    )),
  }));
}

/**
 * An ISO 8601 STRING for `daysAgo` days before `now`, for back-dating the dated cohort.
 *
 * WHY A STRING, AND WHY THIS MATTERS: lib/add.mjs preserves a caller-supplied
 * `valid_from` only when `isUsableDate` accepts it, and isUsableDate requires
 * `typeof v === 'string'`. A `Date` object or an epoch number is therefore REJECTED and
 * silently replaced with `nowIso`. The point still ends up WITH a `valid_from`, so a
 * presence check still passes — while the whole cohort has quietly reverted to ~0 days
 * old, which is the exact degenerate fixture the back-dating exists to avoid. Use
 * assertBackdated (equality, not presence) to catch it.
 */
export function backdatedIso(daysAgo, now = Date.now()) {
  if (!Number.isFinite(daysAgo)) throw new Error(`mq-eval: backdatedIso needs a finite daysAgo (got ${daysAgo})`);
  // NEGATIVE is refused, not merely odd: a forward-dated point yields a NEGATIVE age, and
  // applyTemporalDecay has no upper clamp (unlike applyTemporalWindow, which documents
  // "a score is only ever multiplied by a factor <= 1"). So a sign typo in a fixture would
  // silently INFLATE a seed's score above its true value — the opposite of the degenerate
  // case this helper exists to prevent, and far harder to notice.
  if (daysAgo < 0) throw new Error(`mq-eval: backdatedIso refuses a negative daysAgo (${daysAgo}) — a future date inflates the decay factor above 1`);
  const ms = now - daysAgo * 86400000;
  if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) {
    throw new Error(`mq-eval: backdatedIso(${daysAgo}) falls outside the representable Date range`);
  }
  return new Date(ms).toISOString();
}

/**
 * Assert each dated point's `valid_from` EQUALS the value the fixture asked for.
 *
 * EQUALITY, NEVER PRESENCE. If a fixture supplied a non-string date, add.mjs minted `now`
 * over it; the key is present, so a presence check reports success while the cohort sits
 * at ~0 days old and the measurement degenerates. Comparing to the expected value is the
 * only check that distinguishes "back-dated" from "silently re-stamped".
 *
 * @param {Array<{eval_ref:string, valid_from?:string}>} points
 * @param {Record<string,string>|Map<string,string>} expectedByRef  eval_ref → expected ISO
 */
export function assertBackdated(points, expectedByRef) {
  const expected = expectedByRef instanceof Map ? expectedByRef : new Map(Object.entries(expectedByRef ?? {}));
  if (expected.size === 0) throw new Error('mq-eval: assertBackdated needs a non-empty expectation map — an empty one asserts nothing');

  // Every EXPECTATION must itself be a usable date. Building the map with
  // `[ref, f.valid_from]` over a mixed fixture yields `undefined` for every undated seed,
  // and `undefined !== undefined` is false — so those refs would pass silently and inflate
  // `checked`. Refusing them keeps the count honest and the assertion meaningful.
  const unusable = [...expected].filter(([, v]) => !isUsableDate(v)).map(([ref]) => ref);
  if (unusable.length > 0) {
    throw new Error(
      `mq-eval: assertBackdated expectations must all be usable date strings — ${unusable.length} are not (${unusable.slice(0, 5).join(', ')}). ` +
      'Filter the dated cohort before building the map; an undefined expectation asserts nothing.',
    );
  }

  const actual = new Map((points ?? []).map((p) => [p.eval_ref, p.valid_from]));
  if (actual.size !== (points ?? []).length) {
    // Last-wins would let a correctly-dated duplicate mask a re-stamped one.
    throw new Error(`mq-eval: assertBackdated got duplicate eval_refs (${(points ?? []).length} points, ${actual.size} distinct) — the check would silently drop one`);
  }
  const problems = [];
  for (const [ref, want] of expected) {
    if (!actual.has(ref)) { problems.push(`${ref}: not found`); continue; }
    const got = actual.get(ref);
    if (got !== want) problems.push(`${ref}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `mq-eval BACK-DATE VIOLATION: ${problems.length}/${expected.size} dated points do not carry their fixture value ` +
      '(a presence check would not have caught this). Known causes, in the order worth checking: ' +
      '(1) a non-string valid_from — isUsableDate rejects it and add.mjs re-stamps `now`; ' +
      '(2) a dedup collision — an identical text+lane written second keeps the FIRST writer\'s date (mergeSurface does not patch valid_from); ' +
      '(3) a fail-soft upsert at the same deterministic fact id, which REPLACES the payload and re-dates the point. ' +
      problems.slice(0, 5).join('; '),
    );
  }
  return { checked: expected.size };
}

/**
 * Delete the TOP-LEVEL `valid_from` key from a DEFINED SUBSET of points on a scratch
 * collection. This is how the undated cohort is created: everything is seeded through the
 * normal write path (so dedup, lane classification, reserved-field assertions and capture
 * counters all behave exactly as in production), and only then is the date removed from
 * the chosen subset.
 *
 * THE WAY THE OBVIOUS IMPLEMENTATION SILENTLY NO-OPS — it leaves every point dated, so the
 * downstream measurement passes VACUOUSLY, which is indistinguishable from success:
 *
 *   **The key is the top-level `valid_from`, NOT `metadata.valid_from`.** lib/add.mjs
 *   flattens metadata to the payload root. Qdrant DOES read a dot as a nested path, so
 *   `keys: ['metadata.valid_from']` strips the nested projection (if any) and leaves the
 *   ROOT key — the one the read path resolves — completely intact.
 *
 * MEASURED against qdrant v1.13.0 on 2026-08-06 rather than assumed:
 *   - `deletePayload({keys:['valid_from']})` removes the root key entirely: it comes back
 *     ABSENT, not null, and every other payload key survives.
 *   - `deletePayload({keys:['metadata.valid_from']})` leaves the root key untouched and
 *     strips only the nested one. That is the trap, confirmed live.
 *   - `setPayload({valid_from: null})` ALSO ends with the key absent — qdrant drops
 *     null-valued keys. So "setPayload cannot delete keys" is not true in the sense that
 *     matters here; an earlier version of this comment claimed it was, citing
 *     lib/supersede.mjs, and that was wrong. `deletePayload` remains the right call
 *     because it states the intent exactly and does not lean on a null-dropping quirk —
 *     but the reason is clarity, not capability.
 *
 * Scratch-only: assertScratchSafe runs BEFORE any client call. An empty subset is refused
 * rather than treated as success — a no-op strip is the failure this function exists to
 * make impossible.
 */
export async function stripValidFrom(client, collection, pointIds) {
  assertScratchSafe(collection);
  if (!Array.isArray(pointIds) || pointIds.length === 0) {
    throw new Error('mq-eval: stripValidFrom needs a non-empty point-id subset — an empty strip is a silent no-op');
  }
  await client.deletePayload(collection, { points: pointIds, keys: ['valid_from'], wait: true });
}

/**
 * Assert the dated/undated cohorts are exactly as intended, BEFORE any number is computed.
 *
 * BOTH directions are mandatory, and each guards a different vacuous pass:
 *   - undated ids carry NO `valid_from` — catches a strip that no-opped (wrong API, or the
 *     dotted key), which would leave both cohorts dated.
 *   - dated ids STILL carry theirs — catches a strip that was too broad. If the whole
 *     corpus ends up undated, the undated factor becomes a uniform multiplier, ordering is
 *     unchanged by construction, and the gate passes with a delta of exactly 0: a null
 *     result wearing the shape of a clean pass.
 *
 * Both subsets must be non-empty, or the corresponding check is itself vacuous.
 *
 * THE TWO CHECKS ARE DELIBERATELY ASYMMETRIC — do not "simplify" them to one predicate:
 *   - undated: the key must be strictly ABSENT — `!== undefined`, not a truthiness test.
 *     Be precise about what that buys, because an earlier comment here overclaimed:
 *     measured against qdrant v1.13.0, a null-valued key comes back ABSENT (qdrant drops
 *     nulls), so this does NOT distinguish a `deletePayload` from a `setPayload(null)`.
 *     What it DOES guarantee is that nothing counts as undated unless the key is genuinely
 *     gone — a present-but-null value from any other source (a direct upsert, another
 *     client, a future qdrant that preserves nulls) is refused rather than assumed benign.
 *     Conservative on purpose: the read path treats null as undated, so silently agreeing
 *     with it would hide a strip that only half-worked.
 *   - dated: the value must satisfy the READ PATH's own `isUsableDate`. A present-but-
 *     unusable value (null, '', a Date object that add.mjs failed to stamp) is one the
 *     ranker scores as undated, which silently makes the whole corpus undated — the
 *     uniform-multiplier vacuous pass, arriving through the back door.
 */
export async function assertDateCohorts(client, collection, { undatedIds = [], datedIds = [] } = {}) {
  assertScratchSafe(collection);
  if (undatedIds.length === 0 || datedIds.length === 0) {
    throw new Error(
      `mq-eval: assertDateCohorts needs BOTH cohorts non-empty (undated=${undatedIds.length}, dated=${datedIds.length}) — a one-sided corpus makes the measurement vacuous`,
    );
  }

  const ids = [...undatedIds, ...datedIds];
  const fetched = await client.retrieve(collection, { ids, with_payload: true });
  const found = new Map((fetched ?? []).map((p) => [String(p.id), p.payload ?? {}]));

  const missing = ids.filter((id) => !found.has(String(id)));
  if (missing.length > 0) {
    throw new Error(`mq-eval COHORT VIOLATION: ${missing.length}/${ids.length} cohort points not found in '${collection}'`);
  }

  const stillDated = undatedIds.filter((id) => found.get(String(id)).valid_from !== undefined);
  if (stillDated.length > 0) {
    throw new Error(
      `mq-eval COHORT VIOLATION: ${stillDated.length}/${undatedIds.length} undated-cohort points STILL carry valid_from — the strip no-opped (wrong API, or the dotted metadata.valid_from). Every number computed from here would be vacuous.`,
    );
  }

  const lostDate = datedIds.filter((id) => !isUsableDate(found.get(String(id)).valid_from));
  if (lostDate.length > 0) {
    throw new Error(
      `mq-eval COHORT VIOLATION: ${lostDate.length}/${datedIds.length} dated distractors LOST a usable valid_from — the strip was too broad, or the value is one the read path cannot use. A uniformly-undated corpus makes the undated factor a uniform multiplier, so the gate passes with a delta of exactly 0.`,
    );
  }

  return { undated: undatedIds.length, dated: datedIds.length };
}

/**
 * Seed the recall corpus: each seed fact → umAdd(infer:false) under EVAL_USER with an
 * eval-only metadata.eval_ref + a pinned lane (review G1). Records the write-returned id
 * per seed. Guards (review G2): surface DEDUP_MERGED and any id-collision.
 */
/**
 * The undated-arm measurement pass: seed the whole fixture through the NORMAL write path,
 * strip the date from the gold subset only, prove both cohorts are what they claim to be,
 * then run one recall pass with decay pinned and report G1/G2.
 *
 * WHY THIS DOES NOT CALL `runOnce`. runOnce also drives the staleness and answer-grading
 * passes — LLM cost and grader noise in a measurement that is purely about RANKING. This
 * arm needs `seedCorpus` + `recallPass` and nothing else, so it composes them directly. It
 * still runs inside `withDecayEnv`, so the flag is pinned in-process and cleared after, and
 * `flags` records the same resolved value the run actually executed under.
 *
 * ORDER IS LOAD-BEARING. Both cohort assertions run BEFORE any number is computed, because
 * both failure directions produce a VACUOUS pass that looks exactly like success: a strip
 * that no-opped leaves nothing undated, and a strip that was too broad leaves nothing dated
 * (the undated factor then becomes a uniform multiplier and the delta is exactly 0).
 *
 * Every live dependency is INJECTED rather than imported here, so the sequence and scoping
 * are drivable by fakes offline. The live seams — does deletePayload really remove the key
 * — are proven by a live probe and by the run itself; a fake cannot testify about qdrant.
 *
 * ⚠ CALLER RESPONSIBILITY, and it bites silently: **`MEM0_USER_ID` must be pinned to
 * EVAL_USER BEFORE `mem0-mcp-http.mjs` is imported**, because doSearch captures USER_ID at
 * import time. This function cannot do it for you — the imports belong to the caller, which
 * is the price of the DI that makes the wiring testable. Get it wrong and doSearch searches
 * the wrong user, every target misses, and G2 comes back 0 — which reads as "the policy
 * destroyed recall" rather than "an env var was set too late". The CLI entry point below
 * does this correctly; any bespoke runner must too.
 *
 * @param {object} args
 * @param {Array}  args.rows        RAW fixture rows (they still carry `days_ago`).
 * @param {string} args.collection  Scratch collection; must carry the eval_mq_ prefix.
 * @param {boolean|string} [args.decay=true]
 * @param {number} [args.now]       Clock for back-dating; pass a fixed value to reproduce.
 */
export async function runUndatedArm(args = {}) {
  return withDecayEnv(args.decay ?? true, (resolved) => runUndatedArmDecayPinned({ ...args, decay: resolved }));
}

async function runUndatedArmDecayPinned({
  rows, collection, decay, now = Date.now(),
  umAdd, memory, client, doSearch, embed, cosineStrict, NOOP_METRICS,
  generateDistractors, lanesFromRows,
  distractors = UNDATED_ARM.distractors, distractorSeed = UNDATED_ARM.distractorSeed,
  ks = [1, 3, 5, 10],
}) {
  assertScratchSafe(collection);

  // days_ago -> valid_from. Skipping this is the silent failure the fixture warns about:
  // seedCorpus reads only `valid_from`, so unmaterialised rows get stamped `now` and the
  // entire dated cohort collapses to age 0 while every cohort assertion still passes.
  const materialised = materialiseValidFrom(rows, now);
  const { goldRefs, datedRefs, expectedByRef } = undatedArmCohorts(materialised);

  // Competitive pressure. Without distractors every gold wins at rank 1 by a wide margin,
  // the gate sits at ceiling, and it would pass for ANY imputed factor — see UNDATED_ARM.
  const distractorRows = undatedArmDistractorRows(materialised, {
    count: distractors, seed: distractorSeed, lanes: lanesFromRows(materialised), generate: generateDistractors,
  });
  const seedRows = [...materialised, ...materialiseValidFrom(distractorRows, now)];

  const latency = { umAdd: [], doSearch: [] };
  const cost = { embedTokensIn: 0, embedTokensOut: 0, embedCostUsd: 0 };
  const seedInfo = await seedCorpus({ umAdd, memory, client, rows: seedRows, latency, metrics: NOOP_METRICS });

  // A doSearch result id is a writeId, not an eval_ref — the strip has to address points by
  // the id the write actually returned.
  const writeIdByRef = new Map(seedInfo.seeds.map((s) => [s.eval_ref, s.writeId]));
  const idsFor = (refs) => refs.map((ref) => {
    const id = writeIdByRef.get(ref);
    if (id === undefined) throw new Error(`mq-eval undated-arm: no write id captured for '${ref}'`);
    return id;
  });
  const goldIds = idsFor(goldRefs);
  const datedIds = idsFor(datedRefs);

  // Dedup on a FIXTURE seed would merge two cohort points into one and break the 1:1 split,
  // so it is ASSERTED rather than assumed — `merged: 0` must be measured, which is exactly
  // what the _systemMigration shortcut would have made true by construction instead.
  //
  // SCOPED TO THE FIXTURE, deliberately. Distractors are generated from templates and DO
  // collapse against each other (353 requested, ~342 distinct), which is harmless — they are
  // undifferentiated competition, not cohort members. A whole-corpus check would abort every
  // run on that, and "relax the guard" would be the tempting wrong fix.
  const fixtureRefs = new Set([...goldRefs, ...datedRefs]);
  const fixtureSeeds = seedInfo.seeds.filter((s) => fixtureRefs.has(s.eval_ref));
  const fixtureMerged = fixtureSeeds.filter((s) => s.event === 'DEDUP_MERGED').length;
  if (fixtureMerged !== 0) {
    throw new Error(`mq-eval undated-arm: ${fixtureMerged} FIXTURE seed(s) were DEDUP_MERGED — the cohort split is no longer 1:1`);
  }
  if (new Set(fixtureSeeds.map((s) => s.writeId)).size !== fixtureSeeds.length) {
    throw new Error(`mq-eval undated-arm: id collision among the ${fixtureSeeds.length} fixture seeds`);
  }
  if (fixtureSeeds.length !== goldRefs.length + datedRefs.length) {
    throw new Error(`mq-eval undated-arm: expected ${goldRefs.length + datedRefs.length} fixture seeds, captured ${fixtureSeeds.length}`);
  }

  await stripValidFrom(client, collection, goldIds);
  await assertDateCohorts(client, collection, { undatedIds: goldIds, datedIds });

  // EQUALITY, not presence: a non-string valid_from is rejected by isUsableDate and
  // re-stamped as `now`, which a presence check passes while the age spread is silently gone.
  const datedPoints = (await client.retrieve(collection, { ids: datedIds, with_payload: true }) ?? [])
    .map((p) => ({ eval_ref: p.payload?.eval_ref, valid_from: p.payload?.valid_from }));
  assertBackdated(datedPoints, expectedByRef);

  // `rows` drives the QUERIES (fixture only); `seeds` is every point in the collection, so
  // the twin guard and the id join see the distractors too. Mirrors runCorpusSweep.
  const recall = await recallPass({
    doSearch, embed, cosineStrict, NOOP_METRICS, memory,
    rows: materialised, seeds: seedInfo.seeds, ks, cost, latency, captureScores: true,
  });

  const { g1, g2, headroom } = undatedArmMetrics(recall.details, goldRefs);

  return {
    timestamp: new Date(now).toISOString(),
    arm: 'undated',
    flags: evalRunFlags({ decay, autosupersede: 'false' }),
    fixture: {
      path: UNDATED_ARM.fixture,
      rows: materialised.length,
      undatedGold: goldRefs.length,
      dated: datedRefs.length,
      ageSpreadDays: [...new Set(materialised.flatMap((r) => r.seed_facts.map((f) => f.days_ago)))].sort((a, b) => a - b),
    },
    seedCount: seedInfo.seeds.length,
    corpus: {
      fixtureSeeds: fixtureSeeds.length,
      distractorsRequested: distractors,
      effectiveN: seedInfo.distinctIdCount,
      distractorsCollapsed: seedInfo.seeds.length - seedInfo.distinctIdCount,
    },
    mergedCount: seedInfo.mergedCount,
    g2,
    g1,
    headroom,
    recall: { aggregate: recall.aggregate ?? null, details: recall.details },
    cost,
    latency: { umAdd: summarizeLatency(latency.umAdd), doSearch: summarizeLatency(latency.doSearch) },
  };
}

/**
 * Split materialised fixture rows into the two cohorts, and build the back-date expectation
 * map at the same time so the check and the seed share ONE source of truth.
 *
 * PURE, kept separate from the live orchestration precisely so the part with logic worth
 * getting exactly right is testable without qdrant, an embedder, or an API key.
 *
 * @returns {{goldRefs: string[], datedRefs: string[], expectedByRef: Record<string,string>}}
 *   `goldRefs` are the eval_refs whose points get stripped (the undated cohort); `datedRefs`
 *   keep theirs; `expectedByRef` maps every DATED ref to the exact ISO value the fixture
 *   asked for, which is what assertBackdated compares against. Gold refs are deliberately
 *   ABSENT from the map — their dates are about to be deleted, so an expectation would be
 *   asserting something the run itself destroys.
 */
/**
 * Wrap generated distractors as seedable rows, back-dated across the FIXTURE's own age
 * spread so the competition looks like the corpus rather than like a block of age-0 writes.
 *
 * PURE (the generator is injected). Distractors carry no `query` and never reach recallPass's
 * `rows` — they exist only to be retrieved against.
 */
export function undatedArmDistractorRows(fixtureRows, { count, seed, lanes, generate }) {
  if (count <= 0) return [];
  const spread = (fixtureRows ?? []).flatMap((r) => (r.seed_facts ?? []).map((f) => f.days_ago)).filter((n) => Number.isFinite(n));
  if (spread.length === 0) throw new Error('undatedArmDistractorRows: the fixture supplied no days_ago spread to mirror');
  return generate(count, { seed, lanes }).map((d, i) => ({
    id: `distractor:${i}`,
    seed_facts: [{ text: d.text, lane: d.lane, days_ago: spread[i % spread.length] }],
  }));
}

export function undatedArmCohorts(rows) {
  const goldRefs = [];
  const datedRefs = [];
  const expectedByRef = {};
  for (const row of rows ?? []) {
    for (let i = 0; i < (row.seed_facts ?? []).length; i++) {
      const ref = `${row.id}:${i}`;
      if (row.undated_gold) {
        goldRefs.push(ref);
      } else {
        datedRefs.push(ref);
        expectedByRef[ref] = row.seed_facts[i].valid_from;
      }
    }
  }
  return { goldRefs, datedRefs, expectedByRef };
}

/**
 * G1 and G2 over a recall pass's per-row details. PURE — these are the numbers the whole
 * arc turns on, so they must be checkable without a live run.
 *
 * G2 (**the gate**) — recall@5 restricted to rows whose gold answer is an UNDATED point.
 * That is the genuine cost the policy can fail: demoting undated points can only hurt here.
 *
 * G1 (**reported, never gated**) — the undated cohort's mean rank. A synthetic fixture's
 * author picks the undated fraction, the age spread and the seed scores, so this delta is
 * determined by fixture construction; gating on it would test the fixture. Recorded with
 * its parameters, per the standing rule against fixture-derived efficacy claims.
 *
 * `rr` is the reciprocal rank (0 when the target never surfaced), so rank = 1/rr. Rows
 * whose target was NOT retrieved are excluded from the mean and counted SEPARATELY —
 * averaging over only the found rows while hiding how many vanished is exactly how a
 * mean-rank "improvement" gets manufactured by losing the hard rows.
 */
export function undatedArmMetrics(details, goldRefs) {
  const gold = new Set(goldRefs ?? []);
  const goldRows = (details ?? []).filter((d) => gold.has(d.target_ref));
  const found = goldRows.filter((d) => (d.rr ?? 0) > 0);
  const ranks = found.map((d) => 1 / d.rr);

  return {
    g2: {
      metric: 'recall@5 over the undated-gold subset',
      value: goldRows.length === 0 ? null : mean(goldRows.map((d) => d.recallByK?.[5] ?? 0)),
      rows: goldRows.length,
    },
    g1: {
      metric: 'mean rank of the undated cohort (REPORTED, not gated)',
      meanRank: ranks.length === 0 ? null : mean(ranks),
      rowsRanked: found.length,
      rowsUnranked: goldRows.length - found.length,
    },
    headroom: headroomFromDetails(goldRows),
  };
}

/**
 * How much further demotion each gold hit could absorb before falling out of the top-k.
 *
 * WHY THIS IS REPORTED. A recall of 1.0 is not self-interpreting: it can mean "the policy is
 * harmless" or "this fixture cannot express the failure mode". The ratio between a hit score
 * and the weakest score still inside the window is what separates them. If the smallest
 * headroom is still larger than the policy's own demotion, the gate CANNOT fail and a pass
 * carries no information — better to say so than to report a bare 1.0.
 *
 * Needs `topScores`, which recallPass captures only when asked (default off).
 */
export function headroomFromDetails(rows) {
  // MIRRORS UNDATED_EFOLDINGS = 0.25 (lib/ranking.mjs, PR C). Hardcoded because this
  // branch merges BEFORE the constant exists on main; switch to `1 / UNDATED_FACTOR`
  // once both PRs are in, so a future retune cannot silently stale this report. The
  // 2026-08-07 run artifacts carry policyDemotion 2.718 — captured at the pre-retune
  // constant, historically accurate, deliberately not rewritten.
  const policyDemotion = 1 / Math.exp(-0.25);
  const ratios = [];
  for (const r of rows ?? []) {
    const scores = r.topScores;
    const rank = (r.rr ?? 0) > 0 ? Math.round(1 / r.rr) : null;
    if (!Array.isArray(scores) || rank === null) continue;
    const hit = scores[rank - 1];
    const weakest = scores.filter((v) => typeof v === 'number').at(-1);
    if (typeof hit !== 'number' || typeof weakest !== 'number' || weakest <= 0) continue;
    ratios.push(hit / weakest);
  }
  if (ratios.length === 0) return { rows: 0, median: null, min: null, policyDemotion, note: 'no scores captured' };
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const cannotFail = sorted[0] > policyDemotion;
  return {
    metric: 'hit score / weakest in-window score — how much demotion the hit could absorb',
    rows: ratios.length,
    median,
    min: sorted[0],
    policyDemotion,
    atCeiling: cannotFail,
    note: cannotFail
      ? 'every gold could absorb MORE than the policy applies — the gate cannot fail on this fixture'
      : 'at least one gold is within the policy demotion of dropping out — the gate can discriminate',
  };
}

export async function seedCorpus({ umAdd, memory, client, rows, latency, metrics }) {
  const seeds = []; // { eval_ref, text, lane, writeId, event }
  for (const row of rows) {
    for (let i = 0; i < row.seed_facts.length; i++) {
      const f = row.seed_facts[i];
      const eval_ref = `${row.id}:${i}`;
      const res = await recordTimed(latency.umAdd, () => umAdd({
        memory, text: f.text, userId: EVAL_USER, infer: false, surface: 'eval',
        // valid_from pass-through for the back-dated cohort. A seed fact WITHOUT one
        // yields a metadata object identical to before — the default rows (and therefore
        // the nightly drift gate) must not move. See backdatedIso: it must be a STRING.
        metadata: { eval_ref, lane: f.lane, ...(f.valid_from !== undefined ? { valid_from: f.valid_from } : {}) }, _qdrantClient: client, metrics,
      }));
      const r0 = res.results?.[0] ?? {};
      seeds.push({ eval_ref, text: f.text, lane: f.lane, writeId: r0.id, event: r0.event });
    }
  }
  const mergedCount = seeds.filter((s) => s.event === 'DEDUP_MERGED').length;
  const distinctIdCount = new Set(seeds.map((s) => s.writeId)).size;
  return { seeds, mergedCount, distinctIdCount };
}

/**
 * Recall pass: per query, run the REAL doSearch (ctx.memory REQUIRED — else it reads the
 * module default collection), join results→target by the captured write-id, score
 * recall@k + RR. Twin-collision flag (review G3): a row whose target has a non-target
 * seed within TWIN_COSINE is excluded from the collision-excluded aggregate.
 */
export async function recallPass({ doSearch, embed, cosineStrict, NOOP_METRICS, memory, rows, seeds, ks, cost, latency, measurePressure = false, captureScores = false }) {
  const byRef = new Map(seeds.map((s) => [s.eval_ref, s]));

  // Embed seed texts once (real embedder) for twin-collision detection.
  const vecByRef = new Map();
  for (const s of seeds) {
    const r = await embed(s.text, { metrics: NOOP_METRICS });
    vecByRef.set(s.eval_ref, r.vector);
    cost.embedTokensIn += r.tokensIn ?? 0;
    cost.embedTokensOut += r.tokensOut ?? 0;
    cost.embedCostUsd += r.costUsd ?? 0;
  }
  // writeId → seed vector (a doSearch result `id` is a writeId, not an eval_ref). Only the
  // pressure read (§4.2a) needs it, so build it just for the measured rung. FIRST-write-wins:
  // under dedup, several seeds can share one writeId, but the stored qdrant point is the FIRST
  // writer (targets seed before distractors) — keep that vector, not a later merged-away one.
  let vecByWriteId = null;
  if (measurePressure) {
    vecByWriteId = new Map();
    for (const s of seeds) {
      if (s.writeId != null && !vecByWriteId.has(s.writeId)) vecByWriteId.set(s.writeId, vecByRef.get(s.eval_ref));
    }
  }
  const hasTwin = (targetRef) => {
    const tv = vecByRef.get(targetRef);
    if (!tv) return false;
    for (const s of seeds) {
      if (s.eval_ref === targetRef) continue;
      if (cosineStrict(tv, vecByRef.get(s.eval_ref)) >= TWIN_COSINE) return true;
    }
    return false;
  };

  const perQuery = [];
  const perQueryNoTwin = [];
  const reciprocalRanks = [];
  const perQueryNdcg = [];
  const details = [];
  for (const row of rows) {
    const target = byRef.get(row.target_ref);
    const targetIds = target?.writeId ? [target.writeId] : [];
    const sr = await recordTimed(latency.doSearch, () => doSearch(row.query, 10, false, true, { memory }));
    const rankedIds = (sr.results ?? []).map((r) => r.id);
    const rk = recallAtK(rankedIds, targetIds, ks);
    const rr = reciprocalRank(rankedIds, targetIds);
    const nd = ndcgAtK(rankedIds, targetIds, ks);
    const twin = hasTwin(row.target_ref);
    perQuery.push(rk);
    if (!twin) perQueryNoTwin.push(rk);
    reciprocalRanks.push(rr);
    perQueryNdcg.push(nd);

    // Pressure read (§4.2a, measured rung only): how close did the best NON-target result
    // sit to the query vs the target itself? Requires a query embed (mem0.search's internal
    // query-embed is opaque). bestNonTargetCos walks the retrieved ids (cosine-ranked, so the
    // top non-target is the max) against the seed vectors keyed by writeId.
    let targetCos = null;
    let bestNonTargetCos = null;
    if (measurePressure && target?.writeId != null) {
      const qr = await embed(row.query, { metrics: NOOP_METRICS });
      cost.embedTokensIn += qr.tokensIn ?? 0;
      cost.embedTokensOut += qr.tokensOut ?? 0;
      cost.embedCostUsd += qr.costUsd ?? 0;
      const tv = vecByWriteId.get(target.writeId);
      if (tv) targetCos = cosineStrict(qr.vector, tv);
      for (const id of rankedIds) {
        if (id === target.writeId) continue;
        const v = vecByWriteId.get(id);
        if (!v) continue;
        const c = cosineStrict(qr.vector, v);
        if (bestNonTargetCos === null || c > bestNonTargetCos) bestNonTargetCos = c;
      }
    }
    details.push({ id: row.id, query: row.query, target_ref: row.target_ref, paraphrase_level: row.paraphrase_level, rank1: rk[1], recallByK: rk, rr, ndcgByK: nd, twin, topIds: rankedIds.slice(0, 5), targetCos, bestNonTargetCos,
      // Opt-in ONLY (default off) so the nightly gate's artifact shape is unchanged. The
      // undated arm needs post-decay scores to compute how much demotion a hit could absorb
      // before dropping out of top-k — a recall of 1.0 says nothing about margin.
      ...(captureScores ? { topScores: (sr.results ?? []).slice(0, 5).map((r) => r.score ?? null) } : {}) });
  }

  return {
    ks,
    queryCount: rows.length,
    aggregate: aggregateRecall(perQuery, ks),
    collisionExcludedAggregate: aggregateRecall(perQueryNoTwin, ks),
    twinFlagged: rows.length - perQueryNoTwin.length,
    mrr: mrr(reciprocalRanks),
    ndcg: aggregateRecall(perQueryNdcg, ks),  // generic per-k mean — same helper as recall
    details,
  };
}

/**
 * Staleness pass: reproduce the production session-end demotion per row, in ISOLATION
 * (the collection is cleared before each row so same-lane rows can't cross-contaminate).
 * seed original+updated → real detector → real supersedePoint (if fired) → real doSearch.
 */
async function stalenessPass({ umAdd, doSearch, detectContradictionsInBatch, supersedePoint, memory, client, collection, rows, latency, metrics }) {
  const perRow = [];
  for (const row of rows) {
    await clearPoints(client, collection); // clear between rows → isolation (no recreate race)

    const o = await recordTimed(latency.umAdd, () => umAdd({ memory, text: row.original_fact, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client, metrics }));
    const u = await recordTimed(latency.umAdd, () => umAdd({ memory, text: row.updated_fact, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client, metrics }));
    const originalId = o.results?.[0]?.id;
    const updatedId = u.results?.[0]?.id;
    const updatedEvent = u.results?.[0]?.event; // ADD | SUPERSEDED_INBAND | DEDUP_MERGED

    // Supersession can fire via EITHER path: in-band at seed time (cosine ∈ [0.84,0.87])
    // OR the session-end detector (the broad path for entity-swaps below 0.84). A row
    // counts toward stale-return only if supersession actually fired by EITHER path; a
    // DEDUP_MERGED updated-seed means the update was merged away (a supersession-recall
    // miss, not a stale-return) → fired stays false.
    let fired = false;
    let firedPath = null;
    let supersededTarget = null;
    if (updatedEvent === 'SUPERSEDED_INBAND') {
      fired = true; firedPath = 'inband';
      supersededTarget = u.results?.[0]?.supersededId ?? originalId;
    } else if (updatedEvent === 'ADD') {
      const detected = await detectContradictionsInBatch(row.updated_fact, {
        userId: EVAL_USER, lane: row.lane, collection, client,
        _facts: () => ({ facts: [row.updated_fact] }),
      });
      if (detected.length > 0) {
        fired = true; firedPath = 'detector';
        supersededTarget = detected[0].targetId;
        await supersedePoint({ client, collection, id: detected[0].targetId, supersededBy: detected[0].supersededBy });
      }
    }

    const sr = await recordTimed(latency.doSearch, () => doSearch(row.query, 10, false, true, { memory }));
    const returnedIds = (sr.results ?? []).map((r) => r.id);
    const surfacedOriginal = returnedIds.includes(originalId);

    perRow.push({ id: row.id, lane: row.lane, updatedEvent, fired, firedPath, originalId, updatedId, supersededTarget, surfacedOriginal });
  }
  const firedRows = perRow.filter((r) => r.fired);
  return {
    total: perRow.length,
    fired: firedRows.length,
    fireRate: fireRate(perRow),
    staleReturnRate: staleReturnRate(firedRows),
    perRow,
  };
}

/**
 * Answer-correctness pass (opt-in via --no-answer). Grades doSearch top-1 (body-level,
 * full=true) over the answerable recall queries AND the unanswerable no-answer queries
 * against the already-seeded recall corpus, applying the pinned τ_answer. A zero-results
 * search on an unanswerable query is a correct non-answer (topHitAnswered:false). Parse-fails
 * (grader ok:false) are EXCLUDED from the rate denominators (never silently bias a rate).
 * Deps are injected (gradeAnswer/doSearch) so this is unit-testable without live calls.
 */
export async function answerCorrectnessPass({ gradeAnswer, doSearch, memory, recallRows, noAnswerRows, model, tau, high = Number.POSITIVE_INFINITY }) {
  const gradeTop1 = async (query) => {
    const sr = await doSearch(query, 10, false, true, { memory });
    const top = (sr.results ?? [])[0];
    if (!top) return { topHitAnswered: false, ok: true, skippedHigh: false }; // empty = correct non-answer (eval accounting)
    // Same helper the live memory_search handler calls (spec §4b — one decision function,
    // no second copy). The nightly passes NO `high` → ungated (grade every top-1 = prod
    // reality with the bouncer OFF = the #132 baseline; §4d/§4f no-perturbation). The sweep
    // (sweepBounceGate) passes explicit gates to pin BOUNCER_SCORE_GATE. gradeAnswer is
    // injected (with model) so the grade is a single LLM call per non-skipped query.
    const bounce = await bounceTopHit(query, top, {
      enabled: true, high, tau,
      gradeAnswer: (q, body) => gradeAnswer(q, body, { model }),
    });
    return { topHitAnswered: bounce.answered, ok: bounce.ok, skippedHigh: bounce.skippedHigh === true };
  };
  const answerable = [];
  for (const row of recallRows) answerable.push({ id: row.id, ...(await gradeTop1(row.query)) });
  const noAnswer = [];
  for (const row of noAnswerRows) noAnswer.push({ id: row.id, ...(await gradeTop1(row.query)) });

  const okAnswerable = answerable.filter((r) => r.ok === true);
  const okNoAnswer = noAnswer.filter((r) => r.ok === true);
  const all = [...answerable, ...noAnswer];
  const skipped = all.filter((r) => r.skippedHigh === true).length;
  return {
    answerCorrectness: {
      total: okAnswerable.length,
      correct: okAnswerable.filter((r) => r.topHitAnswered === true).length,
      rate: answerCorrectnessRate(okAnswerable),
    },
    noAnswer: {
      total: okNoAnswer.length,
      leaks: okNoAnswer.filter((r) => r.topHitAnswered === true).length,
      leakRate: rate(okNoAnswer.map((r) => r.topHitAnswered === true)),
      precision: noAnswerPrecision(okNoAnswer),
    },
    bouncer: { high, skipped, skipRate: all.length ? skipped / all.length : 0 },
    answerGrader: { model, tau, parseFails: (answerable.length - okAnswerable.length) + (noAnswer.length - okNoAnswer.length) },
  };
}

/**
 * Gate sweep (exploratory pin). `rows` are pre-collected per-query grades
 * ({answerable, score, answers, confidence, ok}) so the live grader runs ONCE upstream; this
 * re-applies the SAME live decision (bounceTopHit) across the gate grid by injecting each row's
 * pre-collected grade as the grader — never re-implementing the verdict (spec §4b). Pins the
 * LOWEST gate (max skipRate) that holds both floors. Mirrors d3-eval/answer-grader-eval's
 * grade-once-sweep-pure shape.
 */
export async function sweepBounceGate({ rows, grid, tau, floors }) {
  const at = async (high) => {
    let acOk = 0, acCorrect = 0, naOk = 0, naLeak = 0, skipped = 0;
    for (const r of rows) {
      const bounce = await bounceTopHit('', { score: r.score, body: '' }, {
        enabled: true, high, tau,
        gradeAnswer: () => ({ ok: r.ok !== false, answers: r.answers, confidence: r.confidence }),
      });
      if (bounce.ok === false) continue;          // parse-fail excluded (matches the eval)
      if (bounce.skippedHigh) skipped++;
      if (r.answerable) { acOk++; if (bounce.answered) acCorrect++; }
      else { naOk++; if (bounce.answered) naLeak++; }
    }
    return {
      high,
      skipRate: rows.length ? skipped / rows.length : 0,
      answerCorrectness: acOk ? acCorrect / acOk : null,
      noAnswerPrecision: naOk ? (naOk - naLeak) / naOk : null,
    };
  };
  const sweep = [];
  for (const high of grid) sweep.push(await at(high));
  const holds = (s) => s.answerCorrectness !== null && s.noAnswerPrecision !== null
    && s.answerCorrectness >= floors.answerCorrectness && s.noAnswerPrecision >= floors.noAnswerPrecision;
  const passing = sweep.filter(holds).sort((a, b) => a.high - b.high);
  const chosen = passing[0] ?? sweep[sweep.length - 1];
  return { sweep, chosen };
}

// Candidate score-gate grid for the live pin (spec §3/§4e). Covers the band where non-answers
// cluster (0.30–0.45, the parked no-answer-floor data) up through clearly-strong hits.
export const BOUNCER_SWEEP_GRID = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];

/**
 * Collect RAW per-query grades for the gate sweep: grade every top-1 ONCE (doSearch top-1 +
 * gradeAnswer), returning {id, answerable, score, answers, confidence, ok} so sweepBounceGate
 * can re-apply the gate purely across the grid. A zero-result search → score:null (sweepBounceGate
 * treats it as a non-answer). Deps injected (gradeAnswer/doSearch) for offline unit testing.
 */
export async function collectBounceRows({ gradeAnswer, doSearch, memory, recallRows, noAnswerRows, model }) {
  const grade1 = async (query, answerable) => {
    const sr = await doSearch(query, 10, false, true, { memory });
    const top = (sr.results ?? [])[0];
    if (!top) return { answerable, score: null, answers: false, confidence: 0, ok: true };
    const v = await gradeAnswer(query, top.body ?? '', { model });
    return { answerable, score: top.score, answers: v.answers, confidence: v.confidence, ok: v.ok };
  };
  const rows = [];
  for (const r of recallRows) rows.push({ id: r.id, ...(await grade1(r.query, true)) });
  for (const r of noAnswerRows) rows.push({ id: r.id, ...(await grade1(r.query, false)) });
  return rows;
}

/**
 * Resolve a caller's `decay` option to the literal env string. STRICT by design: only
 * boolean `true` or the exact string 'true' enable decay; every other value (undefined,
 * false, 'false', 'TRUE', 1, 'yes', null) normalises to 'false'. This preserves the
 * hermeticity guard the previously-hardcoded 'false' provided — an ambient
 * UM_TEMPORAL_DECAY in the caller's environment must never leak into a run.
 */
export function resolveDecayFlag(decay) {
  return decay === true || decay === 'true' ? 'true' : 'false';
}

/**
 * Run `fn` with UM_TEMPORAL_DECAY pinned to the resolved value, then DELETE the variable.
 * Deleting rather than restoring is deliberate: a second runOnce/runCorpusSweep in the
 * same process must not inherit a previous run's decay setting. The write happens BEFORE
 * `fn` so the lazy imports inside it capture the pinned value (review B1 / G2), and the
 * `finally` runs even when `fn` throws.
 *
 * In-process hygiene ONLY — a Node process cannot mutate its parent's environment. This
 * does not substitute for the standing rule that UM_TEMPORAL_DECAY is never written to
 * `.env`: a stale 'true' there makes every later reaction-gate run refuse.
 *
 * NOT RE-ENTRANT — do not nest. Because the `finally` DELETES rather than restores, an
 * inner call clears the OUTER pin when it returns, so everything after it in the outer
 * scope silently runs with decay OFF. A two-arm harness must therefore pass `decay`
 * down into each run call (runOnce({ decay })), never wrap a group of runs in one
 * outer withDecayEnv.
 *
 * NOT CONCURRENCY-SAFE either — run the arms SEQUENTIALLY. `process.env` is
 * process-global, so `Promise.all([runOnce({decay:true}), runOnce({decay:false})])`
 * has the second pin clobber the first, and whichever settles first deletes the
 * variable out from under the other. The read path reads the flag per search at call
 * time, so the loser silently executes the wrong arm while recording the right one.
 * Both hazards are pinned by tests in mq-eval-decay-param.test.mjs.
 */
export async function withDecayEnv(decay, fn) {
  const resolved = resolveDecayFlag(decay);
  process.env.UM_TEMPORAL_DECAY = resolved;
  try {
    return await fn(resolved);
  } finally {
    delete process.env.UM_TEMPORAL_DECAY;
  }
}

/**
 * The `flags` block recorded in a run result. UM_TEMPORAL_DECAY is derived from the SAME
 * resolver `withDecayEnv` writes, so the value RECORDED cannot drift from the value the
 * run actually executed under.
 */
export function evalRunFlags({ decay, autosupersede = 'true' } = {}) {
  return {
    UM_DEDUP_ENABLED: 'true',
    UM_AUTOSUPERSEDE_ENABLED: autosupersede,
    UM_LANE_CLASSIFIER_ENABLED: 'true',
    UM_TEMPORAL_DECAY: resolveDecayFlag(decay),
  };
}

/**
 * One full eval run against LIVE qdrant. Pins MEM0_USER_ID + flags BEFORE the lazy
 * import (USER_ID is captured at mem0-mcp-http import time — review B1). Isolated to
 * uniquely-named scratch collections; try/finally teardown + `memories` integrity assert.
 *
 * Thin wrapper: the body runs inside `withDecayEnv` so UM_TEMPORAL_DECAY is pinned from
 * the resolved `decay` option for the whole run and cleared afterwards.
 *
 * @param {{recallRows:Array, stalenessRows:Array, noAnswerRows:Array, runid?:string,
 *          recallFixturePath?:string, stalenessFixturePath?:string, noAnswerFixturePath?:string,
 *          decay?:boolean|string}} args
 */
export async function runOnce(args = {}) {
  // Pass the RESOLVED value down — never let the inner frame re-derive it. Two
  // independent derivations of the same flag can drift silently, and the one that lands
  // in `flags` is the artifact of record.
  return withDecayEnv(args.decay, (resolved) => runOnceDecayPinned({ ...args, decay: resolved }));
}

async function runOnceDecayPinned({ recallRows = [], stalenessRows = [], noAnswerRows = [], runid, recallFixturePath, stalenessFixturePath, noAnswerFixturePath, sweep = false, decay }) {
  // --- pin env BEFORE any import that captures it (review B1 / G2) ---
  // UM_TEMPORAL_DECAY is pinned by withDecayEnv one frame up, and cleared when it returns.
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_DEDUP_ENABLED = 'true';
  process.env.UM_AUTOSUPERSEDE_ENABLED = 'true';
  process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';

  // --- lazy imports (none touch an SDK at module top) ---
  const { Memory } = await import('mem0ai/oss');
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const { umAdd } = await import('../lib/add.mjs');
  const { doSearch } = await import('../mem0-mcp-http.mjs');
  const { detectContradictionsInBatch } = await import('../lib/contradiction-batch.mjs');
  const { supersedePoint } = await import('../lib/supersede.mjs');
  const { embed, getEmbedderConfig } = await import('../lib/embed.mjs');
  const { getFactsLlmConfig } = await import('../lib/facts.mjs');
  const { NOOP_METRICS, umAnswerGradedTotal } = await import('../lib/metrics.mjs');
  const { cosineStrict } = await import('../lib/vector.mjs');

  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
  const client = new QdrantClient({ host, port });

  const rid = runid ?? `${process.pid}`;
  const recallCol = `${SCRATCH_PREFIX}recall_${isoDate()}_${rid}`;
  const stalenessCol = `${SCRATCH_PREFIX}stale_${isoDate()}_${rid}`;
  assertScratchSafe(recallCol);
  assertScratchSafe(stalenessCol);

  const makeMemory = (collectionName) => new Memory({
    embedder: getEmbedderConfig(process.env),
    llm: getFactsLlmConfig(process.env),
    vectorStore: { provider: 'qdrant', config: { host, port, collectionName } },
  });

  const cost = { embedTokensIn: 0, embedTokensOut: 0, embedCostUsd: 0 };
  const latency = { umAdd: [], doSearch: [] };
  const writeCostSink = makeProviderCostSink();
  const memoriesBefore = await countPoints(client, 'memories');

  let recall = null;
  let staleness = null;
  let seedInfo = null;
  let answerGrading = null;
  let bouncerSweep = null;
  try {
    if (recallRows.length > 0) {
      await ensureCollection(client, recallCol, VECTOR_DIM);
      const recallMemory = makeMemory(recallCol);
      seedInfo = await seedCorpus({ umAdd, memory: recallMemory, client, rows: recallRows, latency, metrics: writeCostSink });
      recall = await recallPass({ doSearch, embed, cosineStrict, NOOP_METRICS, memory: recallMemory, rows: recallRows, seeds: seedInfo.seeds, ks: [1, 3, 5, 10], cost, latency });
      recall.seedCount = seedInfo.seeds.length;
      recall.mergedCount = seedInfo.mergedCount;
      recall.distinctIdCount = seedInfo.distinctIdCount;
      recall.byParaphraseLevel = recallByParaphraseLevel(recall.details, [1, 3, 5, 10]);

      // Answer-correctness pass (opt-in via --no-answer): grade doSearch top-1 over the
      // answerable recall queries + the unanswerable no-answer queries against the seeded
      // corpus, using the pinned τ_answer. Needs the LLM grader; runs only with a corpus.
      if (noAnswerRows.length > 0) {
        const { gradeAnswer } = await import('../lib/answer-grader.mjs');
        const { TAU_ANSWER } = await import('./answer-grader-eval.mjs');
        const agModel = process.env.UM_ANSWER_GRADER_MODEL ?? 'gpt-4o-mini';
        if (sweep) {
          // Manual gate-pin run (--sweep): grade every top-1 ONCE, then sweep the cost gate
          // over the grid to pin BOUNCER_SCORE_GATE. Skips the nightly answerCorrectnessPass
          // (no double-grading). floors mirror the mq gate (answerCorrectness>=0.78, noAnswerPrecision>=0.95).
          const rows = await collectBounceRows({ gradeAnswer, doSearch, memory: recallMemory, recallRows, noAnswerRows, model: agModel });
          bouncerSweep = { ...(await sweepBounceGate({ rows, grid: BOUNCER_SWEEP_GRID, tau: TAU_ANSWER, floors: { answerCorrectness: 0.78, noAnswerPrecision: 0.95 } })), rows };
        } else {
          // UNGATED on purpose: nightly measures prod-with-bouncer-OFF answer-correctness (the
          // #132 baseline); the cost gate is pinned separately (--sweep) + applied at the flip.
          answerGrading = await answerCorrectnessPass({ gradeAnswer, doSearch, memory: recallMemory, recallRows, noAnswerRows, model: agModel, tau: TAU_ANSWER });
          const ag = answerGrading;
          umAnswerGradedTotal.inc({ outcome: 'answers' }, ag.answerCorrectness.correct + ag.noAnswer.leaks);
          umAnswerGradedTotal.inc({ outcome: 'declines' }, (ag.answerCorrectness.total - ag.answerCorrectness.correct) + (ag.noAnswer.total - ag.noAnswer.leaks));
          umAnswerGradedTotal.inc({ outcome: 'parse_fail' }, ag.answerGrader.parseFails);
        }
      }
    }
    if (stalenessRows.length > 0) {
      await ensureCollection(client, stalenessCol, VECTOR_DIM); // create BEFORE makeMemory (avoid auto-create race)
      const stalenessMemory = makeMemory(stalenessCol);
      staleness = await stalenessPass({ umAdd, doSearch, detectContradictionsInBatch, supersedePoint, memory: stalenessMemory, client, collection: stalenessCol, rows: stalenessRows, latency, metrics: writeCostSink });
    }
  } finally {
    await dropCollectionQuiet(client, recallCol).catch((e) => console.error('[mq-eval] recall teardown:', e?.message));
    await dropCollectionQuiet(client, stalenessCol).catch((e) => console.error('[mq-eval] staleness teardown:', e?.message));
  }

  // Isolation integrity (success path): the real collection must be untouched.
  const memoriesAfter = await countPoints(client, 'memories');
  if (memoriesBefore != null && memoriesAfter !== memoriesBefore) {
    throw new Error(`mq-eval ISOLATION VIOLATION: 'memories' point-count changed ${memoriesBefore} → ${memoriesAfter}`);
  }

  const provider = process.env.UM_EMBEDDING_PROVIDER ?? 'openai';
  const model = process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small (provider default)';
  const fixtureRev = md5Hex(JSON.stringify({ recallRows, stalenessRows }));

  return {
    timestamp: new Date().toISOString(),
    provider, model, fixtureRev,
    evalUser: EVAL_USER,
    flags: evalRunFlags({ decay }),
    env: { node: process.version, platform: process.platform },
    fixtures: { recall: recallFixturePath ?? '(inline)', staleness: stalenessFixturePath ?? '(inline)', noAnswer: noAnswerFixturePath ?? '(none)' },
    recall,
    staleness,
    answerCorrectness: answerGrading?.answerCorrectness ?? null,
    noAnswer: answerGrading?.noAnswer ?? null,
    answerGrader: answerGrading?.answerGrader ?? null,
    bouncerSweep,
    latency: {
      umAdd: summarizeLatency(latency.umAdd),
      doSearch: summarizeLatency(latency.doSearch),
    },
    cost: {
      write: writeCostSink.totals,
      evalEmbed: { tokensIn: cost.embedTokensIn, tokensOut: cost.embedTokensOut, costUsd: cost.embedCostUsd },
      note: 'write = umAdd extract+embed (sink-captured; infer:false here → embed only). read query-embed is internal to mem0.search (not separately metered); judge/grader cost is available via return-usage in the opt-in answer pass — both out of this baseline cut.',
    },
  };
}

/**
 * Corpus-size sweep (#14): re-run the recall pass over a GROWING synthetic-distractor
 * corpus and record recall (raw + collision-excluded) + MRR + nDCG + latency + cost vs
 * EFFECTIVE N (seedInfo.distinctIdCount — the true post-dedup size). Distractors are
 * fixture-lane-driven so they compete by semantic proximity (doSearch is global); dedup
 * stays ON (prod-faithful) so effectiveN — not requestedN — tells the truth. ALL seeds
 * (targets + distractors) feed recallPass so the twin guard (§5.3) and the top-rung
 * pressure read (§4.2a) see the distractor vectors. LIVE layer — no unit test; verified
 * by self-read + the formatCorpusSweep render test + the operator's keyed run (the
 * harness's no-live-calls contract). Scratch-isolated; 'memories' asserted untouched.
 *
 * Like runOnce, the body runs inside `withDecayEnv`, so UM_TEMPORAL_DECAY is pinned from
 * the resolved `decay` option for the whole sweep and cleared afterwards. Read
 * withDecayEnv's contract before calling this with `decay: true` — it is neither
 * re-entrant nor concurrency-safe, so arms must run sequentially.
 *
 * @param {{recallRows:Array, sweepSizes?:Array<number>, seed?:number, runid?:string,
 *          decay?:boolean|string}} args
 */
export async function runCorpusSweep(args = {}) {
  // Resolved value passed down — see runOnce.
  return withDecayEnv(args.decay, (resolved) => runCorpusSweepDecayPinned({ ...args, decay: resolved }));
}

async function runCorpusSweepDecayPinned({ recallRows = [], sweepSizes, seed = 0, runid, decay }) {
  // --- pin env BEFORE the lazy imports capture it (mirror runOnce) ---
  // UM_TEMPORAL_DECAY is pinned by withDecayEnv one frame up, and cleared when it returns.
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_DEDUP_ENABLED = 'true';            // prod-faithful: effectiveN tells the truth
  process.env.UM_AUTOSUPERSEDE_ENABLED = 'false';   // OFF for the sweep: synthetic distractors self-contradict in the dedup band, and targets seed FIRST (oldest) → autosupersede would DEMOTE real targets, confounding recall. The sweep grows the corpus via dedup only (spec pins dedup, not supersession). Confirmed by the 2026-06-25 dry run.
  process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';

  const { Memory } = await import('mem0ai/oss');
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const { umAdd } = await import('../lib/add.mjs');
  const { doSearch } = await import('../mem0-mcp-http.mjs');
  const { embed, getEmbedderConfig } = await import('../lib/embed.mjs');
  const { getFactsLlmConfig } = await import('../lib/facts.mjs');
  const { NOOP_METRICS } = await import('../lib/metrics.mjs');
  const { cosineStrict } = await import('../lib/vector.mjs');
  const { lanesFromRows, generateDistractors } = await import('./lib/corpus-distractors.mjs');

  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
  const client = new QdrantClient({ host, port });
  const makeMemory = (collectionName) => new Memory({
    embedder: getEmbedderConfig(process.env),
    llm: getFactsLlmConfig(process.env),
    vectorStore: { provider: 'qdrant', config: { host, port, collectionName } },
  });

  const targetCount = recallRows.reduce((n, r) => n + (r.seed_facts?.length ?? 0), 0);
  const lanes = lanesFromRows(recallRows);
  const EXACT_THRESHOLD = 20000;                     // qdrant indexing_threshold default → exact search below it
  // requestedN is TOTAL corpus size, floored at targetCount; de-duped + sorted ascending.
  const sizes = [...new Set((sweepSizes ?? [66, 200, 500, 1000]).map((n) => Math.max(n, targetCount)))].sort((a, b) => a - b);
  const topRung = sizes[sizes.length - 1];
  const rid = runid ?? `${process.pid}`;
  const memoriesBefore = await countPoints(client, 'memories');

  const rows = [];
  let pressure = { inert: true, meanTargetCos: null, meanBestDistractorCos: null };
  for (const requestedN of sizes) {
    const col = `${SCRATCH_PREFIX}corpus_${isoDate()}_${rid}_${requestedN}`;
    assertScratchSafe(col);
    const latency = { umAdd: [], doSearch: [] };
    const cost = { embedTokensIn: 0, embedTokensOut: 0, embedCostUsd: 0 };
    const writeCostSink = makeProviderCostSink();
    try {
      await ensureCollection(client, col, VECTOR_DIM);
      const memory = makeMemory(col);
      const distractors = generateDistractors(requestedN - targetCount, { seed, lanes });
      const seedRows = [
        ...recallRows,
        ...distractors.map((d, i) => ({ id: `distractor:${i}`, seed_facts: [{ text: d.text, lane: d.lane }] })),
      ];
      const seedInfo = await seedCorpus({ umAdd, memory, client, rows: seedRows, latency, metrics: writeCostSink });
      const recall = await recallPass({
        doSearch, embed, cosineStrict, NOOP_METRICS, memory,
        rows: recallRows, seeds: seedInfo.seeds, ks: [1, 3, 5, 10], cost, latency,
        measurePressure: requestedN === topRung,
      });
      rows.push({
        requestedN,
        effectiveN: seedInfo.distinctIdCount,
        dedupCollapsed: requestedN - seedInfo.distinctIdCount,
        dedupSaturated: dedupSaturated(requestedN, seedInfo.distinctIdCount),
        exactSearch: requestedN < EXACT_THRESHOLD,
        recall: {
          aggregate: recall.aggregate,
          collisionExcludedAggregate: recall.collisionExcludedAggregate,
          twinFlagged: recall.twinFlagged,
          guardSaturated: guardSaturated(recall.twinFlagged, recall.queryCount),
          mrr: recall.mrr,
          ndcg: recall.ndcg,
        },
        latency: { umAdd: summarizeLatency(latency.umAdd), doSearch: summarizeLatency(latency.doSearch) },
        cost: { write: writeCostSink.totals, evalEmbed: { tokensIn: cost.embedTokensIn, tokensOut: cost.embedTokensOut, costUsd: cost.embedCostUsd } },
      });
      if (requestedN === topRung) pressure = computePressure(recall);
    } finally {
      await dropCollectionQuiet(client, col).catch((e) => console.error('[mq-eval] corpus teardown:', e?.message));
    }
  }

  const memoriesAfter = await countPoints(client, 'memories');
  if (memoriesBefore != null && memoriesAfter !== memoriesBefore) {
    throw new Error(`mq-eval ISOLATION VIOLATION (corpus sweep): 'memories' point-count changed ${memoriesBefore} → ${memoriesAfter}`);
  }

  const provider = process.env.UM_EMBEDDING_PROVIDER ?? 'openai';
  const model = process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small (provider default)';
  return {
    timestamp: new Date().toISOString(),
    provider, model, evalUser: EVAL_USER,
    flags: evalRunFlags({ decay, autosupersede: 'false' }),
    env: { node: process.version, platform: process.platform },
    corpusSweep: { seed, targetCount, sizes, exactSearchThreshold: EXACT_THRESHOLD, pressure, rows },
  };
}

/**
 * Storage & index growth (#19). Seeds N SYNTHETIC points (seeded unit vectors + a payload that
 * replicates add.mjs buildPayload) DIRECTLY into a scratch collection — bypassing umAdd/embeddings,
 * so this runs with NO API keys, only a local Docker qdrant. A size measurement is content-
 * independent, so faithfulness lives in payload-schema + collection-config parity (qdrant defaults,
 * Cosine, prod dim), not the write path; dedup is bypassed by construction so the corpus reaches
 * EXACTLY N. Sweep straddles the 20000 indexing threshold to capture the HNSW-onset knee.
 * LIVE layer — no unit test; scratch-isolated; 'memories' asserted untouched.
 */
export async function runStorageSweep({ recallRows = [], storageSizes, dim = VECTOR_DIM, seed = 0, runid } = {}) {
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const { randomUUID } = await import('node:crypto');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  const { lanesFromRows, generateDistractors } = await import('./lib/corpus-distractors.mjs');
  const {
    vectorBytes, indexed, hnswGraphBytes, projectFootprint,
    buildSyntheticPayload, payloadBytes, makeRandomUnitVector,
    DEFAULT_INDEXING_THRESHOLD, DEFAULT_HNSW_M,
  } = await import('./lib/storage-model.mjs');

  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
  const client = new QdrantClient({ host, port });

  const lanes = lanesFromRows(recallRows);
  if (lanes.length === 0) throw new Error('runStorageSweep: no lanes from --recall fixture (need synthetic text source)');
  const THRESHOLD = DEFAULT_INDEXING_THRESHOLD;
  const HNSW_M = DEFAULT_HNSW_M;
  const sizes = [...new Set((storageSizes ?? [1000, 10000, 20000, 30000, 50000]))].sort((a, b) => a - b);
  if (sizes.length === 0 || sizes[sizes.length - 1] <= 0) throw new Error('runStorageSweep: storageSizes must contain at least one positive size');
  const rid = runid ?? `${process.pid}`;
  const storagePath = process.env.UM_QDRANT_STORAGE_PATH; // host-visible qdrant storage dir, else disk = null

  // Representative synthetic text pool (cycled) → realistic payload bytes without 50k strings.
  const pool = generateDistractors(Math.min(Math.max(...sizes), 2000), { seed, lanes });
  const payloadBytesPerPoint = Math.round(
    pool.reduce((s, d) => s + payloadBytes(buildSyntheticPayload({ text: d.text, lane: d.lane, userId: EVAL_USER, index: 0 })), 0) / pool.length,
  );

  const memoriesBefore = await countPoints(client, 'memories');
  const rows = [];
  for (const requestedN of sizes) {
    const col = `${SCRATCH_PREFIX}storage_${isoDate()}_${rid}_${requestedN}`;
    assertScratchSafe(col);
    try {
      await ensureCollection(client, col, dim); // qdrant defaults (Cosine, in-RAM vectors) — prod-faithful

      // --- direct batched seed (dedup bypassed → exactly N) ---
      const BATCH = 1000;
      for (let i = 0; i < requestedN; i += BATCH) {
        const points = [];
        for (let j = i; j < Math.min(i + BATCH, requestedN); j++) {
          const d = pool[j % pool.length];
          points.push({
            id: randomUUID(),
            vector: makeRandomUnitVector(dim, j + seed * 1_000_000),
            payload: buildSyntheticPayload({ text: d.text, lane: d.lane, userId: EVAL_USER, index: j }),
          });
        }
        await client.upsert(col, { wait: true, points });
      }

      // --- settle: wait for optimizers to finish before measuring. qdrant reports
      // 'green' (idle) or 'grey' (optimizers possible-but-not-triggered — e.g. a
      // sub-threshold collection) as quiescent and measurable; 'yellow' = optimizing.
      // Tolerate transient getCollection errors (retry until the deadline) so a single
      // network blip during a multi-minute live run doesn't discard the whole sweep.
      const deadline = Date.now() + 120_000;
      const settled = (s) => s === 'green' || s === 'grey';
      let info;
      while (Date.now() < deadline) {
        try {
          info = await client.getCollection(col);
          if (settled(info.status)) break;
          if (info.status === 'red') { console.error(`[mq-eval] storage N=${requestedN}: collection status 'red' — measuring anyway`); break; }
        } catch (e) {
          console.error(`[mq-eval] storage settle poll (N=${requestedN}) transient: ${e?.message}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!info) throw new Error(`mq-eval storage N=${requestedN}: getCollection unavailable through the 120s settle window`);

      // --- measure ---
      let measuredDiskBytes = null;
      if (storagePath) {
        try {
          const { stdout } = await execFileP('du', ['-sb', `${storagePath}/collections/${col}`]);
          const n = parseInt(stdout.trim().split(/\s+/)[0], 10);
          if (Number.isFinite(n)) measuredDiskBytes = n;
        } catch { measuredDiskBytes = null; } // channel unavailable in this env → model stands alone
      }

      const pointsCount = info.points_count ?? 0;
      const indexedVectors = info.indexed_vectors_count ?? 0;
      const projected = projectFootprint({ n: requestedN, dim, payloadBytesPerPoint, hnswM: HNSW_M, threshold: THRESHOLD });
      const idxOverhead = indexed(requestedN, THRESHOLD) ? Math.round(hnswGraphBytes(requestedN, HNSW_M) / requestedN) : 0;
      rows.push({
        requestedN,
        pointsCount,
        seedIncomplete: pointsCount !== requestedN,
        segments: info.segments_count ?? null,
        indexedVectors,
        indexedRegime: indexedVectors > 0 ? 'hnsw' : 'flat',  // MEASURED regime
        vectorBytes: vectorBytes(requestedN, dim),
        payloadBytesPerPoint,
        measuredDiskBytes,
        projected,
        bytesPerFact: { vector: dim * 4, payload: payloadBytesPerPoint, indexOverhead: idxOverhead, total: dim * 4 + payloadBytesPerPoint + idxOverhead },
      });
    } finally {
      await dropCollectionQuiet(client, col).catch((e) => console.error('[mq-eval] storage teardown:', e?.message));
    }
  }

  // Faithfulness: the smallest rung MUST reach exactly N (direct upsert, no dedup) — §4.2a.
  const smallest = rows.reduce((m, r) => (r.requestedN < m.requestedN ? r : m), rows[0]);
  if (smallest && smallest.pointsCount !== smallest.requestedN) {
    throw new Error(`mq-eval storage FAITHFULNESS: smallest rung N=${smallest.requestedN} stored ${smallest.pointsCount} points (expected exact)`);
  }

  const memoriesAfter = await countPoints(client, 'memories');
  if (memoriesBefore != null && memoriesAfter !== memoriesBefore) {
    throw new Error(`mq-eval ISOLATION VIOLATION (storage sweep): 'memories' point-count changed ${memoriesBefore} → ${memoriesAfter}`);
  }

  const piRow = rows.find((r) => r.requestedN === 50000) ?? rows[rows.length - 1];
  return {
    timestamp: new Date().toISOString(),
    evalUser: EVAL_USER,
    env: { node: process.version, platform: process.platform, qdrantStoragePath: storagePath ?? null },
    storageSweep: {
      dim, hnswM: HNSW_M, indexingThreshold: THRESHOLD, distance: 'Cosine', payloadBytesPerPoint, seed,
      rows,
      piProjection: piRow ? { atN: piRow.requestedN, ramBytesProjected: piRow.projected.ramBytes, note: 'projected qdrant RAM (vectors + HNSW); qdrant process baseline additive' } : null,
    },
  };
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// CLI shim — one invocation = one run (mirror d1/d3/lane; run twice for stability).
// ---------------------------------------------------------------------------

async function cliMain() {
  const args = parseArgs(process.argv);

  // Undated-arm measurement (its OWN fixture, OWN scratch collection, OWN entry point —
  // the shared corpus and the nightly drift gate are deliberately untouched by this path).
  // Returns early; never reads the shared `thresholds` floors (those describe the default
  // corpus). With --gate it evaluates `undatedThresholds` ONLY — the subset floor derived
  // from the committed before-arm run and pinned under its own key (plan Task 7.3).
  if (args.undatedArm) {
    // Pin BEFORE the lazy imports: doSearch captures USER_ID at import time (review B1).
    // UM_TEMPORAL_DECAY is deliberately NOT set here — runUndatedArm pins it in-process and
    // clears it after. Writing it to the environment (or .env) is what would make every
    // later reaction-gate run refuse.
    process.env.MEM0_USER_ID = EVAL_USER;
    process.env.UM_DEDUP_ENABLED = 'true';
    // OFF, for the same reason runCorpusSweep pins it off: the synthetic distractors
    // self-contradict in the dedup band, and the FIXTURE rows seed FIRST (so they are the
    // OLDEST) — autosupersede would retire real cohort targets in favour of a template-
    // generated distractor, and a superseded point is filtered out of search entirely.
    // Observed live on the 2026-08-07 run before this was pinned: five in-band supersessions.
    process.env.UM_AUTOSUPERSEDE_ENABLED = 'false';
    process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';

    const { Memory } = await import('mem0ai/oss');
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const { umAdd } = await import('../lib/add.mjs');
    const { doSearch } = await import('../mem0-mcp-http.mjs');
    const { embed, getEmbedderConfig } = await import('../lib/embed.mjs');
    const { getFactsLlmConfig } = await import('../lib/facts.mjs');
    const { NOOP_METRICS } = await import('../lib/metrics.mjs');
    const { cosineStrict } = await import('../lib/vector.mjs');
    const { lanesFromRows, generateDistractors } = await import('./lib/corpus-distractors.mjs');

    const rows = await loadFixtureJsonl(args.recall ?? UNDATED_ARM.fixture);
    const host = process.env.QDRANT_HOST ?? 'localhost';
    const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
    const client = new QdrantClient({ host, port });
    const collection = `${SCRATCH_PREFIX}undated_${isoDate()}_${args.seed ?? process.pid}`;

    const memoriesBefore = await countPoints(client, 'memories');
    let result;
    try {
      await ensureCollection(client, collection, VECTOR_DIM);
      const memory = new Memory({
        embedder: getEmbedderConfig(process.env),
        llm: getFactsLlmConfig(process.env),
        vectorStore: { provider: 'qdrant', config: { host, port, collectionName: collection } },
      });
      result = await runUndatedArm({
        rows, collection, decay: true,
        umAdd, memory, client, doSearch, embed, cosineStrict, NOOP_METRICS,
        generateDistractors, lanesFromRows,
      });
    } finally {
      await dropCollectionQuiet(client, collection).catch((e) => console.error('[mq-eval] undated-arm teardown:', e?.message));
    }

    const memoriesAfter = await countPoints(client, 'memories');
    if (memoriesBefore != null && memoriesAfter !== memoriesBefore) {
      throw new Error(`mq-eval ISOLATION VIOLATION: 'memories' point-count changed ${memoriesBefore} → ${memoriesAfter}`);
    }

    const out = args.out ?? join('eval/results', `mq-undated-arm-${isoDate()}-${args.seed ?? process.pid}.json`);
    await writeJson(out, result);
    console.log(`[mq-eval] undated arm written to ${out}`);
    console.log(`  flags        ${JSON.stringify(result.flags)}`);
    console.log(`  seeds        ${result.seedCount} (merged ${result.mergedCount})`);
    console.log(`  cohorts      ${result.fixture.undatedGold} undated-gold / ${result.fixture.dated} dated`);
    console.log(`  corpus       ${result.corpus.effectiveN} effective points (${result.corpus.fixtureSeeds} fixture + ${result.corpus.distractorsRequested} distractors, ${result.corpus.distractorsCollapsed} collapsed)`);
    console.log(`  G2 (GATE)    recall@5 over the undated-gold subset: ${result.g2.value} over ${result.g2.rows} rows`);
    console.log(`  G1 (report)  mean rank ${result.g1.meanRank} (${result.g1.rowsRanked} ranked, ${result.g1.rowsUnranked} unranked)`);
    console.log(`  headroom     median ${result.headroom.median?.toFixed(2)}x, min ${result.headroom.min?.toFixed(2)}x vs the policy ${result.headroom.policyDemotion?.toFixed(2)}x demotion`);
    console.log(`               ${result.headroom.note}`);

    // Subset floor (plan Task 7.3): --gate evaluates the arm against `undatedThresholds`,
    // never the shared `thresholds` block. A gate file WITHOUT the key is refused rather
    // than passed — a floorless gate reading as green is the dead-detector failure §3.3
    // exists to prevent.
    if (args.gate) {
      const config = JSON.parse(await readFile(args.gate, 'utf8'));
      if (!Array.isArray(config.undatedThresholds) || config.undatedThresholds.length === 0) {
        throw new Error('mq-eval undated-arm: --gate file carries no undatedThresholds — refusing a floorless gate');
      }
      const gate = evaluateGate(result, { thresholds: config.undatedThresholds });
      console.log(formatGateReport(gate));
      if (!gate.pass) {
        console.error('UNDATED-ARM GATE FAILED');
        process.exitCode = 1;
      }
    }
    return;
  }

  // Storage & index growth (#19): footprint vs N. NO API key (synthetic vectors, direct upsert);
  // needs a local Docker qdrant + --recall (supplies lanes for realistic synthetic text). Returns early.
  if (args.storageSweep) {
    if (!args.recall) {
      console.error('[mq-eval] --storage-sweep requires --recall <path> (supplies lanes for synthetic text)');
      process.exit(2);
    }
    const recallRows = await loadFixtureJsonl(args.recall);
    const sizes = args.storageSizes ?? [1000, 10000, 20000, 30000, 50000];
    console.log(`[mq-eval] storage sweep: dim=${args.storageDim ?? VECTOR_DIM}, sizes=${sizes.join(',')}, seed=${args.seed ?? 0} — seeding scratch qdrant (no API key; real vault untouched)...`);
    const sweep = await runStorageSweep({ recallRows, storageSizes: args.storageSizes, dim: args.storageDim ?? VECTOR_DIM, seed: args.seed });
    const resultsDir = args.outPrefix ? dirname(args.outPrefix) : args.out ? dirname(args.out) : 'eval/results';
    const out = args.out ?? join(resultsDir, `mq-storage-sweep-${isoDate()}.json`);
    await writeJson(out, sweep);
    console.log(`[mq-eval] Storage sweep written to ${out}`);
    console.log('');
    console.log(formatStorageSweep(sweep));
    return;
  }

  if (!args.recall && !args.staleness) {
    console.error('Usage: memory-quality-eval.mjs --recall <path> [--staleness <path>] [--out <path> | --out-prefix <path>]');
    process.exit(2);
  }

  // Preflight: needs OPENAI_API_KEY (real embed + judge). Try ./.env (Node ≥20.12).
  if (!process.env.OPENAI_API_KEY) {
    try { process.loadEnvFile?.(); } catch { /* no ./.env — fall through */ }
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('[mq-eval] OPENAI_API_KEY not set — run: node --env-file=.env eval/memory-quality-eval.mjs --recall eval/recall-set.jsonl --staleness eval/staleness-set.jsonl');
    process.exit(2);
  }

  const recallRows = args.recall ? await loadFixtureJsonl(args.recall) : [];
  const stalenessRows = args.staleness ? await loadFixtureJsonl(args.staleness) : [];
  const noAnswerRows = args.noAnswer ? await loadFixtureJsonl(args.noAnswer) : [];

  // Corpus-size sweep (#14): recall/latency/cost vs effective N over a growing distractor
  // corpus. Eval-only, never a gate. Returns early (its own result shape + renderer).
  if (args.corpusSweep) {
    if (recallRows.length === 0) {
      console.error('[mq-eval] --corpus-sweep requires --recall <path> (the fixture supplies the targets + lanes)');
      process.exit(2);
    }
    console.log(`[mq-eval] corpus-size sweep: recall rows=${recallRows.length}, sizes=${args.sweepSizes ? args.sweepSizes.join(',') : '66,200,500,1000 (default)'}, seed=${args.seed ?? 0} — running live (scratch collections, real vault untouched)...`);
    const sweep = await runCorpusSweep({ recallRows, sweepSizes: args.sweepSizes, seed: args.seed });
    const resultsDir = args.outPrefix ? dirname(args.outPrefix) : args.out ? dirname(args.out) : 'eval/results';
    const out = args.out ?? join(resultsDir, `mq-corpus-sweep-${isoDate()}.json`);
    await writeJson(out, sweep);
    console.log(`[mq-eval] Corpus sweep written to ${out}`);
    console.log('');
    console.log(formatCorpusSweep(sweep));
    return;
  }

  console.log(`[mq-eval] recall rows=${recallRows.length} staleness rows=${stalenessRows.length} no-answer rows=${noAnswerRows.length} — running live (scratch collections, real vault untouched)...`);

  const result = await runOnce({ recallRows, stalenessRows, noAnswerRows, recallFixturePath: args.recall, stalenessFixturePath: args.staleness, noAnswerFixturePath: args.noAnswer, sweep: args.sweep });

  const resultsDir = args.outPrefix ? dirname(args.outPrefix) : args.out ? dirname(args.out) : 'eval/results';
  const primaryPath = args.out ?? `${args.outPrefix ?? join(resultsDir, 'mq-eval')}-run1.json`;
  const latestPath = join(resultsDir, 'mq-latest.json');
  await writeJson(primaryPath, result);
  await writeJson(latestPath, result);
  console.log(`[mq-eval] Result written to ${primaryPath} and ${latestPath}`);
  console.log('');
  console.log(formatSummaryTable(result));

  if (args.sweep && result.bouncerSweep) {
    console.log('');
    console.log('[mq-eval] BOUNCER GATE SWEEP:');
    for (const s of result.bouncerSweep.sweep) {
      console.log(`  high=${s.high}  skipRate=${s.skipRate?.toFixed(3)}  answerCorrectness=${s.answerCorrectness?.toFixed(3)}  noAnswerPrecision=${s.noAnswerPrecision?.toFixed(3)}`);
    }
    console.log(`[mq-eval] CHOSEN BOUNCER_SCORE_GATE = ${result.bouncerSweep.chosen.high} (skipRate=${result.bouncerSweep.chosen.skipRate?.toFixed(3)})`);
  }

  // Drift gate (opt-in via --gate): compare against committed floors, surface a
  // report (console + CI step summary), exit 1 on any breach. Never weaken floors
  // to make this pass — see docs/plans/2026-06-21-mq-quality-gate-spec.md §6.
  if (args.gate) {
    const config = JSON.parse(await readFile(args.gate, 'utf8'));
    const gate = evaluateGate(result, config);
    const report = formatGateReport(gate);
    console.log('');
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`\n${report}\n\`\`\`\n`);
    }
    if (!gate.pass) {
      console.error('[mq-eval] DRIFT GATE FAILED — fix the regression, or re-pin floors with a committed 2-run re-measurement + rationale. Do NOT silently loosen.');
      process.exit(1);
    }
  }
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  cliMain().catch((e) => {
    // A full OpenAI/mem0 SDK error object can embed request config (the apiKey);
    // public nightly logs are world-readable. Message-only in CI; full object local.
    console.error('[mq-eval] FATAL:', process.env.GITHUB_ACTIONS ? (e?.message ?? e) : e);
    process.exit(1);
  });
}
