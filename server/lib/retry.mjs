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

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_JITTER_MAX_MS = 50;

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
 * @returns {Promise<T>}             - Last successful result.
 * @throws {Error & {code:'UPSTREAM_FAILURE', cause:Error}} - On retry-exhaustion or
 *         a non-retryable error. The original error is preserved in `.cause`.
 */
export async function withRetry(fn, opts = {}) {
  const max = opts.maxRetries ?? parseInt(process.env.UM_UPSTREAM_RETRY_MAX || String(DEFAULT_MAX_RETRIES), 10);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitterMaxMs = opts.jitterMaxMs ?? DEFAULT_JITTER_MAX_MS;

  let lastErr;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn();
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
  // Wrap in stable UPSTREAM_FAILURE envelope so middleware/error-envelope.mjs
  // can map to HTTP 502 with retryable:true (B.1 stable-codes table).
  throw Object.assign(
    new Error(lastErr?.message || 'upstream failed'),
    { code: 'UPSTREAM_FAILURE', cause: lastErr },
  );
}
