/**
 * supersession-gate-eval.mjs — run the LIVE in-band judge over both validation
 * fixtures and report the JOINT operating point (the R2 review's BL3).
 *
 * The R2 paired-Opus review's central blocker: gates (a) and (b) are the SAME
 * judge under the SAME prompt with OPPOSED requirements, and NEITHER had been run
 * — the whole design was paper. This harness runs both against the real
 * `evaluateInBandSupersession` (which calls the real `judgeContradiction`) and
 * reports the confusion matrix over held-out-FIRE × decline-HOLD:
 *
 *   - GATE (a) capture — held-out-contradiction-set.jsonl: every IN-BAND row must
 *     FIRE (supersede=true). Reported overall + stratified by difficulty
 *     (single-slot-swap / numeric-swap / multi-clause), with misses surfaced.
 *   - GATE (b) over-supersession — over-supersession-set.jsonl: every IN-BAND
 *     `decline` row must HOLD (supersede=false). A false-supersede here demotes a
 *     true fact = SILENT DATA LOSS. Gate = false-supersede rate 0 on decline rows.
 *     `boundary` (version-upgrade) rows are scored SEPARATELY (no pass/fail; §5.2).
 *
 * JOINT verdict: the design only holds if held-out FIRE-rate is high AND
 * decline false-supersede is 0 SIMULTANEOUSLY, under one judge+prompt. If forcing
 * capture costs a decline-row false-supersede, the design FAILS — and this harness
 * reports it rather than asserting independence.
 *
 * In-band is decided exactly as production does it: `evaluateInBandSupersession`
 * returns judged:true only when score ∈ [bandFloor, bandCeiling] AND the row is
 * partition-eligible (lane present). Rows below floor return judged:false and are
 * excluded from the gates (they never reach the judge in prod either).
 *
 * Default ceiling = 1.0 (NO-SKIP / judge the whole band ≥0.84) per the corrected
 * path step 2: τ≈0.97-vs-0.95 is unresolvable without real write-path cost
 * telemetry (study proxy was circular, BL4), so we validate the safest pin. Note:
 * every in-band fixture cosine is < 0.95, so no-skip and τ=0.95 are identical here.
 *
 * Pure embed + real judge — NO qdrant, NO collections, real `memories` untouched.
 * Needs OPENAI_API_KEY. Run from server/:
 *   node --env-file=.env eval/supersession-gate-eval.mjs [--runs=2] [--ceiling=1.0]
 */

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';

// Labels in dedup-labels.json that are genuine re-ingests (must MERGE, never supersede) — gate (c).
const MERGE_POSITIVE = new Set(['identical', 'duplicate', 'paraphrase', 'near-duplicate', 'near_dup']);

const FLOOR = 0.84;            // dedup floor (UM_DEDUP_EMBEDDING_THRESHOLD) — band lower edge
const CUR_CEILING = 0.87;     // TODAY's contradictionBandCeiling default — hits ≤ this are ALREADY
                              // judged in production; only (CUR_CEILING, ceiling] is NEW exposure
                              // from the widening. Splitting on it separates a widening REGRESSION
                              // from a pre-existing judge limitation (the load-bearing distinction).
const JUDGE_MODEL = 'gpt-4o-mini'; // openai defaults.summarizerModel (what the judge resolves to)

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
}

