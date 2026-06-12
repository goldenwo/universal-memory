// server/test/log-redaction.test.mjs
//
// G1 / R11 layer 2 — credential redaction tests.
//
// Asserts the two-layer redaction provided by `makeLogger`:
//   1. Pino `redact.paths` strips structurally-known credential fields
//      (Authorization headers, Google query-param `key=`, etc.).
//   2. `formatters.log` value-based censor catches credentials embedded
//      in arbitrary message strings or other free-form positions where
//      no structural path would match (sk-*, sk-ant-*, AIza*, Bearer *).
//
// Each test injects a capture stream into `makeLogger({ stream })` so the
// emitted JSON line lands in an in-memory array — no real stdout, no
// runner interference.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLogger, getLogger, _setLogStreamForTest, _resetKeyPatternsForTest } from '../lib/logger.mjs';

test('pino redacts Authorization header in error context', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ err: { config: { headers: { authorization: 'Bearer sk-leak' } } } }, 'failed');
  assert.equal(captured.length, 1, 'expected exactly one log line emitted');
  assert.ok(!JSON.stringify(captured).includes('sk-leak'));
});

test('pino redacts Google query-param key in URL', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ err: { config: { url: 'https://...?key=AIza-LEAK' } } }, 'failed');
  assert.equal(captured.length, 1, 'expected exactly one log line emitted');
  assert.ok(!JSON.stringify(captured).includes('AIza-LEAK'));
});

test('pino redacts sk-ant-LEAK in arbitrary message strings (value-based censor)', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ msg: 'failed with token sk-ant-LEAK in message' });
  assert.equal(captured.length, 1, 'expected exactly one log line emitted');
  assert.ok(!JSON.stringify(captured).includes('sk-ant-LEAK'));
});

// PRODUCTION-PATH TESTS — getLogger() is what every server call site uses.
// These would have caught the v0.7 FIN-review bug where redaction was wired
// into makeLogger but NOT into the production base() builder. Without these
// tests, the parallel makeLogger config could drift again.

test('PRODUCTION getLogger() applies path-based redaction (Authorization)', () => {
  const captured = [];
  _setLogStreamForTest({ write: (l) => captured.push(JSON.parse(l)) });
  try {
    const log = getLogger();
    log.error({ err: { config: { headers: { authorization: 'Bearer sk-prodleak' } } } }, 'failed');
    assert.equal(captured.length, 1, 'expected exactly one log line emitted via getLogger()');
    assert.ok(
      !JSON.stringify(captured).includes('sk-prodleak'),
      'getLogger() must apply R11 redaction in production',
    );
  } finally {
    _setLogStreamForTest(null);
  }
});

test('PRODUCTION getLogger() applies value-based censor (sk-ant- in message)', () => {
  const captured = [];
  _setLogStreamForTest({ write: (l) => captured.push(JSON.parse(l)) });
  try {
    const log = getLogger();
    log.error({ msg: 'caught error: sk-ant-prodfreelink in cause' });
    assert.equal(captured.length, 1, 'expected exactly one log line via getLogger()');
    assert.ok(
      !JSON.stringify(captured).includes('sk-ant-prodfreelink'),
      'getLogger() must apply value-based censor in production',
    );
  } finally {
    _setLogStreamForTest(null);
  }
});

// W6.4 hardening — UM_AUTH_TOKEN is `openssl rand -hex 32` (a 64-char
// lowercase hex string), which is not matched by any of the four static
// provider patterns. Adding a hex-64 catch-all would over-redact innocent
// SHA digests; the chosen approach captures the active UM_AUTH_TOKEN value
// at first emit and adds it as a literal-match pattern.
test('R11 / W6.4 — active UM_AUTH_TOKEN redacted in arbitrary log strings', () => {
  const fakeToken = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
  const prevToken = process.env.UM_AUTH_TOKEN;
  process.env.UM_AUTH_TOKEN = fakeToken;
  _resetKeyPatternsForTest(); // force re-read of UM_AUTH_TOKEN from env
  try {
    const captured = [];
    const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
    log.error({ msg: `debug dump: token=${fakeToken} in error context` });
    assert.equal(captured.length, 1, 'expected exactly one log line emitted');
    assert.ok(
      !JSON.stringify(captured).includes(fakeToken),
      'UM_AUTH_TOKEN value must be redacted in arbitrary message strings',
    );
  } finally {
    if (prevToken === undefined) delete process.env.UM_AUTH_TOKEN;
    else process.env.UM_AUTH_TOKEN = prevToken;
    _resetKeyPatternsForTest();
  }
});

