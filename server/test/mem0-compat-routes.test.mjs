/**
 * Tests for the mem0 Platform-compat facade — Batch 2 (plan Task 3):
 * flag, auth, and dispatch skeleton. Business logic (R2-R11) is Batch 3.
 *
 * Run with: node --test server/test/mem0-compat-routes.test.mjs
 *
 * Pins (spec §6 + §2):
 *   1. endpoint-class ROW for /v1/* + /v2/*: flag-off → {returnStatus:404}
 *      (evaluated at Step-3a BEFORE auth); flag-on → normal path shape
 *      PLUS compat:true (the audit-bound row-shape extension). /api/ and
 *      /mcp rows carry NO compat field.
 *   2. extractCompatToken: accepts `Token <key>` AND `Bearer <key>`;
 *      same return contract as extractBearer. extractBearer untouched.
 *   3. THE ORDERING INVARIANT: flag-off + bad token → 404, not 401.
 *      Pinned both at the row layer (unit) and through the full
 *      createRequestHandler middleware chain (house ephemeral-port
 *      pattern from middleware-chain.test.mjs). S9 smoke re-covers the
 *      integrated ordering on the real Linux stack.
 *   4. Dispatcher skeleton: the 11 spec routes (R11 spans two paths) →
 *      501 {detail:"not implemented (batch 3)"}; unknown compat path →
 *      404 {detail:"unknown compat route"}.
 *   5. NO loopback auth bypass on compat routes (spec §6): a pure-
 *      loopback request with no token → 401, even though /api/* from
 *      the same peer bypasses auth (UM_ALLOW_LOOPBACK_NOAUTH default).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { endpointClassRoute } from '../lib/endpoint-class.mjs';
import { extractBearer, extractCompatToken } from '../lib/auth.mjs';
import { handleMem0Compat } from '../lib/mem0-compat.mjs';
import { createRequestHandler } from '../mem0-mcp-http.mjs';

const req = (pathname, search = '') => ({ url: pathname + search, headers: {} });

// ---------------------------------------------------------------------------
// 1. endpoint-class row — flag-gated /v1/* + /v2/* (spec §6 mechanism 1)
// ---------------------------------------------------------------------------

test('compat row: flag OFF (explicit false) → hard 404 for /v1/* and /v2/*', () => {
  for (const p of ['/v1/memories/', '/v2/memories/search/', '/v1/x', '/v2/x']) {
    assert.deepEqual(endpointClassRoute(req(p), { UM_MEM0_COMPAT_ENABLED: 'false' }), { returnStatus: 404 });
  }
});

test('compat row: flag UNSET (default) → hard 404 (ships inert, spec §2)', () => {
  assert.deepEqual(endpointClassRoute(req('/v1/x'), {}), { returnStatus: 404 });
  assert.deepEqual(endpointClassRoute(req('/v2/x'), {}), { returnStatus: 404 });
});

test('compat row: flag ON → normal path shape PLUS compat:true (auth + rate-limit stay on)', () => {
  for (const p of ['/v1/memories/', '/v2/memories/search/', '/v1/ping/']) {
    assert.deepEqual(endpointClassRoute(req(p), { UM_MEM0_COMPAT_ENABLED: 'true' }),
      { bypassAuth: false, bypassRateLimit: false, compat: true });
  }
});

test('compat row: /v1 and /v2 bare (no trailing slash) do NOT match the prefix row', () => {
  // Boundary guard mirroring the /api row test: the prefix is /v1/ (with
  // slash). Bare /v1 falls to the default-close catch-all — no compat field.
  for (const p of ['/v1', '/v2']) {
    const r = endpointClassRoute(req(p), { UM_MEM0_COMPAT_ENABLED: 'false' });
    assert.deepEqual(r, { bypassAuth: false, bypassRateLimit: false });
  }
});

test('non-compat rows carry NO compat field (flag on or off)', () => {
  for (const env of [{ UM_MEM0_COMPAT_ENABLED: 'true' }, { UM_MEM0_COMPAT_ENABLED: 'false' }]) {
    for (const p of ['/api/list', '/mcp']) {
      const r = endpointClassRoute(req(p), env);
      assert.deepEqual(r, { bypassAuth: false, bypassRateLimit: false });
      assert.equal('compat' in r, false);
    }
    assert.deepEqual(endpointClassRoute(req('/health'), env), { bypassAuth: true, bypassRateLimit: true });
  }
});

// ---------------------------------------------------------------------------
// 2. extractCompatToken (spec §6 mechanism 2) — extractBearer untouched
// ---------------------------------------------------------------------------

test('extractCompatToken accepts the Token scheme', () => {
  assert.equal(extractCompatToken({ headers: { authorization: 'Token abc123' } }), 'abc123');
});

test('extractCompatToken accepts the Bearer scheme', () => {
  assert.equal(extractCompatToken({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
});

test('extractCompatToken returns null on wrong scheme', () => {
  assert.equal(extractCompatToken({ headers: { authorization: 'Basic abc123' } }), null);
});

test('extractCompatToken returns null on absent header', () => {
  assert.equal(extractCompatToken({ headers: {} }), null);
  assert.equal(extractCompatToken({}), null);
});

test('extractCompatToken returns null on empty token', () => {
  assert.equal(extractCompatToken({ headers: { authorization: 'Token' } }), null);
  assert.equal(extractCompatToken({ headers: { authorization: 'Token ' } }), null);
  assert.equal(extractCompatToken({ headers: { authorization: 'Bearer ' } }), null);
});

test('extractBearer still rejects the Token scheme (non-compat routes stay Bearer-only)', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Token abc123' } }), null);
});

// ---------------------------------------------------------------------------
// 3. Dispatcher — handleMem0Compat (unit, offline). Per-route business-logic
//    coverage lives in mem0-compat-handlers.test.mjs (Batch 3); here we pin
//    only the dispatch-layer contract (route match / no-match).
// ---------------------------------------------------------------------------

test('dispatcher: unknown compat path → 404 {detail} (mem0 error dialect)', async () => {
  const out = await handleMem0Compat({ method: 'GET' }, new URL('/v1/nope/', 'http://x'), undefined, {});
  assert.deepEqual(out, { status: 404, body: { detail: 'unknown compat route' } });
});

test('dispatcher: known path with wrong method → 404 {detail} (no route match)', async () => {
  const out = await handleMem0Compat({ method: 'PATCH' }, new URL('/v1/memories/', 'http://x'), undefined, {});
  assert.deepEqual(out, { status: 404, body: { detail: 'unknown compat route' } });
});

// ---------------------------------------------------------------------------
// Full middleware chain — house ephemeral-port pattern
// (middleware-chain.test.mjs). Pins the ORDERING INVARIANT, the auth
// matrix through Step-4's extractor selection, and the no-loopback-bypass
// posture end-to-end. S9 smoke re-covers this on the real Linux stack.
// ---------------------------------------------------------------------------

const fakeMemory = {
  getAll: async () => ({
    results: [{ id: 'mem0-uuid-1', memory: 'm', metadata: { id: 'doc-1', title: 't' } }],
  }),
};

// Start a server with UM_AUTH_TOKEN and UM_MEM0_COMPAT_ENABLED pinned.
// Saves/restores BOTH env vars on close (env hygiene — house pattern).
async function startServer({ token, compatFlag, memory }) {
  const prevTok = process.env.UM_AUTH_TOKEN;
  const prevFlag = process.env.UM_MEM0_COMPAT_ENABLED;
  process.env.UM_AUTH_TOKEN = token;
  if (compatFlag === undefined) delete process.env.UM_MEM0_COMPAT_ENABLED;
  else process.env.UM_MEM0_COMPAT_ENABLED = compatFlag;
  const srv = createServer(createRequestHandler({ memory }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const close = async () => {
    srv.close();
    await once(srv, 'close');
    if (prevTok === undefined) delete process.env.UM_AUTH_TOKEN;
    else process.env.UM_AUTH_TOKEN = prevTok;
    if (prevFlag === undefined) delete process.env.UM_MEM0_COMPAT_ENABLED;
    else process.env.UM_MEM0_COMPAT_ENABLED = prevFlag;
  };
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  return { port, close, url };
}

test('ORDERING INVARIANT (spec §6): flag OFF + bad token → 404, not 401', async () => {
  // The Step-3a hard short-circuit (endpoint-class row) runs BEFORE the
  // Step-4 auth check — a wrong token must NOT leak a 401 when the compat
  // surface is disabled.
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: undefined, memory: fakeMemory });
  try {
    const r = await fetch(url('/v1/memories/'), {
      method: 'POST',
      headers: {
        'Authorization': 'Token wrong-token',
        'X-Forwarded-For': '1.2.3.4', // force the non-loopback auth path
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(r.status, 404);
  } finally { await close(); }
});

test('flag ON + Token-scheme correct key → past auth, into the handler (R2 400 on empty body)', async () => {
  // An empty JSON body carries no messages[] → the R2 handler answers 400
  // in the mem0 dialect. Reaching a HANDLER response (not 401/404) is the
  // pin: auth ran, passed, and dispatch happened.
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: 'true', memory: fakeMemory });
  try {
    const r = await fetch(url('/v1/memories/'), {
      method: 'POST',
      headers: {
        'Authorization': 'Token secret-token',
        'X-Forwarded-For': '1.2.3.4',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(r.status, 400);
    assert.equal(typeof (await r.json()).detail, 'string');
  } finally { await close(); }
});

test('flag ON + Bearer-scheme correct key → past auth, R1 ping 200', async () => {
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: 'true', memory: fakeMemory });
  try {
    const r = await fetch(url('/v1/ping/'), {
      headers: { 'Authorization': 'Bearer secret-token', 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.name, 'universal-memory');
  } finally { await close(); }
});

test('flag ON + wrong token → 401', async () => {
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: 'true', memory: fakeMemory });
  try {
    const r = await fetch(url('/v1/ping/'), {
      headers: { 'Authorization': 'Token wrong-token', 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('flag ON + absent token → 401', async () => {
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: 'true', memory: fakeMemory });
  try {
    const r = await fetch(url('/v1/ping/'), { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('flag ON + unknown compat path (authed) → 404 {detail: "unknown compat route"}', async () => {
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: 'true', memory: fakeMemory });
  try {
    const r = await fetch(url('/v1/definitely-not-a-route/'), {
      headers: { 'Authorization': 'Token secret-token', 'X-Forwarded-For': '1.2.3.4' },
    });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { detail: 'unknown compat route' });
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// 5. NO loopback auth bypass on compat routes (spec §6)
// ---------------------------------------------------------------------------

test('loopback no-bypass: pure loopback, no token → 401 on compat route (spec §6)', async () => {
  // NO forwarded headers: shouldBypassLoopback(req) would return true —
  // and /api/* below proves it does — but the compat row's compat:true
  // marker denies the bypass at Step-4, so the missing key still 401s.
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: 'true', memory: fakeMemory });
  try {
    const r = await fetch(url('/v1/ping/')); // pure loopback, no auth header
    assert.equal(r.status, 401);
  } finally { await close(); }
});

test('loopback no-bypass: pure loopback WITH Token key → 200 ping (auth ran and passed)', async () => {
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: 'true', memory: fakeMemory });
  try {
    const r = await fetch(url('/v1/ping/'), { headers: { 'Authorization': 'Token secret-token' } });
    assert.equal(r.status, 200);
  } finally { await close(); }
});

test('loopback bypass UNCHANGED for /api/* while the compat flag is on (guard)', async () => {
  // Same server, same loopback peer, no token: /api/list still bypasses
  // auth (UM_ALLOW_LOOPBACK_NOAUTH default) — the compat no-bypass is
  // scoped to compat rows only.
  const { close, url } = await startServer({ token: 'secret-token', compatFlag: 'true', memory: fakeMemory });
  try {
    const r = await fetch(url('/api/list'));
    assert.equal(r.status, 200);
  } finally { await close(); }
});