/** Bounded-concurrency map — keeps the judge call-rate civil without serializing. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  if (!process.env.OPENAI_API_KEY && !process.env.UM_OPENAI_API_KEY) {
    console.error('[gate-eval] OPENAI_API_KEY not set — run: node --env-file=.env eval/supersession-gate-eval.mjs');
    process.exit(2);
  }
  const RUNS = Math.max(1, Number.parseInt(arg('runs', '5'), 10) || 5); // ≥5 for a real stability claim (R3 A-G3)
  const CEILING = Number.parseFloat(arg('ceiling', '1.0'));

  const { embed } = await import('../lib/embed.mjs');
  const { cosineStrict } = await import('../lib/vector.mjs');
  const { NOOP_METRICS } = await import('../lib/metrics.mjs');
  const { evaluateInBandSupersession } = await import('../lib/supersede.mjs');

  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  const heldout = await loadFixtureJsonl(here('./held-out-contradiction-set.jsonl'));
  const oversup = await loadFixtureJsonl(here('./over-supersession-set.jsonl'));
  // Gate (c): the D1 dedup set's merge-positive pairs — true duplicates that must NOT become
  // supersedes under the widening (judge declines → DEDUP_MERGED). Synthetic lane for eligibility.
  const dedup = JSON.parse(await readFile(here('../test/fixtures/dedup-labels.json'), 'utf8'));
  const dupRows = dedup.filter((r) => MERGE_POSITIVE.has(r.label));

  // Normalise both fixtures into a common row shape: {id, lane, older, newer, kind, group}
  //   kind 'capture'  → expected FIRE (held-out)
  //   kind 'decline'  → expected HOLD  (over-supersession decline)
  //   kind 'boundary' → scored separately (over-supersession version-upgrade)
  const rows = [
    ...heldout.map((r) => ({
      id: r.id, lane: r.lane, older: r.original_fact, newer: r.updated_fact,
      kind: 'capture', group: r.difficulty ?? 'single-slot-swap',
    })),
    ...oversup.map((r) => ({
      id: r.id, lane: r.lane, older: r.fact_a, newer: r.fact_b,
      kind: r.expected === 'boundary' ? 'boundary' : 'decline', group: r.relation,
    })),
    ...dupRows.map((r, i) => ({
      id: `dup${String(i + 1).padStart(2, '0')}`, lane: 'dev', older: r.a, newer: r.b,
      kind: 'dup', group: r.label,  // expected: DECLINE (merge) — must NOT supersede
    })),
  ];

  // Embed every distinct text once (real embedder, same as prod dedup path).
  const cache = new Map();
  const need = new Set();
  for (const r of rows) { need.add(r.older); need.add(r.newer); }
  process.stderr.write(`[gate-eval] embedding ${need.size} distinct texts...\n`);
  await mapLimit([...need], 8, async (t) => { const e = await embed(t, { metrics: NOOP_METRICS }); cache.set(t, e.vector); });
  const cosine = (a, b) => +cosineStrict(cache.get(a), cache.get(b)).toFixed(4);

  // Score each row's live cosine, then run the REAL in-band judge RUNS times.
  // We pass score=cosine, bandFloor=FLOOR, bandCeiling=CEILING, enabled=true, real
  // _judge (default). judged:true ⟺ in-band & eligible — exactly the prod gate.
  process.stderr.write(`[gate-eval] judging ${rows.length} rows × ${RUNS} run(s) at ceiling ${CEILING} (model ${JUDGE_MODEL})...\n`);
  await mapLimit(rows, 6, async (r) => {
    r.cosine = cosine(r.older, r.newer);
    r.runs = [];
    for (let run = 0; run < RUNS; run++) {
      // evaluateInBandSupersession embeds nothing — it judges the two texts. We
      // hand it the precomputed cosine as the dedup-hit score it would have seen.
      // eslint-disable-next-line no-await-in-loop
      const v = await evaluateInBandSupersession({
        score: r.cosine, olderText: r.older, newerText: r.newer,
        lane: r.lane, bandFloor: FLOOR, bandCeiling: CEILING, enabled: true,
      });
      r.runs.push({ supersede: v.supersede, judged: v.judged, confidence: v.confidence, reasoning: v.reasoning });
    }
    // A row is "in-band" if it reached the judge (judged) in every run.
    r.inBand = r.runs.every((x) => x.judged);
    // Per-row fire count across runs → stability (R3 A-G3: report flips near the floor).
    r.fireCount = r.runs.filter((x) => x.supersede).length;
    r.unstable = r.fireCount !== 0 && r.fireCount !== RUNS; // any flip across runs
    r.supersede = r.fireCount > RUNS / 2; // majority vote (more robust than run-0 at 5 runs)
    r.confidence = r.runs[0].confidence;
    r.reasoning = r.runs[0].reasoning;
    // Exposure: 'current' = already judged under today's 0.87 ceiling; 'widened' = newly
    // reaches the judge only because of the widening (the slice whose safety the widening owns).
    r.exposure = r.cosine > CUR_CEILING ? 'widened' : 'current';
  });

  // ---- Aggregate gate (a): capture / held-out ----
  const capture = rows.filter((r) => r.kind === 'capture');
  const captureInBand = capture.filter((r) => r.inBand);
  const captureFired = captureInBand.filter((r) => r.supersede);
  const captureMisses = captureInBand.filter((r) => !r.supersede)
    .map((r) => ({ id: r.id, group: r.group, cosine: r.cosine, confidence: r.confidence, reasoning: r.reasoning }));
  // Capture rows the CURRENT 0.87 ceiling would dup-skip (cosine > 0.87) = the contradictions the
  // widening newly rescues (this is the bug class: s009-like entity swaps above the old ceiling).
  const captureNewlyEnabled = captureInBand.filter((r) => r.exposure === 'widened');
  const captureNewlyEnabledFired = captureNewlyEnabled.filter((r) => r.supersede);
  const byDifficulty = {};
  for (const g of [...new Set(capture.map((r) => r.group))]) {
    const inB = captureInBand.filter((r) => r.group === g);
    byDifficulty[g] = {
      inBand: inB.length,
      fired: inB.filter((r) => r.supersede).length,
      missed: inB.filter((r) => !r.supersede).map((r) => r.id),
    };
  }

  // ---- Aggregate gate (b): decline / over-supersession ----
  const decline = rows.filter((r) => r.kind === 'decline');
  const declineInBand = decline.filter((r) => r.inBand);
  const falseSupersede = declineInBand.filter((r) => r.supersede); // FP = silent data loss
  // Split the FPs: a 'widened' FP is a REGRESSION the widening introduces; a 'current' FP already
  // happens under today's 0.87 ceiling (a pre-existing judge limitation the widening neither
  // creates nor fixes). gate (b)'s real question for THIS change is: does widening add any FP?
  const fpWidened = falseSupersede.filter((r) => r.exposure === 'widened');
  const fpPreexisting = falseSupersede.filter((r) => r.exposure === 'current');
  const declineNewlyExposed = declineInBand.filter((r) => r.exposure === 'widened');
  const byRelation = {};
  for (const g of [...new Set(decline.map((r) => r.group))]) {
    const inB = declineInBand.filter((r) => r.group === g);
    byRelation[g] = {
      inBand: inB.length,
      declined: inB.filter((r) => !r.supersede).length,
      falseSupersede: inB.filter((r) => r.supersede).map((r) => r.id),
    };
  }

  // ---- Boundary (version-upgrade) — scored separately, no pass/fail ----
  const boundary = rows.filter((r) => r.kind === 'boundary');
  const boundaryInBand = boundary.filter((r) => r.inBand);

  // ---- Gate (c): no-false-merge — D1 duplicates must DECLINE (stay DEDUP_MERGED) under widening ----
  const dup = rows.filter((r) => r.kind === 'dup');
  const dupInBand = dup.filter((r) => r.inBand);
  const dupFalseSupersede = dupInBand.filter((r) => r.supersede); // a dup wrongly superseded = widening broke a merge
  const dupNewlyExposed = dupInBand.filter((r) => r.exposure === 'widened');

  // ---- Confusion matrix (in-band capture × in-band decline) ----
  const TP = captureFired.length, FN = captureMisses.length;
  const FP = falseSupersede.length, TN = declineInBand.length - FP;
  const fireRate = captureInBand.length ? +(TP / captureInBand.length).toFixed(4) : null;
  const falseSupersedeRate = declineInBand.length ? +(FP / declineInBand.length).toFixed(4) : null;
  const unstable = rows.filter((r) => r.unstable).map((r) => ({ id: r.id, kind: r.kind, runs: r.runs.map((x) => x.supersede) }));

  // Design holds iff capture fires fully AND no decline row false-supersedes,
  // jointly, under one judge+prompt. Misses weaken capture; ANY FP fails safety.
  const pass = FP === 0 && FN === 0;

  const result = {
    timestamp: new Date().toISOString(),
    judgeModel: JUDGE_MODEL,
    embeddingModel: process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    floor: FLOOR, ceiling: CEILING, runs: RUNS,
    note: 'no-skip (ceiling 1.0); identical to τ=0.95 for these fixtures (max in-band cosine < 0.95)',
    gateA_capture: {
      total: capture.length, inBand: captureInBand.length,
      fired: TP, missed: FN, fireRate, byDifficulty, misses: captureMisses,
      newlyEnabledByWidening: captureNewlyEnabled.length, // contradictions cosine>0.87 the old ceiling dup-skips
      newlyEnabledFired: captureNewlyEnabledFired.length, // …of those, how many the widening now captures
    },
    gateB_overSupersession: {
      declineTotal: decline.length, declineInBand: declineInBand.length,
      declined: TN, falseSupersede: FP, falseSupersedeRate, byRelation,
      declineNewlyExposed: declineNewlyExposed.length,           // decline rows cosine>0.87 (widening's own slice)
      falseSupersedeWidened: fpWidened.length,                   // *** the regression metric: FPs the widening ADDS
      falseSupersedePreexisting: fpPreexisting.length,           // FPs already happening under today's 0.87 ceiling
      falseSupersedeRows: falseSupersede.map((r) => ({ id: r.id, group: r.group, exposure: r.exposure, cosine: r.cosine, confidence: r.confidence, reasoning: r.reasoning })),
      boundary: boundaryInBand.map((r) => ({ id: r.id, cosine: r.cosine, exposure: r.exposure, fired: r.supersede, confidence: r.confidence, reasoning: r.reasoning })),
    },
    gateC_noFalseMerge: {
      dupTotal: dup.length, dupInBand: dupInBand.length,
      declinedMerged: dupInBand.length - dupFalseSupersede.length,
      falseSupersede: dupFalseSupersede.length, dupNewlyExposed: dupNewlyExposed.length,
      falseSupersedeRows: dupFalseSupersede.map((r) => ({ id: r.id, group: r.group, exposure: r.exposure, cosine: r.cosine, confidence: r.confidence, reasoning: r.reasoning })),
    },
    confusionMatrix: { inBandCapture: captureInBand.length, inBandDecline: declineInBand.length, TP, FN, TN, FP },
    determinism: { runs: RUNS, unstableCount: unstable.length, unstable },
    verdict: {
      strictPass: pass && dupFalseSupersede.length === 0,   // spec literal: full capture AND zero FP (decline+dup) anywhere in band
      wideningClean: fpWidened.length === 0 && dupNewlyExposed.filter((r) => r.supersede).length === 0, // change's OWN bar: no new FP (decline+dup) in (0.87, ceiling]
      fireRate, falseSupersedeRate,
      falseSupersedeWidened: fpWidened.length, falseSupersedePreexisting: fpPreexisting.length,
      dupFalseSupersede: dupFalseSupersede.length,
      newlyCaptured: captureNewlyEnabledFired.length,
      summary: (pass && dupFalseSupersede.length === 0)
        ? 'JOINT PASS: all in-band held-out fired; zero decline AND zero dup false-supersedes anywhere in band.'
        : `STRICT-FAIL but WIDENING-${fpWidened.length === 0 && dupNewlyExposed.filter((r) => r.supersede).length === 0 ? 'CLEAN' : 'REGRESSION'}: fireRate=${fireRate} (misses ${FN}); decline FP ${FP} = ${fpWidened.length} widening + ${fpPreexisting.length} pre-existing; dup FP ${dupFalseSupersede.length}. Widening newly captures ${captureNewlyEnabledFired.length} previously-skipped contradictions.`,
    },
    perRow: rows.map((r) => ({ id: r.id, kind: r.kind, group: r.group, lane: r.lane, cosine: r.cosine, inBand: r.inBand, supersede: r.supersede, unstable: r.unstable, confidence: r.confidence, reasoning: r.reasoning, older: r.older, newer: r.newer })),
  };

  const outPath = here(`./results/2026-06-19-supersession-gate-eval-ceil${CEILING}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  // ---- Console summary ----
  console.log(`\n=== supersession in-band gate eval — JOINT operating point (judge ${JUDGE_MODEL}, temp 0, ${RUNS} runs) ===`);
  console.log(`band [${FLOOR}, ${CEILING}] (no-skip)\n`);
  console.log(`GATE (a) capture — held-out contradictions:`);
  console.log(`  in-band ${captureInBand.length}/${capture.length}  fired ${TP}  missed ${FN}  fire-rate ${fireRate}`);
  console.log(`  newly captured by widening (cos>${CUR_CEILING}, dup-skipped today): ${captureNewlyEnabledFired.length}/${captureNewlyEnabled.length}`);
  for (const [g, s] of Object.entries(byDifficulty)) {
    console.log(`    ${g.padEnd(18)} in-band ${String(s.inBand).padStart(2)}  fired ${String(s.fired).padStart(2)}` + (s.missed.length ? `  MISSED ${s.missed.join(',')}` : ''));
  }
  if (captureMisses.length) {
    console.log(`  MISSES (in-band, did NOT fire):`);
    for (const m of captureMisses) console.log(`    ${m.id} cos=${m.cosine} conf=${m.confidence} :: ${m.reasoning}`);
  }
  console.log(`\nGATE (b) over-supersession — decline rows must HOLD:`);
  console.log(`  in-band ${declineInBand.length}/${decline.length}  declined ${TN}  FALSE-SUPERSEDE ${FP}  rate ${falseSupersedeRate}`);
  console.log(`  FP from WIDENING (cos>${CUR_CEILING}): ${fpWidened.length}${fpWidened.length ? ' ['+fpWidened.map((r)=>r.id).join(',')+']' : ''}  |  FP pre-existing (cos≤${CUR_CEILING}, judged today): ${fpPreexisting.length}${fpPreexisting.length ? ' ['+fpPreexisting.map((r)=>r.id).join(',')+']' : ''}`);
  console.log(`  decline rows newly exposed by widening (cos>${CUR_CEILING}): ${declineNewlyExposed.length} → ${declineNewlyExposed.filter((r)=>!r.supersede).length} declined, ${declineNewlyExposed.filter((r)=>r.supersede).length} false-superseded`);
  for (const [g, s] of Object.entries(byRelation)) {
    console.log(`    ${g.padEnd(26)} in-band ${String(s.inBand).padStart(2)}  declined ${String(s.declined).padStart(2)}` + (s.falseSupersede.length ? `  FALSE-SUPERSEDE ${s.falseSupersede.join(',')}` : ''));
  }
  if (falseSupersede.length) {
    console.log(`  *** FALSE-SUPERSEDES (silent data loss) ***`);
    for (const r of falseSupersede) console.log(`    ${r.id} (${r.group}) cos=${r.cosine} conf=${r.confidence} :: ${r.reasoning}`);
  }
  console.log(`\nBOUNDARY (version-upgrade, scored separately — §5.2):`);
  for (const r of boundaryInBand) console.log(`  ${r.id} cos=${r.cosine} ${r.supersede ? 'FIRED (would supersede)' : 'declined'} conf=${r.confidence} :: ${r.reasoning}`);
  console.log(`\nGATE (c) no-false-merge — D1 duplicates must stay merged:`);
  console.log(`  in-band ${dupInBand.length}/${dup.length}  declined(merged) ${dupInBand.length - dupFalseSupersede.length}  FALSE-SUPERSEDE ${dupFalseSupersede.length}` + (dupFalseSupersede.length ? ` [${dupFalseSupersede.map((r) => r.id).join(',')}]` : ''));
  console.log(`\nCONFUSION MATRIX (in-band): TP=${TP} FN=${FN} | TN=${TN} FP=${FP}`);
  if (unstable.length) console.log(`UNSTABLE across runs: ${unstable.map((u) => u.id).join(', ')}`);
  console.log(`\nVERDICT: strictPass=${result.verdict.strictPass}  wideningClean=${result.verdict.wideningClean}`);
  console.log(`  ${result.verdict.summary}`);
  console.log(`result -> ${outPath}`);
}

main().catch((e) => { console.error('[gate-eval] FATAL:', e); process.exit(1); });
