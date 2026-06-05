/**
 * server/lib/supersede.mjs — the supersession module.
 *
 * Three layers, low to high:
 *   1. Point-level primitives (D3.1):
 *      `supersedePoint`   — marks a qdrant point as superseded by another.
 *      `unsupersedePoint` — restores a superseded point to current status.
 *   2. The opt-out flag predicate (`isAutoSupersedeEnabled`) — single source
 *      for every supersession entry point (checkpoint.mjs session-end wiring,
 *      mem0-mcp-http.mjs memory_checkpoint, and the P3 write-time decision).
 *   3. The write-time decision (Gap-5 P3 / ADR-0007 Option C):
 *      `evaluateInBandSupersession` + the eval-pinned config readers
 *      (`contradictionBandCeiling`, `autoSupersedeJudgeThreshold`).
 *
 * Wiring status: the primitives are called by the session-end detector
 * (checkpoint.mjs, D3.2) and — as of Gap-5 P3 — by the write path (add.mjs)
 * for the supersede-eligible in-band slice. Operator invocation via MCP is in
 * the memory_supersede family.
 *
 * setPayload idiom: mirrors mergeSurface() in dedup.mjs —
 *   client.setPayload(collection, { points: [id], payload: { ... } })
 * Real qdrant setPayload is an ADDITIVE partial merge — it updates only the
 * supplied keys; it cannot delete keys. unsupersedePoint therefore clears
 * provenance fields to `null` (not key-delete). Filters in this codebase
 * key on `status` value only, so null provenance is harmless.
 *
 * Spec refs: §3.2 (point lifecycle), §3.7 (supersession schema); Gap-5 spec §4
 * + ADR-0007 Option C (the in-band decision). Plan refs: D3.1 Task 1.3; Gap-5 P3.
 */

import { judgeContradiction } from './contradiction-judge.mjs';

/**
 * Mark a qdrant point as superseded.
 *
 * Idempotent: re-running on an already-superseded point is a harmless rewrite.
 * Under concurrency the `supersededBy` provenance pointer is last-writer-wins —
 * if two writers supersede the same older point, the point stays correctly
 * `superseded` and no fact is lost (each newer fact is independently current),
 * but the pointer reflects whichever demotion ran last. No read path keys on
 * `supersededBy` (filters match `status` only), so this is informational.
 *
 * @param {object} params
 * @param {object} params.client       - Qdrant client with `.setPayload()`
 * @param {string} params.collection   - Collection name
 * @param {string} params.id           - Point id to supersede
 * @param {string} params.supersededBy - Id of the point that supersedes this one
 */
export async function supersedePoint({ client, collection, id, supersededBy }) {
  await client.setPayload(collection, {
    points: [id],
    payload: {
      status: 'superseded',
      supersededBy,
      supersededAt: new Date().toISOString(),
    },
  });
}

/**
 * Restore a superseded point to current status, clearing provenance.
 *
 * Non-cascading: only the single named point is affected.
 * Clears supersededBy / supersededAt to null (setPayload cannot delete keys).
 *
 * @param {object} params
 * @param {object} params.client     - Qdrant client with `.setPayload()`
 * @param {string} params.collection - Collection name
 * @param {string} params.id         - Point id to restore
 */
export async function unsupersedePoint({ client, collection, id }) {
  await client.setPayload(collection, {
    points: [id],
    payload: {
      status: 'current',
      supersededBy: null,
      supersededAt: null,
    },
  });
}

/**
 * Whether auto-supersession is enabled (opt-out, whitespace-trimmed).
 *
 * SINGLE SOURCE for the gate predicate shared by every supersession entry
 * point: the session-end detector wiring (checkpoint.mjs), the MCP
 * memory_checkpoint handler (mem0-mcp-http.mjs), and the write-time in-band
 * decision (add.mjs, via evaluateInBandSupersession). Opt-out polarity since
 * the v1.2 flip (PR #93): only the literal lowercase 'false' (after trim)
 * disables; unset / '' / 'true' / anything else → ON. The R1-B1
 * partition-eligibility gate keeps supersession inert for unpartitioned facts
 * even when this is on.
 */
export function isAutoSupersedeEnabled(env = process.env) {
  return env.UM_AUTOSUPERSEDE_ENABLED?.trim() !== 'false';
}

/**
 * Upper cosine edge of the contradiction-overlap band (ADR-0007 Option C).
 *
 * A dedup embedding hit ABOVE this cosine is too phrasing-similar to be a
 * contradiction — it is a genuine near-duplicate, so dedup keeps-older. The
 * band's LOWER edge is the dedup threshold (UM_DEDUP_EMBEDDING_THRESHOLD): a
 * hit only reaches this decision once its cosine already cleared that floor.
 *
 * Default 0.87 = the measured top of the true-contradiction cosine span
 * (0.50–0.87) from the D3.3 eval against the production embedder
 * (server/eval/results/2026-06-02-d3-openai-run*.json; see the band note at
 * contradiction-batch.mjs). It is a COST bound, not a correctness gate — the
 * inline judge is the precision gate, so an imperfect ceiling only changes how
 * OFTEN the judge fires, never whether a true near-duplicate is kept. Re-eval
 * the band edge if the embedding model changes. Keep the default in lockstep
 * with server/.env.example UM_CONTRADICTION_BAND_CEILING and the drift
 * assertion in server/test/supersede.test.mjs.
 */