test('R11 / W6.4 — UM_AUTH_TOKEN absent or short (<16 chars) skips dynamic pattern', () => {
  const prevToken = process.env.UM_AUTH_TOKEN;
  // Absent
  delete process.env.UM_AUTH_TOKEN;
  _resetKeyPatternsForTest();
  let captured = [];
  let log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ msg: 'plain message no token' });
  assert.equal(captured.length, 1);
  // Should not crash; static patterns still apply
  assert.ok(JSON.stringify(captured).includes('plain message no token'));

  // Short (defensive — don't redact a too-short value that would over-match)
  process.env.UM_AUTH_TOKEN = 'short';
  _resetKeyPatternsForTest();
  captured = [];
  log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ msg: 'word containing short fragment' });
  assert.equal(captured.length, 1);
  assert.ok(
    JSON.stringify(captured).includes('short'),
    'sub-16-char UM_AUTH_TOKEN must NOT be added to redaction patterns',
  );

  if (prevToken === undefined) delete process.env.UM_AUTH_TOKEN;
  else process.env.UM_AUTH_TOKEN = prevToken;
  _resetKeyPatternsForTest();
});

// Gap-3 OAuth — credential redaction for OAuth tokens + secret form/query
// fields. A code path that accidentally logs a raw umat_/umrt_ token, the
// consent operator_token field, or an authorization code= value must not leak
// it to the sink.
test('Gap-3 — umat_/umrt_ OAuth tokens redacted in arbitrary log strings', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ msg: 'minted access=umat_AbC123-_d refresh=umrt_XyZ987-_q for owner' });
  assert.equal(captured.length, 1);
  const blob = JSON.stringify(captured);
  assert.ok(!blob.includes('umat_AbC123-_d'), 'umat_ access token must be redacted');
  assert.ok(!blob.includes('umrt_XyZ987-_q'), 'umrt_ refresh token must be redacted');
});

test('Gap-3 — operator_token form value redacted, field name retained', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.warn({ msg: 'consent body: authz_id=ab12&operator_token=hunter2secret&decision=allow' });
  assert.equal(captured.length, 1);
  const blob = JSON.stringify(captured);
  assert.ok(!blob.includes('hunter2secret'), 'operator_token value must be redacted');
  assert.ok(blob.includes('operator_token=[REDACTED]'), 'field name kept, value censored');
});

test('Gap-3 — authorization code= value redacted in a logged URL/Location', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.info({ msg: 'redirect Location: https://claude.ai/api/mcp/auth_callback?code=SECRETCODE123&state=xyz' });
  assert.equal(captured.length, 1);
  const blob = JSON.stringify(captured);
  assert.ok(!blob.includes('SECRETCODE123'), 'authorization code value must be redacted');
  assert.ok(blob.includes('code=[REDACTED]'), 'code field name kept, value censored');
});

test('PRODUCTION getLogger() redacts AIza Google key in URL', () => {
  const captured = [];
  _setLogStreamForTest({ write: (l) => captured.push(JSON.parse(l)) });
  try {
    const log = getLogger();
    log.error({ err: { config: { url: 'https://generativelanguage.googleapis.com/v1/...?key=AIzaProdLeak' } } }, 'failed');
    assert.equal(captured.length, 1, 'expected exactly one log line via getLogger()');
    assert.ok(
      !JSON.stringify(captured).includes('AIzaProdLeak'),
      'getLogger() must redact Google API keys in production URLs',
    );
  } finally {
    _setLogStreamForTest(null);
  }
});
