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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bounceTopHit } from '../lib/bouncer.mjs';

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

  return lines.join('\n');
}

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
 * Seed the recall corpus: each seed fact → umAdd(infer:false) under EVAL_USER with an
 * eval-only metadata.eval_ref + a pinned lane (review G1). Records the write-returned id
 * per seed. Guards (review G2): surface DEDUP_MERGED and any id-collision.
 */
async function seedCorpus({ umAdd, memory, client, rows }) {
  const seeds = []; // { eval_ref, text, lane, writeId, event }
  for (const row of rows) {
    for (let i = 0; i < row.seed_facts.length; i++) {
      const f = row.seed_facts[i];
      const eval_ref = `${row.id}:${i}`;
      const res = await umAdd({
        memory, text: f.text, userId: EVAL_USER, infer: false, surface: 'eval',
        metadata: { eval_ref, lane: f.lane }, _qdrantClient: client,
      });
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
async function recallPass({ doSearch, embed, cosineStrict, NOOP_METRICS, memory, rows, seeds, ks, cost }) {
  const byRef = new Map(seeds.map((s) => [s.eval_ref, s]));

  // Embed seed texts once (real embedder) for twin-collision detection.
  const vecByRef = new Map();
  for (const s of seeds) {
    const r = await embed(s.text, { metrics: NOOP_METRICS });
    vecByRef.set(s.eval_ref, r.vector);
    cost.embedTokensIn += r.tokensIn ?? 0;
    cost.embedTokensOut += r.tokensOut ?? 0;
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
  const details = [];
  for (const row of rows) {
    const target = byRef.get(row.target_ref);
    const targetIds = target?.writeId ? [target.writeId] : [];
    const sr = await doSearch(row.query, 10, false, true, { memory });
    const rankedIds = (sr.results ?? []).map((r) => r.id);
    const rk = recallAtK(rankedIds, targetIds, ks);
    const rr = reciprocalRank(rankedIds, targetIds);
    const twin = hasTwin(row.target_ref);
    perQuery.push(rk);
    if (!twin) perQueryNoTwin.push(rk);
    reciprocalRanks.push(rr);
    details.push({ id: row.id, query: row.query, target_ref: row.target_ref, paraphrase_level: row.paraphrase_level, rank1: rk[1], rr, twin, topIds: rankedIds.slice(0, 5) });
  }

  return {
    ks,
    queryCount: rows.length,
    aggregate: aggregateRecall(perQuery, ks),
    collisionExcludedAggregate: aggregateRecall(perQueryNoTwin, ks),
    twinFlagged: rows.length - perQueryNoTwin.length,
    mrr: mrr(reciprocalRanks),
    details,
  };
}

/**
 * Staleness pass: reproduce the production session-end demotion per row, in ISOLATION
 * (the collection is cleared before each row so same-lane rows can't cross-contaminate).
 * seed original+updated → real detector → real supersedePoint (if fired) → real doSearch.
 */
async function stalenessPass({ umAdd, doSearch, detectContradictionsInBatch, supersedePoint, memory, client, collection, rows }) {
  const perRow = [];
  for (const row of rows) {
    await clearPoints(client, collection); // clear between rows → isolation (no recreate race)

    const o = await umAdd({ memory, text: row.original_fact, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client });
    const u = await umAdd({ memory, text: row.updated_fact, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client });
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

    const sr = await doSearch(row.query, 10, false, true, { memory });
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
 * One full eval run against LIVE qdrant. Pins MEM0_USER_ID + flags BEFORE the lazy
 * import (USER_ID is captured at mem0-mcp-http import time — review B1). Isolated to
 * uniquely-named scratch collections; try/finally teardown + `memories` integrity assert.
 *
 * @param {{recallRows:Array, stalenessRows:Array, noAnswerRows:Array, runid?:string,
 *          recallFixturePath?:string, stalenessFixturePath?:string, noAnswerFixturePath?:string}} args
 */
export async function runOnce({ recallRows = [], stalenessRows = [], noAnswerRows = [], runid, recallFixturePath, stalenessFixturePath, noAnswerFixturePath, sweep = false }) {
  // --- pin env BEFORE any import that captures it (review B1 / G2) ---
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_TEMPORAL_DECAY = 'false';
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

  const cost = { embedTokensIn: 0, embedTokensOut: 0, note: 'umAdd/doSearch/judge tokens not separately tracked this pass' };
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
      seedInfo = await seedCorpus({ umAdd, memory: recallMemory, client, rows: recallRows });
      recall = await recallPass({ doSearch, embed, cosineStrict, NOOP_METRICS, memory: recallMemory, rows: recallRows, seeds: seedInfo.seeds, ks: [1, 3, 5, 10], cost });
      recall.seedCount = seedInfo.seeds.length;
      recall.mergedCount = seedInfo.mergedCount;
      recall.distinctIdCount = seedInfo.distinctIdCount;

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
          bouncerSweep = { ...sweepBounceGate({ rows, grid: BOUNCER_SWEEP_GRID, tau: TAU_ANSWER, floors: { answerCorrectness: 0.78, noAnswerPrecision: 0.95 } }), rows };
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
      staleness = await stalenessPass({ umAdd, doSearch, detectContradictionsInBatch, supersedePoint, memory: stalenessMemory, client, collection: stalenessCol, rows: stalenessRows });
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
    flags: { UM_DEDUP_ENABLED: 'true', UM_AUTOSUPERSEDE_ENABLED: 'true', UM_LANE_CLASSIFIER_ENABLED: 'true', UM_TEMPORAL_DECAY: 'false' },
    env: { node: process.version, platform: process.platform },
    fixtures: { recall: recallFixturePath ?? '(inline)', staleness: stalenessFixturePath ?? '(inline)', noAnswer: noAnswerFixturePath ?? '(none)' },
    recall,
    staleness,
    answerCorrectness: answerGrading?.answerCorrectness ?? null,
    noAnswer: answerGrading?.noAnswer ?? null,
    answerGrader: answerGrading?.answerGrader ?? null,
    bouncerSweep,
    cost,
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
