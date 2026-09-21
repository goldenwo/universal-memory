// server/lib/checkpoint-signal.mjs — #309: accepted-mode checkpoint failure signal.
// Owns the `signal.checkpoint_failure` event family: the event name, the
// outcome vocabulary, and the classifier that maps a doCheckpoint settlement
// onto it.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is
// the durable record, same posture as anomaly-signal.mjs):
//
// • WHY THIS EXISTS: under accepted mode the HTTP caller is gone before the
//   outcome exists, so a failed checkpoint has nobody to tell. Nothing
//   downstream notices on its own: LAYERS-STALE computes a capture-vs-digest
//   LAG (layers.mjs:333-336), and that lag FREEZES when a project stops
//   capturing — so a project whose finite lag sits below the ceiling when it
//   goes quiet is invisible indefinitely with a green board. Detection here
//   depends on the failure having HAPPENED, not on the project continuing to
//   capture.
//
// • NAMESPACE BOUNDARY: `signal.checkpoint_failure` lives OUTSIDE the pinned
//   `capture.*` namespace, and is queried by event EQUALITY (never LIKE), so
//   the `capture.%` filter boundary stays untouched by construction.
//   Specifically it must NEVER reuse `capture.checkpoint` outcome:'error':
//   stats.mjs:216-223 counts outcome IN ('stored','error') as DOC GROWTH, and
//   says so explicitly — that emit fires only AFTER the summary and state.md
//   are durably on disk. A job that failed having written nothing is not that,
//   and emitting 'error' for it would inflate the very metric #185 created to
//   catch fabricated summaries. `growth_docs_7d` MUST NOT move because of this
//   family.
//
// • DOWNGRADE-INERTNESS: no pre-#309 query matches this event (every counters
//   reader is either `LIKE 'capture.%'` or equality on another event), so a
//   downgraded server reads a counters DB containing these rows with zero
//   behaviour change.
//
// • CLASSIFIED BY RESIDUAL, NOT BY ENUMERATION — the single most important
//   property in this file. `doCheckpoint`'s `error` field is a genuine union
//   of incompatible shapes: a bare string ('checkpoint_in_progress'), a string
//   carrying its own code (`lock_acquire_failed: ENOSPC`), free text ('cost
//   cap hit'), and a coded object ({code, message}). Three successive attempts
//   to ENUMERATE the failure tokens each named a wire value the code does not
//   emit, and each would have shipped a term that never matches — i.e. a
//   failure silently folding out of the alerting set, which is the very defect
//   class this whole change exists to correct.
//
//   So the classifier is INVERTED: only the two CONTENTION cases are matched
//   positively, and EVERY other resolved failure is the residual. No token is
//   read on the failure path. A failure shape added to the server AFTER this
//   ships therefore ALERTS BY DEFAULT instead of folding away silently.
//   DO NOT "tidy" this into a token map. That is the bug three sign-off passes
//   were spent on.
//
// • `lock_acquire_failed` LANDS IN `failed` ON PURPOSE — do not move it to
//   `contended` on the strength of its name. `acquireLockdir` is called with
//   timeoutMs:0 (checkpoint.mjs:257), so a lock genuinely held by another run
//   returns false and becomes `checkpoint_in_progress`. `lock_acquire_failed`
//   is the OTHER branch: the call THREW. lockdir.mjs:78 throws only what is
//   neither EEXIST nor in RETRYABLE_MKDIR_ERRS ({EPERM, EACCES, EBUSY, EMFILE,
//   ENFILE} — those fall to the wait-or-bail return at :99 and come back as
//   false). What reaches this token is the loud set: a full disk, a read-only
//   filesystem, a missing or malformed vault path. Every one is a hard fault.
//   Classifying it as benign would silently suppress a disk-full server.
//
// • `other` IS REACHABLE ONLY FROM THE ok:true SIDE (see classify below), which
//   is what turns it from a hole into a DRIFT TRIPWIRE: a new `stopped.reason`
//   shows up as a non-zero `other` and nothing else changes silently. Keeping
//   that tripwire meaningful is why the two not-recorded cases below exist.

/** The event name. Queried by EQUALITY everywhere — never `LIKE`. */
export const CHECKPOINT_FAILURE_EVENT = 'signal.checkpoint_failure';

/** Outcome folded to when an ok:true envelope carries an unrecognised stop. */
export const CHECKPOINT_FAILURE_OTHER = 'other';

/**
 * The pinned outcome vocabulary, in `/api/stats` key order.
 *
 * Only `rejected` and `failed` trigger the alert. Both have a benign base rate
 * of zero BY CONSTRUCTION — an unhandled rejection, a disk-full lock failure, a
 * missing prompt, an exhausted retry are never normal operation — which is the
 * same standard the sibling `capture_anomaly` arm earned by measurement.
 * `contended`, `zero_commit`, `provider_stalled` and `other` are recorded and
 * visible in `outcomes_7d`, but do NOT trigger: each is transient or is an
 * unrecognised success shape, so none can be known-non-benign today.
 *
 * The narrowing is SAFE in the direction that matters: an unmatched FAILURE
 * lands in `failed` and alerts, so the non-triggering set can only ever contain
 * shapes that were positively identified as benign.
 */
