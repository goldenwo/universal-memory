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
import { isUsableDate, CLOCK_SKEW_TOLERANCE_MS } from './ranking.mjs';

/**
 * resolveSupersessionDirection — the pure direction rule (#276, spec §4.1).
 *
 * Supersession used to realise "newer wins" by arrival order: the incoming write
 * was always the newer side and the stored candidate always the older. Arrival
 * order is the registration timestamp, not truth time — a re-registered older
 * document arriving after its successor inverted the ordering and demoted the
 * wrong side. Direction now keys on RECORDED TRUTH TIME, the `valid_from` field
 * both sides may carry, and abstains whenever the store cannot say:
 *
 *   truthTime(stored)   := usable(stored.valid_from)   ? epoch(stored.valid_from)   : null
 *   truthTime(incoming) := usable(incoming.valid_from) ? epoch(incoming.valid_from) : epoch(assertedAt)
 *   now                 := caller-passed; defaults to assertedAt when omitted or unusable
 *
 *   assertedAt unusable                                        -> 'ambiguous'
 *   truthTime(stored) === null                                 -> 'ambiguous'
 *   truthTime(stored)  >  epoch(now) + CLOCK_SKEW_TOLERANCE_MS -> 'stored-future'
 *   truthTime(incoming) > epoch(now) + CLOCK_SKEW_TOLERANCE_MS -> 'incoming-future'
 *   truthTime(incoming) > truthTime(stored)                    -> 'incoming-newer'
 *   truthTime(incoming) < truthTime(stored)                    -> 'stored-newer'
 *   equal                                                      -> 'ambiguous'
 *
 * Act (demote the stored point) iff direction === 'incoming-newer'. Every other
 * value is an abstain — the subsystem's polarity is "err toward not superseding":
 * a false supersession is silent recall loss. 'stored-future' is an abstain split
 * out only so an operator can see it; it compares the stored instant against the
 * wall clock at decision (`now`), never against the incoming truth time.
 * 'incoming-future' (#318) is the same bound on the other side: `valid_from` is
 * caller-settable on every public write, so without it one far-future value
 * resolved 'incoming-newer' against every dated stored point and, on a confirmed
 * contradiction, demoted it. The read side already treats a future `valid_from`
 * as a hazard (#238's upper clamp); this is the write/direction-side analogue.
 * Both future arms run before the newer/older comparison, stored side first, so
 * two caller-chosen future instants are never compared against each other. The
 * incoming arm reads truthTime(incoming), which falls back to `assertedAt` when
 * the incoming side carries no usable valid_from — so a caller that passes a
 * `now` more than the skew EARLIER than assertedAt (a windowed checkpoint whose
 * client-supplied `until` bound is ahead of the wall clock) gets 'incoming-future'
 * for every fact of that batch: the assertion itself is future relative to the
 * trusted clock, and the fail-safe abstain is deliberate (D11).
 *
 * The registration timestamp / arrival order is never consulted. The ADR
 * decision-date field is never consulted either — `valid_from` is the one
 * truth-time field the write side owns and the one ranking reads; the identity
 * follow-up routes the decision date into it.
 *
 * Fail-safe: missing or non-object arguments, or a missing/unusable `assertedAt`,
 * resolve 'ambiguous'. `usable` is isUsableDate — the writer's own contract — and
 * it is applied to the field BEFORE the fallback, so 'not a date' falls through
 * exactly like an absent value. Comparison is on epoch milliseconds and every
 * instant reported is RE-SERIALISED (`toISOString()`), never the raw field: a
 * usable string may carry arbitrary caller text in a parenthesised tail, and the
 * raw field must not reach a log line. No clock read, no env, no I/O.
 *
 * @param {object} p
 * @param {{valid_from?: string, assertedAt: string}} p.incoming
 * @param {{valid_from?: string}}                     p.stored
 * @param {string} [p.now]  Wall clock at decision; defaults to `assertedAt`.
 * @returns {{direction: 'incoming-newer'|'stored-newer'|'stored-future'|'incoming-future'|'ambiguous', incomingAt: string|null, storedAt: string|null}}
 */
