// server/test/logging-contract.test.mjs
//
// C.3 — §5.3 logging contract tests.
//
// Asserts that every request that flows through the middleware chain
// emits a structured JSON log line with the §5.3-mandated fields. The
// test injects a Writable sink into the pino logger so we can capture
// emitted lines without touching real stdout (which would clash with
// the node:test TAP runner).
//
// §5.3 contract:
//   - REST path: ts, level, request_id, endpoint, status, ms, project
//   - MCP path:  ts, level, request_id, tool, status, ms
//   - Error path adds: error_code, error_class
//
// `endpoint` MUST be the route template (e.g., '/api/recent/:project'),
// not the expanded path — for log-cardinality safety (matches future
// metrics work in C.4).
//
// `error_class` distinguishes:
//   - 'auth_missing' — extractBearer returned null (no/wrong scheme)
//   - 'auth_wrong'   — compareTokens returned false (bad token)
// Wire-response stays AUTH_INVALID 401 either way (attacker can't
// differentiate; ops debugging gets the distinction in logs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { _setLogStreamForTest } from '../lib/logger.mjs';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

// Capture pino lines in-memory. Each chunk is a complete JSON line
// (pino emits one line per call); we parse and append to `captured`.
function makeCaptureSink(captured) {
  return new Writable({
    write(chunk, enc, cb) {
      const text = chunk.toString();
      // pino can emit multiple JSON objects in a single write under
      // back-pressure; split on newlines to be safe.
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          captured.push(JSON.parse(line));
        } catch {
          // Non-JSON line (shouldn't happen with the configured base
          // formatter) — silently ignore so the test doesn't blow up
          // on unrelated output.
        }
      }
      cb();
    },
  });
}

const fakeMemory = {
  getAll: async () => ({
    results: [{ id: 'mem0-uuid-1', memory: 'm', metadata: { id: 'doc-1', title: 't' } }],
  }),
  search: async () => ({ results: [] }),
};

// Spin up an ephemeral server with a captured sink. Returns
// { close, url, captured } — captured is the live array of parsed
// log lines (pushed during request handling).
async function startServerWithSink({ token, memory } = {}) {
  const captured = [];
  _setLogStreamForTest(makeCaptureSink(captured));

  const prevTok = process.env.UM_AUTH_TOKEN;
  if (token !== undefined) process.env.UM_AUTH_TOKEN = token;

  const srv = createServer(createRequestHandler({ memory: memory ?? fakeMemory }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    if (prevTok === undefined) delete process.env.UM_AUTH_TOKEN;
    else process.env.UM_AUTH_TOKEN = prevTok;
    _setLogStreamForTest(null);
  };
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  return { port, close, url, captured };
}

// Find the "request" finish-log among captured entries. Filters by
// presence of `endpoint` (REST) or `tool` (MCP) — discards any
// auxiliary debug/warn lines emitted by the handler internals.
function findRequestLog(captured, predicate) {
  return captured.find(predicate);
}

// ---------------------------------------------------------------------------
// REST path: success
// ---------------------------------------------------------------------------
test('REST success-path log carries §5.3 required fields including project', async () => {
  const { close, url, captured } = await startServerWithSink({ token: 'secret' });
  try {
    const r = await fetch(url('/api/recent/my-proj'));
    assert.equal(r.status, 200);

    const log = findRequestLog(captured, (l) => l.endpoint === '/api/recent/:project');
    assert.ok(log, `expected request-finish log with endpoint=/api/recent/:project; got: ${JSON.stringify(captured)}`);
    assert.ok(typeof log.ts === 'number' || typeof log.time === 'number', '§5.3: ts present');
    assert.ok(typeof log.level === 'string', '§5.3: level present');
    assert.ok(typeof log.request_id === 'string' && log.request_id.length > 0, '§5.3: request_id present');
    assert.equal(log.endpoint, '/api/recent/:project', '§5.3: endpoint is route template, not raw path');
    assert.equal(log.status, 200, '§5.3: status present');
    assert.equal(typeof log.ms, 'number', '§5.3: ms present');
    assert.equal(log.project, 'my-proj', '§5.3: project present on REST path');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// MCP path: success
// ---------------------------------------------------------------------------
test('MCP success-path log carries §5.3 required fields including tool', async () => {
  const { close, url, captured } = await startServerWithSink({ token: 'secret' });
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'test' } },
      }),
    });
    assert.equal(r.status, 200);

    const log = findRequestLog(captured, (l) => l.endpoint === '/mcp' && l.tool);
    assert.ok(log, `expected MCP request-finish log with endpoint=/mcp + tool field; got: ${JSON.stringify(captured)}`);
    assert.ok(typeof log.ts === 'number' || typeof log.time === 'number', '§5.3: ts present');
    assert.ok(typeof log.level === 'string', '§5.3: level present');
    assert.ok(typeof log.request_id === 'string' && log.request_id.length > 0, '§5.3: request_id present');
    assert.equal(log.tool, 'memory_search', '§5.3: tool present on MCP path');
    assert.equal(log.status, 200, '§5.3: status present');
    assert.equal(typeof log.ms, 'number', '§5.3: ms present');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Error path: missing-token (auth_missing)
