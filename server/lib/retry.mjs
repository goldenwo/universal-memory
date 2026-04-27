// server/lib/retry.mjs — upstream retry helper for transient mem0/qdrant failures.
//
// Spec §5.4 (memory_checkpoint) + §4.2.2 (jitter):
//   • max UM_UPSTREAM_RETRY_MAX retries (default 3)
//   • exponential backoff 100/200/400 ms (base * 2^attempt)
//   • per-step jitter 0–50 ms
//   • retry-exhaustion surfaces UPSTREAM_FAILURE (B.1 stable-codes table)
//
// Caller marks errors with `.retryable = true/false` to opt in/out of the retry
// path. Errors without that hint default to `retryable: true` because mem0's
// JS client does NOT ship `.retryable` on its rejections — most failures we see
// in practice are transient (qdrant unreachable, network blip), and our own
// validation errors (typeof guards, INPUT_INVALID class) are caught BEFORE
// reaching withRetry. Caller adapters that want to opt out of retry on a
// specific error path should set `.retryable = false` explicitly.
//
// Test hooks: opts.maxRetries / baseDelayMs / jitterMaxMs let unit tests run
// fast (e.g. baseDelayMs:1, jitterMaxMs:0). opts.maxRetries beats env so
// integration tests can override per-call. The §5.4 timing test in
// retry.test.mjs intentionally exercises the real defaults.
//
// ──────────────────────────────────────────────────────────────────────────
// Storm risk acknowledged for v0.6 (R1 review C7):
// withRetry has no circuit breaker. If qdrant is down, every concurrent
// request retries 3× with 100/200/400 ms backoff = ~700 ms tail × N
// in-flight handlers. The per-IP rate-limit (60 RPM, B.6 + C.7) is a
// partial natural throttle but does NOT prevent amplification of a
// downstream outage into upstream resource exhaustion. Acceptable for
// v0.6 single-host operator deployment with bounded concurrency. v0.7
// should add circuit-breaker pattern when external providers join.
// See docs/plans/2026-04-24-v0.6-design.md §4.2.2.
// ──────────────────────────────────────────────────────────────────────────
//
// Metrics integration (R1 review A1, fix #1):
// `opts.op` lets the caller emit `um_mem0_ops_total{op,status}` from a
// single place. When set, withRetry increments the counter exactly once
// per call (success or final failure) — independent of retry count.
// Status='ok' on success, 'fail' on retry-exhaustion or non-retryable.
// Falls through obs-fallback if prom-client throws (cardinality / shape).

import { mem0OpsTotal } from './metrics.mjs';
import { obsFallback } from './obs-fallback.mjs';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_JITTER_MAX_MS = 50;

function emitMem0OpMetric(op, status) {
  if (!op) return;
  try {
    mem0OpsTotal.inc({ op, status });
  } catch (e) {
    obsFallback(e, `metrics:mem0:${op}:${status}`);
  }
}

/**
 * Run `fn` with retry-on-transient-failure.
 *
 * @template T
 * @param {() => Promise<T>} fn       - Async work; thrown errors may carry `.retryable`.
 * @param {object} [opts]
 * @param {number} [opts.maxRetries] - Max retries after the initial call. Beats env.
 *                                     Default: parseInt(UM_UPSTREAM_RETRY_MAX) || 3.
 * @param {number} [opts.baseDelayMs]- Base delay for exponential backoff. Default 100ms.
 * @param {number} [opts.jitterMaxMs]- Max jitter (uniform 0..jitterMaxMs). Default 50ms.
 * @param {string} [opts.op]         - Optional op-label for um_mem0_ops_total emit
 *                                     (e.g., 'add', 'delete', 'getAll', 'reindex').
 *                                     One emit per call regardless of retry count.
 * @returns {Promise<T>}             - Last successful result.
 * @throws {Error & {code:'UPSTREAM_FAILURE', cause:Error}} - On retry-exhaustion or
 *         a non-retryable error. The original error is preserved in `.cause`.
 */
export async function withRetry(fn, opts = {}) {
  const max = opts.maxRetries ?? parseInt(process.env.UM_UPSTREAM_RETRY_MAX || String(DEFAULT_MAX_RETRIES), 10);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitterMaxMs = opts.jitterMaxMs ?? DEFAULT_JITTER_MAX_MS;
  const op = opts.op;

  let lastErr;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      const result = await fn();
      emitMem0OpMetric(op, 'ok');
      return result;
    } catch (e) {
      lastErr = e;
      // Caller opted out of retry for this error class (e.g. validation).
      if (e?.retryable === false) break;
      // Budget exhausted — bail without sleeping (no point in waiting).
      if (attempt === max) break;
      const jitter = jitterMaxMs > 0 ? Math.floor(Math.random() * (jitterMaxMs + 1)) : 0;
      const delay = (baseDelayMs * Math.pow(2, attempt)) + jitter;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Final-failure path: emit one fail metric so success/fail counts add up.
  emitMem0OpMetric(op, 'fail');
  // Wrap in stable UPSTREAM_FAILURE envelope so middleware/error-envelope.mjs
  // can map to HTTP 502 with retryable:true (B.1 stable-codes table).
  throw Object.assign(
    new Error(lastErr?.message || 'upstream failed'),
    { code: 'UPSTREAM_FAILURE', cause: lastErr },
  );
}
