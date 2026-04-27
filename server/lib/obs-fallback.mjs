// server/lib/obs-fallback.mjs
//
// Rate-limited stderr fallback for observability emit failures
// (spec §4.2.0 "observability-never-500s" rule).
//
// Why this exists:
//   pino throws on log-write failure (full disk on the log partition);
//   prom-client throws synchronously on label-cardinality / label-shape
//   violations. C.5 wrapped metrics emits in try/catch and fell back to
//   `getLogger().warn(...)` — but if pino itself is the failing emitter
//   (full disk, transport hiccup), that fallback path recurses into the
//   same broken system. This module writes DIRECTLY to stderr, no pino
//   involvement, so a logging failure can never be the failing emitter
//   in its own fallback.
//
// Why rate-limit:
//   Sustained underlying failure (label-shape bug emitted on every
//   request, full-disk loop) would flood stderr at request rate.
//   At most one emit per minute keeps ops's journal / dashboard
//   readable while still surfacing the problem. Dropped-count is
//   reported when the window reopens so ops can gauge severity.
//
// Test seam:
//   `_setNowForTest(fn)` injects a clock so the time-window assertion
//   doesn't have to sleep. `_resetForTest()` clears the rate-limit
//   state between tests. Both follow the lockdir.mjs convention.

const FALLBACK_INTERVAL_MS = 60_000;

let lastEmittedAt = 0;
let droppedCount = 0;
let nowFn = () => Date.now();

/**
 * Record an observability emit failure. Writes to stderr at most once
 * per FALLBACK_INTERVAL_MS; subsequent failures within the window are
 * silently dropped, with their count surfaced when the window reopens.
 *
 * NEVER throws. Even if process.stderr.write itself fails (extremely
 * unusual — closed-stderr edge case), the exception is swallowed:
 * observability MUST NEVER be in the request-failure path.
 *
 * @param {unknown} err - the error from the failing emit; may be Error,
 *   a string, null/undefined. Best-effort message extraction.
 * @param {string} [context=''] - short tag describing the failing site
 *   (e.g., 'metrics:request:/api/search', 'log:request-finish').
 */
export function obsFallback(err, context = '') {
  try {
    const now = nowFn();
    if (now - lastEmittedAt >= FALLBACK_INTERVAL_MS) {
      const msg = err && typeof err === 'object' && err.message
        ? err.message
        : String(err ?? 'unknown');
      const droppedSuffix = droppedCount > 0
        ? ` (${droppedCount} dropped since last warn)`
        : '';
      const ctxStr = context ? `: ${context}` : '';
      // One JSON-ish-but-stderr-only line per emit. Keep it simple —
      // ops greps for `[obs-fallback]`, no structured-log dependency
      // would defeat the purpose.
      process.stderr.write(
        `[obs-fallback] observability emit failed${droppedSuffix}${ctxStr}: ${msg}\n`
      );
      lastEmittedAt = now;
      droppedCount = 0;
    } else {
      droppedCount++;
    }
  } catch {
    // Last-resort safety: if even stderr.write throws (closed pipe,
    // exotic runtime), swallow. The request path must continue.
  }
}

/**
 * Run a logger emit and route any exception through obsFallback.
 *
 * Convenience wrapper so handler-path log call sites stay single-line:
 *   safeLog(() => getLogger().info(obj, 'request'), 'log:request');
 *
 * The whole point of routing through obs-fallback is that pino itself
 * may be the failing emitter — never recurse back into getLogger() to
 * report the failure.
 *
 * @param {() => void} fn - the emit closure (logger or metric call)
 * @param {string} context - tag for the failure record
 */
export function safeLog(fn, context) {
  try {
    fn();
  } catch (e) {
    obsFallback(e, context);
  }
}

/**
 * Test-only: reset the rate-limit state so each test starts from a
 * clean window.
 */
export function _resetForTest() {
  lastEmittedAt = 0;
  droppedCount = 0;
  nowFn = () => Date.now();
}

/**
 * Test-only: inject a clock function. Pass `null` to restore Date.now.
 *
 * @param {(() => number) | null} fn
 */
export function _setNowForTest(fn) {
  nowFn = fn ?? (() => Date.now());
}
