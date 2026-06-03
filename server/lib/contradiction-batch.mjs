/**
 * server/lib/contradiction-batch.mjs — D3.2 session-end batch contradiction detector.
 *
 * At session-end, finds older facts in the store that are contradicted by the
 * session's newer facts — but ONLY inside a named lane/persona partition.
 *
 * Eligibility gate (FIRST LINE, before ANY work):
 *   if (!lane && !persona) return [];
 * When both are absent (the unpartitioned bucket), D3 does nothing: no facts
 * extraction, no embedding, no _find, no _judge. This is a hard rule, not a
 * threshold, and is checked before any I/O.
 *
 * Selection rule (R1-Lens-B-G5):
 *   Across ALL (newFact × candidate) pairs, keep those where
 *   contradicts===true && confidence >= threshold. Return ONLY the single
 *   highest-confidence pair as a length-0-or-1 array. Multi-supersede is
 *   explicitly deferred to D3.3.
 *
 * Idempotency (R1-Lens-B-G2):
 *   Any candidate with payload.status==='superseded' is skipped WITHOUT
 *   calling _judge. The real _find already excludes them, but we skip
 *   defensively so a re-run never re-judges a resolved target.
 *
 * supersededBy id:
 *   Uses computeFactId() from add.mjs — the canonical derivation shared with
 *   the write path — so audit/undo can rely on stable ids.
 *
 * Spec refs: D3.2 Task 2.3; R1-B1 (gate); R1-Lens-B-G2 (idempotency);
 *            R1-Lens-B-G5 (single max-confidence selection).
 */

import { facts as realFacts } from './facts.mjs';
import { embed as realEmbed } from './embed.mjs';
import { findEmbeddingSimilarCandidates } from './dedup.mjs';
import { judgeContradiction } from './contradiction-judge.mjs';
import { computeFactId } from './add.mjs';

/**
 * Detect contradictions in a batch (session-end) against stored facts.
 *
 * @param {string} transcript        — Session transcript text (fed into _facts)
 * @param {object} opts
 * @param {string}   opts.userId     — Required. Partition key.
 * @param {string}   [opts.lane]     — Lane slug. If absent AND persona absent → no-op.
 * @param {string}   [opts.persona]  — Persona slug. Same gate as lane.
 * @param {number}   [opts.judgeThreshold=0.80]     — Minimum LLM-judge confidence to supersede an older fact. Eval-derived (D3.3 Task 3.2).
 * @param {number}   [opts.retrievalThreshold=0.45] — Minimum embedding cosine for a candidate to be RETRIEVED (passed to _find as its score_threshold). Eval-derived; kept far below judgeThreshold because true contradictions are only moderately cosine-similar.
 * @param {string}   [opts.collection]    — Qdrant collection name.
 * @param {object}   [opts.client]        — Qdrant client (for real _find).
 * @param {Function} [opts._facts]        — DI: replaces facts() orchestrator (test seam).
 * @param {Function} [opts._embed]        — DI: replaces embed() orchestrator (test seam).
 * @param {Function} [opts._find]         — DI: replaces findEmbeddingSimilarCandidates (test seam).
 * @param {Function} [opts._judge]        — DI: replaces judgeContradiction (test seam).
 * @param {object}   [opts.metrics]       — DI: metrics sink (forwarded to _facts/_embed).
 *
 * @returns {Promise<Array<{targetId, supersededBy, confidence, reasoning}>>}
 *          Length 0 or 1 (never more than 1 in D3.2).
 */
export async function detectContradictionsInBatch(transcript, {
  userId,
  lane,
  persona,
  // D3.3 Task 3.2: the retrieval cosine cutoff and the judge-confidence cutoff
  // are INDEPENDENT and must not share a value.
  // eval-derived 2026-06-02 (server/eval/results/d3-latest.json): precision is 1.0
  // at EVERY swept τ (the judge emits zero false positives on the fixture), so the
  // harness precision-floor rule mechanically recommends τ=0.70 (range floor).
  // Pinned to 0.80 deliberately: top of the recall=1.0 plateau common to BOTH runs
  // (P/R still 1.0/1.0), with headroom above the negatives and rejecting sub-0.80
  // hedged verdicts — the precision-first choice. true-contradiction cosines span
  // 0.50-0.87 (all below the judge τ), which is why retrieval must decouple lower.
  judgeThreshold = 0.80,     // judge-confidence gate (supersede iff confidence >= this)
  retrievalThreshold = 0.45, // candidate-retrieval cosine (passed to _find as score_threshold)
  collection,
  client,
  _facts  = realFacts,
  _embed  = realEmbed,
  _find   = findEmbeddingSimilarCandidates,
  _judge  = judgeContradiction,
  metrics,
} = {}) {
  // ── ELIGIBILITY GATE — MUST BE FIRST ────────────────────────────────────
  // Both lane and persona absent (undefined / null / '') → unpartitioned bucket.
  // D3 does nothing in this bucket. Return early before any I/O or side effects.
  if (!lane && !persona) return [];

  // ── Extract facts from transcript ────────────────────────────────────────
  const factsResult = await _facts(transcript, { metrics });
  const newFacts = Array.isArray(factsResult.facts)
    ? factsResult.facts.filter((f) => typeof f === 'string' && f.length > 0)
    : [];

  if (newFacts.length === 0) return [];

  // ── Per-fact: embed → find candidates → judge pairs ─────────────────────
  // Accumulate ALL qualifying (contradicts===true && confidence>=judgeThreshold) pairs.
  const qualifying = [];

  for (const newFact of newFacts) {
    const { vector } = await _embed(newFact, { metrics });

    // Retrieval uses retrievalThreshold (the cosine score_threshold) — far below
    // the judge τ so moderately-similar true contradictions are still retrieved.
    const candidates = await _find({
      client,
      collection,
      userId,
      vector,
      threshold: retrievalThreshold,
      lane,
      persona,
    });

    for (const candidate of candidates) {
      // Defensive idempotency skip (R1-Lens-B-G2): never re-judge a superseded
      // candidate. The real _find already excludes them, but defensive skip
      // ensures a re-run is safe even if _find is bypassed in tests.
      if (candidate?.payload?.status === 'superseded') continue;

      const olderFact = candidate.payload?.data;
      if (typeof olderFact !== 'string') continue;

      // Directionality: older = candidate (TARGET), newer = newFact (REPLACEMENT).
      const judgment = await _judge(olderFact, newFact);

      if (judgment.contradicts === true && judgment.confidence >= judgeThreshold) {
        qualifying.push({
          targetId:    candidate.id,
          supersededBy: computeFactId({ userId, text: newFact, lane, persona }),
          confidence:  judgment.confidence,
          reasoning:   judgment.reasoning ?? '',
        });
      }
    }
  }

  if (qualifying.length === 0) return [];

  // ── Selection (R1-Lens-B-G5): single highest-confidence pair only ─────────
  // Multi-supersede deferred to D3.3 — never return more than 1 entry.
  qualifying.sort((a, b) => b.confidence - a.confidence);
  return [qualifying[0]];
}
