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

function isTestEnv() {
  return process.env.UM_LOG_TEST === '1'
    || process.env.UM_LOG_TEST === 'true'
    || process.env.NODE_ENV === 'test';
}

function buildOptions() {
  return {
    level: process.env.UM_LOG_LEVEL || 'info',
    base: null,
    formatters: { level: (label) => ({ level: label }) },
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