export const CHECKPOINT_FAILURE_OUTCOMES = Object.freeze([
  'rejected',
  'failed',
  'contended',
  'zero_commit',
  'provider_stalled',
  CHECKPOINT_FAILURE_OTHER,
]);

/** The subset that fires the alert. See the vocabulary note above. */
export const CHECKPOINT_FAILURE_ALERTING = Object.freeze(['rejected', 'failed']);

/**
 * Classify one settlement of an accepted-mode `doCheckpoint` call.
 *
 * @param {object} a
 * @param {*} [a.result] — the RESOLVED value, when it resolved.
 * @param {boolean} [a.rejected] — true when the promise REJECTED instead.
 * @returns {string|null} an outcome from CHECKPOINT_FAILURE_OUTCOMES, or
 *   `null` for the shapes that are deliberately NOT RECORDED AT ALL.
 */
export function classifyCheckpointSettlement({ result, rejected = false } = {}) {
  // Rule 4 — the .catch() path. Never benign: an unhandled rejection is rated
  // the highest-severity fault in this change.
  if (rejected) return 'rejected';

  // Rules 5-6 — the SUCCESS side, and the only side `other` is reachable from.
  if (result?.ok === true) {
    const stopped = result.stopped;

    // NOT RECORDED: a run that simply finished, and the thin-transcript
    // abstention (checkpoint.mjs:805-811 — ok:true, `skipped:'thin_transcript'`,
    // and NO `stopped` key at all). Neither is a stop worth a failure row, and
    // abstention is already counted as capture.checkpoint outcome:'abstained'.
    //
    // This is narrower than a literal reading of "any remaining ok:true shape
    // → other", and deliberately so: abstention is the LIKELIEST outcome of a
    // minimal probe session, so folding it into `other` would make the drift
    // tripwire non-zero in routine operation and destroy the only thing it is
    // for. `other` must mean "an unrecognised STOP", not "a quiet success".
    if (!stopped) return null;

    const reason = stopped.reason;

    // NOT RECORDED: the two by-design self-imposed stops that leave backlog
    // behind. Both are normal (spec Durability), both are owned and reported by
    // um-drain.sh — which is NOT an opt-in caller, so accepted mode does not
    // touch it — and counting either would fire the rollback trigger on routine
    // traffic.
    //   • chunk_cap  (checkpoint.mjs:484) — the per-run chunk cap; the drain
    //     loop resolves it by looping.
    //   • cost_cap   (checkpoint.mjs:711) — the MID-RUN per-project-per-day cap,
    //     always a success envelope because committed chunks stay committed.
    //     Do not confuse it with the RUN-START cap (checkpoint.mjs:307), which
    //     resolves `ok:false, error:'cost cap hit'` and therefore alerts via the
    //     residual (rule 3) like any other resolved failure. That is what makes
    //     a persistently capped project visible: the NEXT run's start-check
    //     fires. Recording the mid-run stop as well would add nothing but noise.
    if (reason === 'chunk_cap' || reason === 'cost_cap') return null;

    // Zero chunks committed behind a raw lock. The envelope field is
    // `chunks_done`, SNAKE_CASE (successEnvelope, checkpoint.mjs:829;
    // um-drain.sh:183 reads it by that name). `chunksDone` is the INTERNAL
    // accumulator — reading that off the envelope yields `undefined === 0` and
    // the term ships DEAD. Assert this one off a real envelope, never a
    // hand-built object.
    if (reason === 'raw_lock' && result.chunks_done === 0) return 'zero_commit';

    // A summarizer failure AFTER at least one chunk committed, so the run
    // reports success with a backlog it did not finish (checkpoint.mjs:729-735).
    if (reason === 'provider_failure' || reason === 'provider_ratelimit') return 'provider_stalled';

    // An ok:true envelope carrying a stop this vocabulary does not recognise.
    // Folded, never skipped — for an alarm feed a dropped row is a missed alarm.
    return CHECKPOINT_FAILURE_OTHER;
  }

  // Rules 1-2 — the ONLY two positively-matched failure cases.
  const error = result?.error;
  // Exact string (checkpoint.mjs:267).
  if (error === 'checkpoint_in_progress') return 'contended';
  // The coded object (checkpoint.mjs:749); EBUSY is normalised into the same
  // code at :741. Naming it explicitly matters — leaving it unclassified would
  // fold a transient into the alerting set.
  if (error?.code === 'STATE_LOCK_CONTENTION') return 'contended';

  // Rule 3 — THE RESIDUAL. Every other settlement that is not a positively
  // identified success shape and not one of the two contention cases. NO TOKEN
  // IS READ. This is what makes `lock_acquire_failed: ENOSPC`, a run-start cost
  // cap, a missing summarize prompt, a bad since/until, a non-contention
  // phase-2 failure, UPSTREAM_FAILURE, SERVER_INTERNAL — and any malformed or
  // future settlement shape — all alert without any of them being named.
  return 'failed';
}
