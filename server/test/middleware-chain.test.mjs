/**
 * Middleware-chain integration tests (Task B.6 — spec §4.2 step 3-7).
 *
 * Pins the entry-point middleware block in createRequestHandler:
 *   1. /health bypasses auth (endpoint-class policy).
 *   2. /api/* from non-loopback (simulated via forwarded header) with
 *      missing / wrong / correct bearer → 401 / 401 / 200.
 *   3. /api/* from pure loopback (no forwarded header) bypasses auth
 *      by default (UM_ALLOW_LOOPBACK_NOAUTH=true).
 *   4. /api/* from loopback + Cf-Connecting-Ip present → 401 (§4.2
 *      forwarded-header default-deny).
 *   5. Server started with UM_AUTH_TOKEN unset → 500 SERVER_INTERNAL on
 *      any non-bypassed path.
 *   6. 401 body carries the round-8 upgrade hint for unknown UAs, and
 *      the terse message for um-cli/um-bridge/um-plugin UAs.
 *
 * Uses the same ephemeral-port pattern as api-list-wire-shape.test.mjs
 * so the full createServer → socket → response path is exercised.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../mem0-mcp-http.mjs';
import { tempDir } from './helpers/tmpdir.mjs';
import { MCP_HANDSHAKE_BUCKET, MCP_HANDSHAKE_BODY_MAX } from '../lib/rate-limit.mjs';

const fakeMemory = {
  getAll: async () => ({
    results: [{ id: 'mem0-uuid-1', memory: 'm', metadata: { id: 'doc-1', title: 't' } }],
  }),
};

// #231 mem0ai 3.x seam: /api/list and /health enumerate through lib/mem0-read's
// native scroll instead of memory.getAll(); ctx._umGetAll is the production DI
// override, bridged back onto fakeMemory so the fixture above stays authoritative.
const fakeGetAll = async (memory, args) => memory.getAll(args);

// Start a server with UM_AUTH_TOKEN pinned to the given value. Returns
// { port, close, url } — url(path) builds a full loopback URL.
async function startServer({ token, memory }) {
  const prev = process.env.UM_AUTH_TOKEN;
  process.env.UM_AUTH_TOKEN = token;
  const srv = createServer(createRequestHandler({ memory, _umGetAll: fakeGetAll }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    if (prev === undefined) delete process.env.UM_AUTH_TOKEN;
    else process.env.UM_AUTH_TOKEN = prev;
  };
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  return { port, close, url };
}

test('/health bypasses auth — no token required', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/health'));
    assert.equal(r.status, 200);
  } finally { await close(); }
});

test('/api/list with missing Authorization header from non-loopback simulated → 401 AUTH_INVALID', async () => {
  // Can't easily fake non-loopback IP in test (fetch from 127.0.0.1 is loopback).
  // Instead, set a forwarded header to trigger the default-deny path while still
  // fetching from loopback — shouldBypassLoopback() returns false when any of
  // the 10 FORWARDED_HEADERS are present.
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'), { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'AUTH_INVALID');
  } finally { await close(); }
});

test('/api/list with wrong token → 401', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'), {
      headers: { 'Authorization': 'Bearer wrong-token', 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('/api/list with correct token → 200', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'), {
      headers: { 'Authorization': 'Bearer secret-token', 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.results));
  } finally { await close(); }
});

test('/api/list from loopback (default UM_ALLOW_LOOPBACK_NOAUTH=true) with no token → 200', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list')); // pure loopback, no forwarded headers
    assert.equal(r.status, 200);
  } finally { await close(); }
});

test('/api/list loopback + Cf-Connecting-Ip present → 401 (forwarded-header default-deny)', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'), { headers: { 'Cf-Connecting-Ip': '1.2.3.4' } });
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('server with no UM_AUTH_TOKEN env set → 500 SERVER_INTERNAL', async () => {
  // Start server with undefined token. Any non-bypassed path hits the
  // "no token configured" branch and returns 500 SERVER_INTERNAL.
  const prev = process.env.UM_AUTH_TOKEN;
  delete process.env.UM_AUTH_TOKEN;
  const srv = createServer(createRequestHandler({ memory: fakeMemory, _umGetAll: fakeGetAll }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/list`, {
      headers: { 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.error.code, 'SERVER_INTERNAL');
  } finally {
    srv.close();
    await once(srv, 'close');
    if (prev !== undefined) process.env.UM_AUTH_TOKEN = prev;
  }
});

test('401 setup hint — unknown User-Agent is told where the token lives and how to set up', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'), {
      headers: { 'X-Forwarded-For': '1.2.3.4' }, // force auth
    });
    const body = await r.json();
    assert.match(body.error.message, /~\/\.um\/auth-token/);
    assert.match(body.error.message, /\/um-setup/);
    // The old hint sent people to a plugin copy Claude Code never loads.
    assert.doesNotMatch(body.error.message, /--plugin-cc|upgrade plugin/);
  } finally { await close(); }
});

test('401 setup hint — um-cli UA gets terse message (no setup hint)', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'), {
      headers: {
        'X-Forwarded-For': '1.2.3.4',
        'User-Agent': 'um-cli/0.6',
      },
    });
    const body = await r.json();
    assert.doesNotMatch(body.error.message, /um-setup|auth-token/);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Task B.6b — request-body size cap (spec §5.2 precedence 1: fires FIRST).
// Body cap (UM_HTTP_MAX_REQUEST_BYTES, default 2 MB) rejects oversize bodies
// at the HTTP parser level BEFORE JSON-parse or field-level validators run.
// Over-cap → 413 INPUT_TOO_LARGE with the v0.6 envelope.
// Field-level MAX_CONTENT_BYTES (append-turn content) also emits
// INPUT_TOO_LARGE — same caller action (send less data).
// ---------------------------------------------------------------------------

// Small helper: spin up a server with a custom UM_HTTP_MAX_REQUEST_BYTES cap.
async function startServerWithCap({ capBytes, token, memory }) {
  const prevCap = process.env.UM_HTTP_MAX_REQUEST_BYTES;
  const prevTok = process.env.UM_AUTH_TOKEN;
  if (capBytes !== undefined) process.env.UM_HTTP_MAX_REQUEST_BYTES = String(capBytes);
  if (token !== undefined) process.env.UM_AUTH_TOKEN = token;
  const srv = createServer(createRequestHandler({ memory, _umGetAll: fakeGetAll }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    if (prevCap === undefined) delete process.env.UM_HTTP_MAX_REQUEST_BYTES;
    else process.env.UM_HTTP_MAX_REQUEST_BYTES = prevCap;
    if (prevTok === undefined) delete process.env.UM_AUTH_TOKEN;
    else process.env.UM_AUTH_TOKEN = prevTok;
  };
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  return { port, close, url };
}

test('B.6b: request body over UM_HTTP_MAX_REQUEST_BYTES → 413 INPUT_TOO_LARGE', async () => {
  // 1 KB cap, 2 KB body → must be rejected at HTTP-parser level with
  // the v0.6 INPUT_TOO_LARGE envelope (spec §5.2 precedence 1).
  const { close, url } = await startServerWithCap({
    capBytes: 1024,
    token: 'secret',
    memory: fakeMemory,
  });
  try {
    const body = 'x'.repeat(2048);
    const r = await fetch(url('/api/reindex'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer secret' },
      body,
    });
    assert.equal(r.status, 413);
    const json = await r.json();
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'INPUT_TOO_LARGE');
    assert.equal(json.error.retryable, false);
  } finally { await close(); }
});

// The cap reads like every numeric env knob (lib/env-number.mjs): '1024x' was read as 1024,
// a cap the operator never set; a malformed value is no override, so the 2 MB default holds.
test('B.6b: a malformed UM_HTTP_MAX_REQUEST_BYTES falls back to the 2 MB default', async () => {
  const { close, url } = await startServerWithCap({
    capBytes: '1024x',
    token: 'secret',
    memory: fakeMemory,
  });
  try {
    const r = await fetch(url('/api/reindex'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer secret' },
      body: JSON.stringify({ pad: 'x'.repeat(2048) }),
    });
    assert.notEqual(r.status, 413, 'a 2 KB body is under the 2 MB default');
  } finally { await close(); }
});

test('B.6b: body cap rejects via Content-Length header (pre-read short-circuit)', async () => {
  // If Content-Length exceeds the cap, we should reject before even reading
  // the body stream. Set a tiny cap so any body header trips it.
  const { close, url } = await startServerWithCap({
    capBytes: 512,
    token: 'secret',
    memory: fakeMemory,
  });
  try {
    const body = 'x'.repeat(4096);
    const r = await fetch(url('/api/reindex'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret',
        'Content-Length': String(body.length),
      },
      body,
    });
    assert.equal(r.status, 413);
    const json = await r.json();
    assert.equal(json.error.code, 'INPUT_TOO_LARGE');
  } finally { await close(); }
});

test('B.6b: small body within cap proceeds to handler normally', async () => {
  // Default cap is 2 MB; a tiny health check is well under any cap.
  const { close, url } = await startServerWithCap({
    capBytes: undefined,  // leave default
    token: 'secret',
    memory: fakeMemory,
  });
  try {
    const r = await fetch(url('/health'));
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.ok, true);
  } finally { await close(); }
});

test('B.6b: body cap applies to /api/search (POST) as well as /api/reindex', async () => {
  // Generalize — any POST endpoint that hits readBody() must see the cap.
  const { close, url } = await startServerWithCap({
    capBytes: 1024,
    token: 'secret',
    memory: fakeMemory,
  });
  try {
    const body = JSON.stringify({ query: 'x'.repeat(2048) });
    const r = await fetch(url('/api/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer secret' },
      body,
    });
    assert.equal(r.status, 413);
    const json = await r.json();
    assert.equal(json.error.code, 'INPUT_TOO_LARGE');
  } finally { await close(); }
});

test('B.6b: field-level content cap fires INPUT_TOO_LARGE (not INPUT_INVALID) via POST /api/append-turn', async () => {
  // Body is within request-body cap (default 2MB), but content field exceeds
  // MAX_CONTENT_BYTES (8 KB). Per spec §5.2, field-level size violations
  // MUST emit INPUT_TOO_LARGE — same code as the body cap, same caller action
  // (send less data). v0.5 shipped this as a plain-string error; v0.6
  // migrates it to the INPUT_TOO_LARGE envelope.
  //
  // Requires UM_MCP_WRITE_ENABLED=true (otherwise the handler 403s first),
  // and UM_VAULT_DIR so doAppendTurn can reach its field validator.
  const prevWrites = process.env.UM_MCP_WRITE_ENABLED;
  const prevVault = process.env.UM_VAULT_DIR;
  process.env.UM_MCP_WRITE_ENABLED = 'true';
  // Point at a tmp vault so append-turn's field validator runs before any FS write
  process.env.UM_VAULT_DIR = tempDir('um-b6b-');
  const { close, url } = await startServer({ token: 'secret', memory: fakeMemory });
  try {
    const body = JSON.stringify({
      project: 'p',
      role: 'user',
      content: 'x'.repeat(9000),  // > 8192-byte MAX_CONTENT_BYTES
    });
    const r = await fetch(url('/api/append-turn'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer secret' },
      body,
    });
    assert.equal(r.status, 413);
    const json = await r.json();
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'INPUT_TOO_LARGE');
  } finally {
    await close();
    if (prevWrites === undefined) delete process.env.UM_MCP_WRITE_ENABLED;
    else process.env.UM_MCP_WRITE_ENABLED = prevWrites;
    if (prevVault === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = prevVault;
  }
});

// ---------------------------------------------------------------------------
// Task C.7 — rate-limit middleware (spec §4.2 step 5).
//
// Wires createRateLimiter() (C.6) into the chain between auth (step 4) and
// handler dispatch (step 6+). Bypass conditions match auth: route.bypassRateLimit
// (endpoint-class) OR shouldBypassLoopback(req) (loopback + no forwarded headers).
// 429 responses use the §5.1 unified envelope with LIMIT_RATE_EXCEEDED, plus
// Retry-After header in seconds (RFC 7231 §7.1.3). The 429 status flows
// through the C.5 res.end shim so um_http_requests_total{status="429"}
// increments alongside 2xx and 4xx counters.
// ---------------------------------------------------------------------------

// Helper to spin up a server with custom rate-limit env knobs. The
// limiter is constructed at createRequestHandler() time so env MUST be
// set BEFORE startServerWithRateLimit() returns its handler.
async function startServerWithRateLimit({ rpm, burst, token, memory }) {
  const prevRpm = process.env.UM_RATE_LIMIT_RPM;
  const prevBurst = process.env.UM_RATE_LIMIT_BURST;
  const prevTok = process.env.UM_AUTH_TOKEN;
  if (rpm !== undefined) process.env.UM_RATE_LIMIT_RPM = String(rpm);
  if (burst !== undefined) process.env.UM_RATE_LIMIT_BURST = String(burst);
  if (token !== undefined) process.env.UM_AUTH_TOKEN = token;
  const srv = createServer(createRequestHandler({ memory, _umGetAll: fakeGetAll }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    if (prevRpm === undefined) delete process.env.UM_RATE_LIMIT_RPM;
    else process.env.UM_RATE_LIMIT_RPM = prevRpm;
    if (prevBurst === undefined) delete process.env.UM_RATE_LIMIT_BURST;
    else process.env.UM_RATE_LIMIT_BURST = prevBurst;
    if (prevTok === undefined) delete process.env.UM_AUTH_TOKEN;
    else process.env.UM_AUTH_TOKEN = prevTok;
  };
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  return { port, close, url };
}

test('C.7: over-limit request returns 429 LIMIT_RATE_EXCEEDED with Retry-After header', async () => {
  // burst=2 → 1st + 2nd admit, 3rd denies. X-Forwarded-For forces the
  // non-loopback path so loopback-bypass doesn't skip rate-limit.
  const { close, url } = await startServerWithRateLimit({
    rpm: 60, burst: 2, token: 'secret', memory: fakeMemory,
  });
  try {
    // Fire 3 requests sequentially with the same forwarded IP so they
    // all hit the same bucket. Sequential await keeps ordering deterministic
    // (concurrent admit() calls would still serialize through the Map but
    // the assertion order would be ambiguous).
    const results = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(url('/api/list'), {
        headers: {
          'Authorization': 'Bearer secret',
          'X-Forwarded-For': '203.0.113.7',
        },
      });
      results.push(r);
      // Drain bodies to free the socket — fetch keeps connections alive
      // and a pending body would queue subsequent requests behind it.
      await r.text();
    }
    assert.equal(results[0].status, 200, 'first request admits');
    assert.equal(results[1].status, 200, 'second request admits (burst=2)');
    assert.equal(results[2].status, 429, 'third request denies');
    const retryAfter = results[2].headers.get('retry-after');
    assert.ok(retryAfter, 'Retry-After header MUST be set');
    assert.match(retryAfter, /^\d+$/, 'Retry-After is integer seconds (RFC 7231)');
    assert.ok(parseInt(retryAfter, 10) >= 1, 'Retry-After is >= 1');
  } finally { await close(); }
});

test('C.7: 429 response body uses §5.1 unified envelope (LIMIT_RATE_EXCEEDED, retryable:true)', async () => {
  const { close, url } = await startServerWithRateLimit({
    rpm: 60, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    // 1st admits, 2nd denies — same forwarded IP keeps both on one bucket.
    const r1 = await fetch(url('/api/list'), {
      headers: { 'Authorization': 'Bearer secret', 'X-Forwarded-For': '203.0.113.8' },
    });
    await r1.text();
    assert.equal(r1.status, 200);
    const r2 = await fetch(url('/api/list'), {
      headers: { 'Authorization': 'Bearer secret', 'X-Forwarded-For': '203.0.113.8' },
    });
    assert.equal(r2.status, 429);
    const body = await r2.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'LIMIT_RATE_EXCEEDED');
    assert.equal(body.error.retryable, true);
    assert.equal(typeof body.error.message, 'string');
  } finally { await close(); }
});

test('C.7: /health bypasses rate-limit even at high request rates', async () => {
  // burst=1 — would 429 immediately on /api/list. /health should sail
  // through every time because route.bypassRateLimit=true for it.
  const { close, url } = await startServerWithRateLimit({
    rpm: 60, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    for (let i = 0; i < 25; i++) {
      const r = await fetch(url('/health'), {
        headers: { 'X-Forwarded-For': '203.0.113.9' },
      });
      await r.text();
      assert.equal(r.status, 200, `request ${i + 1}: /health must not 429`);
    }
  } finally { await close(); }
});

test('C.7: /metrics from loopback bypasses rate-limit (loopback-only default)', async () => {
  // /metrics defaults to loopback-only. From the test process (127.0.0.1)
  // it returns 200 + Prometheus text exposition. burst=1 would 429 a
  // /api/list path immediately, but /metrics has bypassRateLimit=true.
  const { close, url } = await startServerWithRateLimit({
    rpm: 60, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    for (let i = 0; i < 25; i++) {
      // No X-Forwarded-For: pure loopback hits the loopback /metrics row
      // which returns bypassRateLimit:true.
      const r = await fetch(url('/metrics'));
      await r.text();
      assert.equal(r.status, 200, `request ${i + 1}: /metrics must not 429`);
    }
  } finally { await close(); }
});

test('C.7: loopback IP with no forwarded headers bypasses rate-limit (matches auth bypass)', async () => {
  // Pure loopback (no forwarded headers) — shouldBypassLoopback() returns
  // true. C.7 mirrors the auth-bypass condition: rate-limit also skipped.
  // burst=1 would normally allow 1 request, but loopback-bypass means
  // unlimited. 25 rapid /api/list hits all 200.
  const { close, url } = await startServerWithRateLimit({
    rpm: 60, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    for (let i = 0; i < 25; i++) {
      const r = await fetch(url('/api/list')); // pure loopback, no X-F-F
      await r.text();
      assert.equal(r.status, 200, `request ${i + 1}: loopback bypass must skip rate-limit`);
    }
  } finally { await close(); }
});

test('C.7: forwarded header forces rate-limit even from loopback IP', async () => {
  // X-Forwarded-For present → shouldBypassLoopback()=false (default-deny
  // per spec §4.2). Auth applies AND rate-limit applies. burst=1 means
  // 1st admits, 2nd 429s.
  const { close, url } = await startServerWithRateLimit({
    rpm: 60, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    const r1 = await fetch(url('/api/list'), {
      headers: { 'Authorization': 'Bearer secret', 'X-Forwarded-For': '198.51.100.42' },
    });
    await r1.text();
    assert.equal(r1.status, 200);
    const r2 = await fetch(url('/api/list'), {
      headers: { 'Authorization': 'Bearer secret', 'X-Forwarded-For': '198.51.100.42' },
    });
    assert.equal(r2.status, 429, 'forwarded header opts out of loopback bypass — rate-limit kicks in');
    await r2.text();
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// MCP handshake metering (2026-10-23 UTC restore burst). /mcp is charged per
// JSON-RPC message: the handshake a client sends on every connect draws on its
// own bounded bucket, so it never spends the shared one, while tools/call — and
// every other message that is not on the handshake list — still pays the
// shared bucket. A POST that declares a body over MCP_HANDSHAKE_BODY_MAX (or
// none) pays the shared bucket before its body is read. Non-POST /mcp answers a
// static 405. rpm:1 keeps shared refill negligible, so each assertion counts
// tokens exactly.
// ---------------------------------------------------------------------------

const MCP_HEADERS = {
  'Authorization': 'Bearer secret',
  'X-Forwarded-For': '192.0.2.50',
  'Content-Type': 'application/json',
};

async function mcpPost(url, message) {
  const r = await fetch(url('/mcp'), {
    method: 'POST',
    headers: MCP_HEADERS,
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

// The exact sequence Claude Code 2.1.308 sent per connect on 2026-10-23 (Pi
// request log): server/discover, initialize, notifications/initialized, the
// GET that probes for an SSE stream, tools/list.
async function claudeCodeHandshake(url) {
  const statuses = [];
  statuses.push((await mcpPost(url, { jsonrpc: '2.0', id: 0, method: 'server/discover' })).status);
  statuses.push((await mcpPost(url, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  })).status);
  statuses.push((await mcpPost(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status);
  const sse = await fetch(url('/mcp'), { headers: { ...MCP_HEADERS, Accept: 'text/event-stream' } });
  await sse.text();
  statuses.push(sse.status);
  statuses.push((await mcpPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status);
  return statuses;
}

test('MCP metering: twelve back-to-back handshakes never draw on the shared bucket', async () => {
  const { close, url } = await startServerWithRateLimit({
    rpm: 1, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    for (let i = 0; i < 12; i++) {
      const statuses = await claudeCodeHandshake(url);
      assert.deepEqual(statuses, [200, 200, 202, 405, 200], `handshake ${i + 1}`);
    }
    // The bucket's single token is still there — the REST surface still pays.
    const r1 = await fetch(url('/api/list'), { headers: MCP_HEADERS });
    await r1.text();
    assert.equal(r1.status, 200, 'the handshakes left the token unspent');
    const r2 = await fetch(url('/api/list'), { headers: MCP_HEADERS });
    await r2.text();
    assert.equal(r2.status, 429, 'REST routes stay metered');
  } finally { await close(); }
});

test('MCP metering: tools/call still pays, and its 429 keeps the unified envelope', async () => {
  const { close, url } = await startServerWithRateLimit({
    rpm: 1, burst: 2, token: 'secret', memory: fakeMemory,
  });
  try {
    const call = (id) => mcpPost(url, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_list', arguments: {} },
    });
    assert.equal((await call(1)).status, 200);
    assert.equal((await call(2)).status, 200);
    const denied = await call(3);
    assert.equal(denied.status, 429, 'third tools/call exceeds burst=2');
    assert.match(denied.headers.get('retry-after') ?? '', /^\d+$/);
    const body = JSON.parse(denied.text);
    assert.equal(body.error.code, 'LIMIT_RATE_EXCEEDED');
    assert.equal(body.error.retryable, true);
  } finally { await close(); }
});

test('MCP metering: a method off the handshake list and a body that does not parse both pay', async () => {
  // burst=1: the unknown method spends the token, so the malformed body 429s.
  // Were either one free, the second request would answer 200.
  const { close, url } = await startServerWithRateLimit({
    rpm: 1, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    const unknown = await mcpPost(url, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'x' } });
    assert.equal(unknown.status, 200, 'answered with JSON-RPC method-not-found');
    const malformed = await mcpPost(url, 'not json');
    assert.equal(malformed.status, 429);
  } finally { await close(); }
});

test('MCP metering: a JSON-RPC batch pays even when every member is a handshake method', async () => {
  const { close, url } = await startServerWithRateLimit({
    rpm: 1, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    const batch = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }];
    assert.equal((await mcpPost(url, batch)).status, 202, 'the first batch spends the token');
    const second = await mcpPost(url, batch);
    assert.equal(second.status, 429, 'a batch is not on the handshake list');
  } finally { await close(); }
});

test('GET and DELETE /mcp answer 405 with Allow: POST (no SSE stream, no client session termination)', async () => {
  const { close, url } = await startServerWithRateLimit({
    rpm: 1, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(url('/mcp'), { method, headers: { ...MCP_HEADERS, Accept: 'text/event-stream' } });
      const body = await r.json();
      assert.equal(r.status, 405, `${method} /mcp`);
      assert.equal(r.headers.get('allow'), 'POST');
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, null);
      assert.equal(typeof body.error.code, 'number');
    }
  } finally { await close(); }
});

test('GET /mcp without a token still answers 401 — auth runs before the 405', async () => {
  const { close, url } = await startServerWithRateLimit({
    rpm: 60, burst: 10, token: 'secret', memory: fakeMemory,
  });
  try {
    const r = await fetch(url('/mcp'), { headers: { 'X-Forwarded-For': '192.0.2.51' } });
    await r.text();
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('MCP metering: handshake traffic has its own bounded bucket', async () => {
  // A client stuck in a reconnect loop sends exactly this traffic, so it must
  // still hit a ceiling — just not the shared one.
  const { close, url } = await startServerWithRateLimit({
    rpm: 1, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    const ping = (id) => mcpPost(url, { jsonrpc: '2.0', id, method: 'ping' });
    for (let i = 0; i < MCP_HANDSHAKE_BUCKET.burst; i++) {
      assert.notEqual((await ping(i)).status, 429, `handshake message ${i + 1} is inside the handshake burst`);
    }
    const extra = [];
    for (let i = 0; i < 10; i++) extra.push(await ping(1000 + i));
    const denied = extra.find((r) => r.status === 429);
    assert.ok(denied, 'past the handshake burst, handshake messages 429');
    assert.equal(JSON.parse(denied.text).error.code, 'LIMIT_RATE_EXCEEDED');
    // The shared bucket's single token is untouched by all of that.
    const call = await mcpPost(url, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_list', arguments: {} },
    });
    assert.equal(call.status, 200, 'the handshake bucket ran dry, the shared one did not');
  } finally { await close(); }
});

test('MCP metering: a body over MCP_HANDSHAKE_BODY_MAX pays the shared bucket, whatever its method', async () => {
  const { close, url } = await startServerWithRateLimit({
    rpm: 1, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    const padded = { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(MCP_HANDSHAKE_BODY_MAX) } };
    assert.equal((await mcpPost(url, padded)).status, 200, 'the first spends the token');
    assert.equal((await mcpPost(url, padded)).status, 429, 'a padded handshake method is not free');
  } finally { await close(); }
});

// Sends only the headers of a POST /mcp that declares `length` body bytes and
// resolves with the status, or 'no-answer' if the server waits for the body.
function postHeadersOnly(port, length) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { ...MCP_HEADERS, 'Content-Length': String(length) },
    }, (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.flushHeaders();
    setTimeout(() => { resolve('no-answer'); req.destroy(); }, 1000);
  });
}

test('MCP metering: an over-limit POST that declares a large body is refused before the body is read', async () => {
  const { close, url, port } = await startServerWithRateLimit({
    rpm: 1, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    const call = await mcpPost(url, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_list', arguments: {} },
    });
    assert.equal(call.status, 200, 'spends the only token');
    assert.equal(await postHeadersOnly(port, MCP_HANDSHAKE_BODY_MAX + 1), 429,
      'refused on its headers, as every request was before the deferred charge');
  } finally { await close(); }
});

test('MCP metering: loopback /mcp with no forwarded header stays unmetered', async () => {
  const { close, url } = await startServerWithRateLimit({
    rpm: 1, burst: 1, token: 'secret', memory: fakeMemory,
  });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(url('/mcp'), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'memory_list', arguments: {} } }),
      });
      await r.text();
      assert.equal(r.status, 200, `loopback tools/call ${i + 1}`);
    }
  } finally { await close(); }
});
