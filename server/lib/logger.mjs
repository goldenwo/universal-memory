// server/lib/logger.mjs
//
// Single source of pino imports — round-9 abstraction invariant.
// v0.7+ OpenTelemetry integration will swap pino for a tracing-aware
// emitter without touching every call site. CI lint test
// (test/lint/no-direct-pino-import.test.mjs) enforces this — DO NOT
// import pino anywhere else in the codebase.
//
// Configuration (spec §4.2 Performance contract):
//   - level: UM_LOG_LEVEL env var, default 'info'.
//   - async transport (sync: false) — Pi 4B SD-card sync-write would
//     be a per-request hot-path penalty.
//   - In tests (UM_LOG_TEST=1 or NODE_ENV=test) the async worker
//     transport is skipped to keep the test runner from hanging on
//     exit while the worker thread settles. Production behavior
//     (async writes) is preserved by default.
//
// Test-sink hook (C.3): `_setLogStreamForTest(stream)` lets a contract
// test inject a custom Writable to capture pino lines without writing
// to real stdout. Resets the cached base logger so the next getLogger()
// returns a fresh instance bound to the captured stream. Test-only.

import pino from 'pino';

let baseLogger;
let testSink = null;

// ---------------------------------------------------------------------------
// G1 / R11 layer 2 — credential redaction.
//
// Two-layer defense:
//   Layer 1 (pino `redact.paths`): structural redaction for known-shape
//     fields (Authorization headers, x-api-key, config.url, params) — fast,
//     uses pino's built-in fast-path.
//   Layer 2 (`formatters.log` value-based censor): walk every string in
//     the log object and rewrite values matching credential patterns
//     (sk-*, sk-ant-*, AIza*, Bearer *). Catches leaks in arbitrary
//     positions (error messages, free-form text) where structural paths
//     don't match.
//
// Performance trade-off: `JSON.parse(JSON.stringify(obj, replacer))`
// walks the entire log object on every emit. Plan §10.5 R11 accepts this
// cost — credential leaks are catastrophic, walking a small log object
// is not. Hot-path callers that need to skip this should not log
// arbitrary err.config blobs.
// ---------------------------------------------------------------------------

