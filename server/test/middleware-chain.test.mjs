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
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

const fakeMemory = {
  getAll: async () => ({
    results: [{ id: 'mem0-uuid-1', memory: 'm', metadata: { id: 'doc-1', title: 't' } }],
  }),
};

// Start a server with UM_AUTH_TOKEN pinned to the given value. Returns
// { port, close, url } — url(path) builds a full loopback URL.
async function startServer({ token, memory }) {
  const prev = process.env.UM_AUTH_TOKEN;
  process.env.UM_AUTH_TOKEN = token;
  const srv = createServer(createRequestHandler({ memory }));
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
  const srv = createServer(createRequestHandler({ memory: fakeMemory }));
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

test('401 upgrade hint — unknown User-Agent gets plugin-upgrade message', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'), {
      headers: { 'X-Forwarded-For': '1.2.3.4' }, // force auth
    });
    const body = await r.json();
    assert.match(body.error.message, /upgrade plugin to v0\.6\+/);
  } finally { await close(); }
});

test('401 upgrade hint — um-cli UA gets terse message (no upgrade hint)', async () => {
  const { close, url } = await startServer({ token: 'secret-token', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'), {
      headers: {
        'X-Forwarded-For': '1.2.3.4',
        'User-Agent': 'um-cli/0.6',
      },
    });
    const body = await r.json();
    assert.doesNotMatch(body.error.message, /upgrade plugin/);
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
  const srv = createServer(createRequestHandler({ memory }));
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
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  process.env.UM_VAULT_DIR = await mkdtemp(path.join(tmpdir(), 'um-b6b-'));
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
