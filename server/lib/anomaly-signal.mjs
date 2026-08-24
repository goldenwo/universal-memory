// server/lib/anomaly-signal.mjs — #267: stop.sh capture-anomaly self-report.
// Owns the `signal.capture_anomaly` event family: constants, reason
// vocabulary, and the POST /api/capture-anomaly handler.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is
// the durable record, same posture as reaction-signal.mjs):
//
// • NAMESPACE BOUNDARY: `signal.capture_anomaly` lives OUTSIDE the pinned
//   `capture.*` namespace ON PURPOSE. `event LIKE 'capture.%'` is a
//   LOAD-BEARING FILTER BOUNDARY in stats.mjs (freshness/last_day_seen,
//   events_today, outcomes_7d all derive from it) — an anomaly row must
//   NEVER advance capture freshness: the self-report exists precisely to
//   distrust that signal during a client-side capture death (the 2026-07-16
//   incident class, where abstained-checkpoint stamps keep freshness green
//   indefinitely). Widening any capture query to match `signal.%` re-opens
//   that blindness; stats.test.mjs pins this byte-identically.
//
// • DOWNGRADE-INERTNESS: no pre-#267 query matches `signal.capture_anomaly`
//   (every counters reader is either `LIKE 'capture.%'` or equality on
//   another event), so a downgraded server reads a counters DB containing
//   anomaly rows with zero behavior change.
//
// • FAMILY-PER-ROUTE (no `kind` discriminator — removed at FCP review): the
//   route maps 1:1 to ANOMALY_EVENT; clients cannot mint event families at
//   all. A future second family (e.g. a session-end anomaly taxonomy, if
//   one is ever MEASURED — the #267 method requires a measured-zero benign
//   base rate before an alarm) clones the route the way /api/reaction did,
//   minting its own `signal.*` event. Every hook on the claude-code plugin
//   shares one X-UM-Source surface, so the EVENT NAME is the hook-family
//   dimension. REVISIT TRIGGER: a THIRD signal family (rule-of-three)
//   reopens the shared-ingest question.
//
// • THE SET, NOT THE REGEX, DECIDES WHAT REACHES THE OUTCOME COLUMN: the
//   regex is a SHAPE gate (400 arm) — and, verified empirically, JS `$`
//   without the m flag anchors at end-of-input, so newline variants like
//   'no-transcript\n' are REJECTED there (unlike Python's re.$, which
//   matches before a trailing newline — do not reason about this regex
//   from Python semantics). Set membership then decides verbatim-vs-
//   `other`: an unknown-but-well-formed reason (a NEWER hook posting to
//   this server) clamps to 'other' and still lands a row — the row's
//   existence is the alarm, its label is secondary; dropping (or 400ing)
//   it would be a missed alarm, and the read side in stats.mjs folds the
//   same way. Never "harden" the clamp into a rejection.
//
// • ADDITIVE-ONLY BODY EVOLUTION: unknown top-level body fields are IGNORED,
//   never 400d — plugin clients update out of band, so a future additive
//   field must be accepted by this already-shipped server.
//
// • `project` is label-only and clamp-not-reject ('' when absent/invalid):
//   unlike append-turn's slug (which derives a filesystem path and hard-
//   fails), this is a counter column and signal delivery is paramount. It
//   has NO read surface (stats keys anomalies by surface); the operator
//   read path is in-container SQL — an accepted forensic-only cost.

import { recordCaptureEvent } from './capture-events.mjs';
import { errorResponse } from './error-envelope.mjs';

/** Pinned event name — one-way door (permanent rows keyed by event). */
export const ANOMALY_EVENT = 'signal.capture_anomaly';

/**
 * v1 reason vocabulary (one-way door PER VALUE — recorded outcomes are
 * permanent; ADDING values is cheap since old servers clamp unknowns to
 * `other`). These are byte-identical to stop.sh's hook.log `skip=` tokens —
 * ONE vocabulary across log, wire, counters column, and um-alert message.
 */
export const ANOMALY_REASON_KEYS = Object.freeze([
  'no-transcript',
  'empty-delta-stalled',
  'empty-delta-filtered',
  'nothing-extracted',
  'bad-stdin',
  'empty-stdin',
  'no-python',
]);

/** Read/write clamp bucket for out-of-vocabulary reasons (see header). */
export const ANOMALY_OTHER = 'other';

// Shape gate for the 400 arm ONLY — the Set gates the outcome column.
// Deliberately NOT exported (review catch): a caller importing this to
// re-validate would bypass the Set clamp this module's header pins.
const ANOMALY_REASON_RE = /^[a-z0-9-]{1,64}$/;

const REASON_SET = new Set(ANOMALY_REASON_KEYS);

// Same charset the hooks sanitize to client-side (stop.sh); label-only here
// — see header. Charset-only (no length anchor): over-long slugs are SLICED
// to 64, never clamped to '' (review catch — stop.sh applies no length cap,
// and dropping the label loses the row's only per-project attribution; same
// posture as surfaceFromHeaders's slice).
const PROJECT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * POST /api/capture-anomaly — record one client-observed capture anomaly as
 * a `signal.capture_anomaly` counter row.
 *
 * Order (pinned by tests): writesEnabled gate (403) → reason shape (400) →
 * Set clamp → project clamp ('') → recordCaptureEvent → 200.
 *
 * @param {{ body: any }} req  - parsed JSON body (route does the parsing).
 * @param {{ status: Function, json: Function }} res - thin res shim
 *   (mem0-mcp-http.mjs route idiom, same as /api/reaction).
 * @param {{ writesEnabled: boolean, surface?: string }} ctx
 */
export async function handleCaptureAnomalyRequest(req, res, ctx) {
  if (!ctx.writesEnabled) {
    // Kill-switch posture shared with append-turn/reaction/checkpoint: a
    // frozen deployment records nothing (its staleness is already visible —
    // freshness ages honestly when captures are off).
    res.status(403).json(errorResponse(
      'INPUT_INVALID',
      'MCP writes disabled; set UM_MCP_WRITE_ENABLED=true and UM_MOUNT_MODE=rw in your .env',
    ));
    return;
  }

  const b = req.body ?? {};
  const reason = b.reason;
  if (typeof reason !== 'string' || !ANOMALY_REASON_RE.test(reason)) {
    res.status(400).json(errorResponse(
      'INPUT_INVALID',
      'reason is required (lowercase [a-z0-9-], 1-64 chars)',
    ));
    return;
  }
  const outcome = REASON_SET.has(reason) ? reason : ANOMALY_OTHER;

  const project = typeof b.project === 'string' && PROJECT_RE.test(b.project)
    ? b.project.slice(0, 64)
    : '';

  // Fire-and-forget shared writer (never throws, never fails the response);
  // a dark counters DB degrades exactly as it does for capture.% events.
  recordCaptureEvent({
    surface: ctx.surface,
    project,
    event: ANOMALY_EVENT,
    outcome,
  });

  // schema_version is DELIBERATELY present (stricter than the /api/reaction
  // clone-source's response, following /api/stats) — do not "harmonize" it
  // away. `outcome` echoes the post-clamp value so clamped reports are
  // visible to clients and tests.
  res.status(200).json({ schema_version: 1, ok: true, outcome });
}