// ---------------------------------------------------------------------------
test('error-path log carries error_code AND error_class=auth_missing for absent token', async () => {
  const { close, url, captured } = await startServerWithSink({ token: 'secret' });
  try {
    // Force auth via X-Forwarded-For (defeats loopback bypass) without sending
    // an Authorization header → extractBearer returns null → error_class auth_missing.
    const r = await fetch(url('/api/list'), {
      headers: { 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 401);

    const log = findRequestLog(captured, (l) => l.error_code === 'AUTH_INVALID');
    assert.ok(log, `expected auth-failure log with error_code=AUTH_INVALID; got: ${JSON.stringify(captured)}`);
    assert.ok(typeof log.request_id === 'string' && log.request_id.length > 0, '§5.3: request_id present');
    assert.equal(log.status, 401, '§5.3: status present');
    assert.equal(log.error_code, 'AUTH_INVALID', '§5.3: error_code present');
    assert.equal(log.error_class, 'auth_missing', 'C.3: missing-token logs error_class=auth_missing');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Error path: wrong-token (auth_wrong)
// ---------------------------------------------------------------------------
test('error-path log carries error_class=auth_wrong for wrong token (wire-response unchanged)', async () => {
  const { close, url, captured } = await startServerWithSink({ token: 'secret' });
  try {
    const r = await fetch(url('/api/list'), {
      headers: { 'Authorization': 'Bearer wrong-token', 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 401, 'wire-response stays 401 AUTH_INVALID — no attacker leak');
    const body = await r.json();
    assert.equal(body.error.code, 'AUTH_INVALID', 'wire-response code stays AUTH_INVALID');

    const log = findRequestLog(captured, (l) => l.error_code === 'AUTH_INVALID');
    assert.ok(log, `expected auth-failure log with error_code=AUTH_INVALID; got: ${JSON.stringify(captured)}`);
    assert.equal(log.error_code, 'AUTH_INVALID', '§5.3: error_code present');
    assert.equal(log.error_class, 'auth_wrong', 'C.3: bad-token logs error_class=auth_wrong (distinguished from auth_missing)');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// /health opts out of withRequestContext (preserves §4.2.0 100µs budget)
// ---------------------------------------------------------------------------
test('/health does NOT emit a request-finish log (ALS opt-out per §4.2.0)', async () => {
  // /health is the liveness probe — every k8s/load-balancer poll hits it.
  // Wrapping in withRequestContext + emitting a log per probe would burn
  // the 100µs budget and pollute logs. Verify silence.
  const { close, url, captured } = await startServerWithSink({ token: 'secret' });
  try {
    const r = await fetch(url('/health'));
    assert.equal(r.status, 200);

    // Allow async log flush to settle before asserting absence.
    await new Promise((r) => setTimeout(r, 30));

    const healthLog = captured.find((l) => l.endpoint === '/health');
    assert.equal(healthLog, undefined, '/health must not emit a request-finish log line');
  } finally { await close(); }
});
