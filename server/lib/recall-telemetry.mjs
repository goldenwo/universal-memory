// server/lib/recall-telemetry.mjs — U2 (#171 Stage A, spec §2 source 3):
// in-process recall telemetry for GET /api/stats.
//
// Two coupled emissions per PRODUCTION search (spec §2/§3):
//   • a `recall.search` counters row through the SAME recordCaptureEvent seam
//     the capture.* events use (additive row, outcome '', no migration) —
//     feeds searches_today / searches_7d;
//   • the serving duration into a memory-only ring buffer (last
//     RING_CAPACITY durations, process-lifetime, reset on restart) — feeds
//     latency_since_boot percentiles, computed at READ time.
//
// GATE (plan U2 R4-b, load-bearing): emission happens ONLY when a surface is
// present. doSearch has ~25 test/eval callers that never thread ctx.surface —
// they must not write counters rows or pollute the ring buffer. Only the
// production HTTP/MCP/compat call sites derive a surface (surfaceFromHeaders,
// 'unknown'/'mem0-compat' fallbacks included — those ARE production traffic).
//
// CLOCK SEAM: this module stores DURATIONS only — callers measure with their
// own clock; percentile computation takes the stored array. No Date.now() here.

import { recordCaptureEvent } from './capture-events.mjs';

/** Spec §2 pinned recall event name (rides the capture-counters schema). */
export const RECALL_EVENTS = Object.freeze({ SEARCH: 'recall.search' });

/** Spec §2: last 512 durations, since boot. */
export const RING_CAPACITY = 512;

/** Spec §3 pinned label (G4: deployment-scoped figure, explicitly marked). */
export const LATENCY_LABEL = 'deployment serving latency (includes engine + embedding time)';

// Module-scope ring buffer — since-boot semantics by construction.
let _durations = [];
let _writeIdx = 0; // next overwrite slot once the ring is full

/**
 * Record one production recall: a recall.search counters row (fire-and-forget
 * via recordCaptureEvent — never throws) + the duration into the ring buffer.
 *
 * No-op when `surface` is absent/empty — the test/eval-caller gate.
 *
 * @param {object} evt
 * @param {string} [evt.surface]    - Production surface; absent ⇒ no emission.
 * @param {number} [evt.durationMs] - Serving duration; non-finite/negative
 *                                    values are skipped (counter still emits).
 */
export function noteRecallSearch({ surface, durationMs } = {}) {
  if (typeof surface !== 'string' || surface.length === 0) return;
  recordCaptureEvent({ surface, project: '', event: RECALL_EVENTS.SEARCH, outcome: '' });
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  if (_durations.length < RING_CAPACITY) {
    _durations.push(durationMs);
  } else {
    _durations[_writeIdx] = durationMs;
    _writeIdx = (_writeIdx + 1) % RING_CAPACITY;
  }
}

/** Snapshot of the stored durations (copy — callers may sort freely). */
export function recallDurations() {
  return [..._durations];
}

/**
 * Nearest-rank percentiles over a duration array (pure — the read-time
 * computation the spec pins; pass recallDurations() for the live ring).
 *
 * @param {number[]} [durations=recallDurations()]
 * @returns {{p50_ms: number|null, p95_ms: number|null, n: number}} p50/p95
 *   null when no samples exist yet (fresh boot).
 */
export function latencySinceBoot(durations = recallDurations()) {
  const n = durations.length;
  if (n === 0) return { p50_ms: null, p95_ms: null, n: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.max(0, Math.ceil(p * n) - 1)];
  return { p50_ms: rank(0.5), p95_ms: rank(0.95), n };
}

/** Test seam: empty the ring buffer (the "restart resets latency" semantics). */
export function _resetRecallTelemetryForTest() {
  _durations = [];
  _writeIdx = 0;
}