const STATIC_KEY_PATTERNS = Object.freeze([
  /sk-ant-[A-Za-z0-9_-]+/g,    // anthropic — must be BEFORE sk-* (sk- would greedy-match this)
  /sk-[A-Za-z0-9_-]+/g,        // openai
  /AIza[A-Za-z0-9_-]+/g,       // google
  /Bearer [A-Za-z0-9_.+/=-]+/g, // generic Authorization header value
  // Gap-3 OAuth credentials — never let an OAuth secret reach the log sink even
  // if a code path accidentally logs a raw token, the operator_token form field,
  // or an authorization-code query value:
  //   * umat_/umrt_ — opaque access/refresh tokens (base64url body).
  //   * operator_token=<value> — the consent form field (urlencoded body or a
  //     re-rendered form blob); redact the VALUE only, keep the key for context.
  //   * code=<value> — the authorization code in a redirect/Location or token
  //     request; same value-only redaction.
  /umat_[A-Za-z0-9_-]+/g,      // OAuth access token
  /umrt_[A-Za-z0-9_-]+/g,      // OAuth refresh token
  // Social-login (GitHub OAuth) credentials — a code path that logs a raw
  // GitHub token (web-flow gho_, or ghp_/ghs_/ghu_/ghr_ personal/server/user/refresh)
  // must not leak it to the sink. The configured client SECRET is captured
  // dynamically in getKeyPatterns() (mirrors UM_AUTH_TOKEN), since its format
  // is not statically known.
  /gh[oprsu]_[A-Za-z0-9]+/g, // GitHub tokens (gho_ web-flow, ghp_/ghs_/ghu_/ghr_)
  // Lookbehind keeps the field name visible and redacts ONLY the value, so a
  // logged `operator_token=hunter2` or `code=abc123` becomes
  // `operator_token=[REDACTED]` / `code=[REDACTED]` (key retained for context).
  /(?<=operator_token=)[^&\s"']+/g, // consent form operator-token value
  /(?<=\bcode=)[^&\s"']+/g,         // authorization-code query/form value
]);

// W6.4 hardening — UM_AUTH_TOKEN value-redaction.
// install.sh generates UM_AUTH_TOKEN as `openssl rand -hex 32` (a 64-char
// lowercase hex string). That format is not matched by any of the four
// static patterns above. Adding a generic 64-hex pattern would over-redact
// (catches innocent SHA-256 digests, etc.). Instead, capture the active
// UM_AUTH_TOKEN value at first-emit and add it as a literal-match pattern
// so any code path that accidentally logs the raw token gets redacted.
//
// Lazy-init at first call so env vars set after module load (test env,
// container entrypoint with deferred env-loading) are still captured.
// Cleared by `_resetKeyPatternsForTest()` so tests can mutate env between cases.
let _patterns = null;
function getKeyPatterns() {
  if (_patterns) return _patterns;
  const patterns = [...STATIC_KEY_PATTERNS];
  const tok = process.env.UM_AUTH_TOKEN;
  if (typeof tok === 'string' && tok.length >= 16) {
    // Escape regex metachars (defensive — install.sh emits hex but custom
    // operator-set tokens may include `-`, `+`, `/`, `=`, etc.).
    const escaped = tok.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    patterns.push(new RegExp(escaped, 'g'));
  }
  // Social-login: the configured GitHub OAuth client secret has no statically
  // known format (GitHub mints arbitrary opaque strings), so capture the active
  // value as a literal-match pattern — same lazy-init + length≥16 guard as
  // UM_AUTH_TOKEN — to redact it if any code path ever logs it raw.
  const ghSecret = process.env.UM_OAUTH_IDP_GITHUB_CLIENT_SECRET;
  if (typeof ghSecret === 'string' && ghSecret.length >= 16) {
    const escaped = ghSecret.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    patterns.push(new RegExp(escaped, 'g'));
  }
  _patterns = Object.freeze(patterns);
  return _patterns;
}

/** @internal — test-only. Clears the lazy-init pattern cache so the next
 * censorString call re-reads UM_AUTH_TOKEN from env. */
export function _resetKeyPatternsForTest() {
  _patterns = null;
}

function censorString(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const re of getKeyPatterns()) out = out.replace(re, '[REDACTED]');
  return out;
}

// R11 layer 1: structural path-based redaction. pino's built-in fast path.
const REDACT_CONFIG = Object.freeze({
  paths: [
    '*.headers.authorization',
    '*.headers["x-api-key"]',
    '*.config.headers.*',
    '*.request.headers.*',
    '*.config.url',
    '*.request.url',
    '*.config.params.*',
  ],
  censor: '[REDACTED]',
});

// R11 layer 2: value-based censor walks every string field via JSON replacer.
// Catches leaks in arbitrary positions (error messages, free-form text) that
// path-based redaction can't reach.
function censorFormatter(obj) {
  try {
    return JSON.parse(JSON.stringify(obj, (k, v) => censorString(v)));
  } catch {
    // Circular reference or other JSON failure — return raw obj.
    // Pino's path-based redact is still in effect; we lose the value-censor
    // pass for this log line only.
    return obj;
  }
}

/**
 * Build a pino logger configured with R11 two-layer credential redaction.
 * Used by tests; production code goes through getLogger() → base() which
 * also applies the same redaction config via buildOptions().
 *
 * @param {object} [opts]
 * @param {NodeJS.WritableStream} [opts.stream] - Destination Writable
 *   (passed to pino as the second positional arg). Tests inject capture
 *   sinks here. Production callers omit this and pino writes to stdout.
 * @returns {import('pino').Logger}
 */
export function makeLogger(opts = {}) {
  const { stream, ...rest } = opts;
  const pinoOptions = { ...buildOptions(), ...rest };
  return stream ? pino(pinoOptions, stream) : pino(pinoOptions);
}

function isTestEnv() {
  return process.env.UM_LOG_TEST === '1'
    || process.env.UM_LOG_TEST === 'true'
    || process.env.NODE_ENV === 'test';
}

function buildOptions() {
  return {
    level: process.env.UM_LOG_LEVEL || 'info',
    base: null,
    // R11 layer 1: see REDACT_CONFIG above. Applies to both production
    // (getLogger() → base()) AND test-only callers (makeLogger).
    redact: REDACT_CONFIG,
    formatters: {
      level: (label) => ({ level: label }),
      // R11 layer 2: see censorFormatter above.
      log: censorFormatter,
    },
  };
}

function base() {
  if (baseLogger) return baseLogger;
  const opts = buildOptions();
  if (testSink) {
    // C.3 contract test: write JSON lines into the injected Writable so
    // tests can parse and assert §5.3 required fields without touching
    // real stdout (would interfere with the test runner's TAP output).
    baseLogger = pino(opts, testSink);
  } else if (isTestEnv()) {
    // Synchronous, in-process write — no worker thread, no exit-hang.
    baseLogger = pino(opts);
  } else {
    // Production: async transport spawns a worker thread so the hot
    // path never blocks on disk I/O.
    baseLogger = pino({
      ...opts,
      transport: {
        target: 'pino/file',
        options: { destination: 1, sync: false },
      },
    });
  }
  return baseLogger;
}

export function getLogger() {
  return base();
}

export function getRequestLogger(requestId) {
  return base().child({ request_id: requestId });
}

/**
 * Test-only: inject a Writable stream as the pino destination. Resets
 * the cached base logger so the next getLogger() rebuilds against the
 * sink. Pass `null` to reset back to the default (test-env synchronous
 * stdout).
 *
 * @param {NodeJS.WritableStream | null} stream
 */
export function _setLogStreamForTest(stream) {
  testSink = stream;
  baseLogger = undefined;
}