export function contradictionBandCeiling(env = process.env) {
  const n = Number.parseFloat(env.UM_CONTRADICTION_BAND_CEILING);
  return Number.isFinite(n) ? n : 0.87;
}

/**
 * Judge-confidence threshold for an inline in-band supersession (default 0.80).
 *
 * Reuses UM_AUTOSUPERSEDE_THRESHOLD — the same env var and default the
 * session-end detector uses (contradiction-batch.mjs `judgeThreshold`), so the
 * write-time and session-end paths agree on what counts as a confident
 * contradiction. Keep the 0.80 default in lockstep with that detector default.
 */
export function autoSupersedeJudgeThreshold(env = process.env) {
  const n = Number.parseFloat(env.UM_AUTOSUPERSEDE_THRESHOLD);
  return Number.isFinite(n) ? n : 0.80;
}

/**
 * ADR-0007 Option C — decide whether a write-time dedup hit should DEFER to
 * supersession instead of keep-older-merging.
 *
 * Phrasing-similar CONTRADICTIONS land in the dedup embedding-similarity band
 * just like true duplicates. When a write is supersede-eligible (flag on AND
 * the partition carries a lane/persona) AND the hit's cosine is in the
 * contradiction-overlap band, ask the judge: if it confirms a contradiction at
 * or above the confidence threshold, the caller must NOT keep-older-merge —
 * instead let the newer fact persist as its own status:current point and demote
 * the older one. That is the load-bearing invariant (see ADR-0007 Option C, the
 * "load-bearing invariant" note): skipping the merge is necessary but NOT
 * sufficient, because supersession only demotes the older point and never upserts
 * the newer. This function only DECIDES; the caller (umAdd) performs the upsert +
 * demotion in a crash-safe order (upsert-newer-first, then demote-older).
 *
 * PURE w.r.t. metrics — emits none. Callers own the
 * `um_inband_supersede_total{superseded|declined|demote_error}` emission, keyed
 * off the returned `{supersede, judged}` plus their own demotion result (the
 * canonical 3-outcome mapping lives in add.mjs's umAdd).
 *
 * The judge fires ONLY for the eligible-in-band slice (returns `judged:true`):
 * flag-off, unpartitioned, and out-of-band hits short-circuit before any judge
 * call, so the inline-judge hot-path cost is bounded to that narrow slice.
 *
 * @param {object}   p
 * @param {number}   p.score            - Cosine of the dedup embedding hit.
 * @param {string}   p.olderText        - Existing (candidate-to-demote) point text.
 * @param {string}   p.newerText        - Incoming fact text.
 * @param {string}   [p.lane]           - Partition lane (eligibility).
 * @param {string}   [p.persona]        - Partition persona (eligibility).
 * @param {number}   [p.bandFloor]      - Lower band edge = the dedup threshold that produced the hit. Omitted → fail-safe never-in-band.
 * @param {number}   [p.bandCeiling]    - Upper band edge (default: contradictionBandCeiling()).
 * @param {number}   [p.judgeThreshold] - Min judge confidence (default: autoSupersedeJudgeThreshold()).
 * @param {boolean}  [p.enabled]        - Auto-supersession flag (default: isAutoSupersedeEnabled()).
 * @param {Function} [p._judge]         - DI: judgeContradiction(older, newer) → {contradicts, confidence, reasoning}. Already fail-safe.
 * @returns {Promise<{supersede: boolean, judged: boolean, confidence: number, reasoning: string}>}
 */
export async function evaluateInBandSupersession({
  score,
  olderText,
  newerText,
  lane,
  persona,
  bandFloor,
  bandCeiling = contradictionBandCeiling(),
  judgeThreshold = autoSupersedeJudgeThreshold(),
  enabled = isAutoSupersedeEnabled(),
  _judge = judgeContradiction,
} = {}) {
  const NO = { supersede: false, judged: false, confidence: 0, reasoning: '' };

  // Cheap short-circuits — the judge is reached ONLY when every gate passes.
  if (!enabled) return NO;                                          // flag off
  if (!lane && !persona) return NO;                                 // R1-B1: unpartitioned
  if (typeof olderText !== 'string' || typeof newerText !== 'string') return NO; // cannot judge
  // bandFloor omitted → `score >= undefined` is false → never in-band (fail-safe).
  const inBand = typeof score === 'number' && score >= bandFloor && score <= bandCeiling;
  if (!inBand) return NO;                                           // out of band → keep-older

  // Bounded inline judge. judgeContradiction is itself fail-safe: any provider
  // or parse error yields {contradicts:false, confidence:0} → degrades to
  // keep-older, never throws to the writer. Directionality mirrors the detector:
  // older = existing candidate (TARGET), newer = incoming (REPLACEMENT).
  const v = await _judge(olderText, newerText);
  const supersede = v.contradicts === true && v.confidence >= judgeThreshold;
  return { supersede, judged: true, confidence: v.confidence ?? 0, reasoning: v.reasoning ?? '' };
}
