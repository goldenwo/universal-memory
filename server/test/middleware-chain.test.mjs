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