export function resolveSupersessionDirection(p) {
  const epochOf = (v) => (isUsableDate(v) ? new Date(v).getTime() : null);
  const isoOf = (ms) => (ms === null ? null : new Date(ms).toISOString());
  const incoming = p && typeof p === 'object' && p.incoming && typeof p.incoming === 'object' ? p.incoming : null;
  const stored = p && typeof p === 'object' && p.stored && typeof p.stored === 'object' ? p.stored : null;

  const assertedMs = incoming ? epochOf(incoming.assertedAt) : null;
  const storedMs = stored ? epochOf(stored.valid_from) : null;
  const incomingMs = incoming ? (epochOf(incoming.valid_from) ?? assertedMs) : null;

  const result = (direction) => ({ direction, incomingAt: isoOf(incomingMs), storedAt: isoOf(storedMs) });

  if (!incoming || !stored) return result('ambiguous');
  if (assertedMs === null) return result('ambiguous');
  if (storedMs === null) return result('ambiguous');
  const nowMs = (p.now === undefined ? null : epochOf(p.now)) ?? assertedMs;
  if (storedMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) return result('stored-future');
  if (incomingMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) return result('incoming-future');
  if (incomingMs > storedMs) return result('incoming-newer');
  if (incomingMs < storedMs) return result('stored-newer');
  return result('ambiguous');
}

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
 * Confident-duplicate floor — the upper cosine edge above which the in-band
 * contradiction judge is cost-skipped (ADR-0007 Option C; band-widening 2026-06-19).
 *
 * The dedup band is [UM_DEDUP_EMBEDDING_THRESHOLD (0.84), this]. A write-time dedup
 * hit IN the band is handed to the judge (supersede-vs-merge); a hit ABOVE this floor
 * is a confident duplicate, so the judge is skipped and dedup keeps-older.
 *
 * Default 0.95. The band-widening validation (server/eval/supersession-gate-eval.mjs;
 * results/2026-06-19-supersession-band-widening-validation.md) refuted any *separating*
 * ceiling — contradictions and duplicates OVERLAP from ~0.84 to ~0.94, so the JUDGE,
 * not cosine, is the precision gate. 0.95 is pinned just ABOVE the measured contradiction
 * tail (held-out max 0.9396) and BELOW the near-value multi-value-coexist over-supersede
 * zone (the lone widened-slice false-supersede, os022, embeds at 0.9632): widening from
 * the old 0.87 to 0.95 rescues every measured contradiction the 0.87 ceiling dup-skipped
 * (the s009 "PostgreSQL→MySQL" @0.8725 class — 18/18 fired) while adding ZERO new
 * over-supersession. No-skip (1.0) was rejected — it re-exposes the >0.95 coexist zone for
 * no capture gain (no contradiction embeds >0.95). It is a COST/safety bound, not a
 * correctness gate — an imperfect floor only changes how OFTEN the judge fires. Re-eval if
 * the embedding model changes (text-embedding-3-small). Keep the default in lockstep with
 * server/.env.example UM_CONTRADICTION_BAND_CEILING and the drift assertion in
 * server/test/supersede.test.mjs.
 */
export function contradictionBandCeiling(env = process.env) {
  const n = Number.parseFloat(env.UM_CONTRADICTION_BAND_CEILING);
  return Number.isFinite(n) ? n : 0.95;
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
 * Direction (#276): after the band gate and BEFORE the judge, the recorded truth
 * time of both sides is resolved (`resolveSupersessionDirection`); only
 * 'incoming-newer' reaches the judge. Every other direction returns an abstain
 * carrying `direction` plus the re-serialised `incomingAt`/`storedAt` (for the
 * caller's abstain log line), so the judge fires for a SUBSET of the in-band slice —
 * the cost bound tightens, never loosens. Pre-existing short-circuits report
 * `direction: null` (direction was not evaluated).
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
 * @param {{valid_from?: string}} [p.olderTruth]  - Recorded truth time of the stored candidate (its payload `valid_from`).
 * @param {{valid_from?: string, assertedAt: string}} [p.newerTruth] - Incoming truth time (staged metadata `valid_from`) + the decision instant.
 * @param {Function} [p._judge]         - DI: judgeContradiction(older, newer) → {contradicts, confidence, reasoning}. Already fail-safe.
 * @returns {Promise<{supersede: boolean, judged: boolean, confidence: number, reasoning: string, direction: string|null, incomingAt: string|null, storedAt: string|null}>}
 */
export async function evaluateInBandSupersession({
  score,
  olderText,
  newerText,
  lane,
  persona,
  bandFloor,
  olderTruth,
  newerTruth,
  bandCeiling = contradictionBandCeiling(),
  judgeThreshold = autoSupersedeJudgeThreshold(),
  enabled = isAutoSupersedeEnabled(),
  _judge = judgeContradiction,
} = {}) {
  const NO = { supersede: false, judged: false, confidence: 0, reasoning: '', direction: null, incomingAt: null, storedAt: null };

  // Cheap short-circuits — the judge is reached ONLY when every gate passes.
  if (!enabled) return NO;                                          // flag off
  if (!lane && !persona) return NO;                                 // R1-B1: unpartitioned
  if (typeof olderText !== 'string' || typeof newerText !== 'string') return NO; // cannot judge
  // bandFloor omitted → `score >= undefined` is false → never in-band (fail-safe).
  const inBand = typeof score === 'number' && score >= bandFloor && score <= bandCeiling;
  if (!inBand) return NO;                                           // out of band → keep-older

  // Direction (#276): recorded truth time decides which side is newer. Anything
  // but 'incoming-newer' abstains BEFORE the judge is consulted — omitted truth
  // objects resolve 'ambiguous' (fail-safe), never arrival order.
  const { direction, incomingAt, storedAt } = resolveSupersessionDirection({ incoming: newerTruth, stored: olderTruth });
  if (direction !== 'incoming-newer') return { ...NO, direction, incomingAt, storedAt };

  // Bounded inline judge. judgeContradiction is itself fail-safe: any provider
  // or parse error yields {contradicts:false, confidence:0} → degrades to
  // keep-older, never throws to the writer. Argument order: the stored candidate
  // (TARGET) first, the incoming fact (REPLACEMENT) second — the direction check
  // above has already established that the incoming side is the newer one.
  const v = await _judge(olderText, newerText);
  const supersede = v.contradicts === true && v.confidence >= judgeThreshold;
  return { supersede, judged: true, confidence: v.confidence ?? 0, reasoning: v.reasoning ?? '', direction, incomingAt, storedAt };
}
