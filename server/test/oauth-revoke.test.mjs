// server/test/oauth-revoke.test.mjs — Gap-3 OAuth PR-5 Task 5.1 operator
// revocation. Two layers, one file:
//
//   1. store.revokeAll / store.revokeClient COUNT semantics (the additive
//      return-value extension the endpoint relies on for its JSON body).
//   2. handleRevoke over a real node:http server: {all:true} zeroes the live
//      token graph (verifier rejects after), {client_id} drops one client's
//      registration + tokens while other clients survive, unknown client → 404,
//      bad/ambiguous body → 400, counts accurate.
//
// The endpoint mutates the SAME live store instance the verifier reads (spec
// §4.3: revocation is an endpoint, not a file-editing CLI, because the running
// process owns the in-process cache). The loopback-only POSTURE is enforced by
// the endpoint-class row (oauthRevokePolicy), exercised in oauth-integration +
// endpoint-class unit tests, NOT here — handleRevoke trusts its routing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { createStateStore, sha256hex } from '../lib/oauth/state-store.mjs';
import { createConsentThrottle } from '../lib/oauth/throttle.mjs';
import { createOAuthVerifier } from '../lib/oauth/verifier.mjs';
import { createOAuthHandlers } from '../lib/oauth/endpoints.mjs';

const BASE_URL = 'https://um.example.test';
const OPERATOR = 'operator-secret-token';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-revoke-'));
  return createStateStore(dir);
}

// Seed one client + a code + an issued access/refresh pair for it, returning the
// plaintext access token so a verifier can assert liveness.
function seedClient(store, clientId, redirect = 'https://claude.ai/cb') {
  const t = Date.now();
  store.putClient({ client_id: clientId, client_name: clientId, redirect_uris: [redirect], created: t, lastUsed: t, source: 'manual' });
  store.putCode(sha256hex(`code-${clientId}`), {
    clientId, redirectUri: redirect, codeChallenge: 'x', resource: `${BASE_URL}/mcp`,
    scope: ['vault'], offlineAccess: true, sub: 'owner', exp: t + 60_000,
  });
  const issued = store.issueTokens({
    sub: 'owner', aud: `${BASE_URL}/mcp`, scope: ['vault'], offlineAccess: true, clientId,
  });
  return issued.accessToken;
}

// =========================================================================
// store layer — count semantics (additive return value, spec §4.3)
// =========================================================================

test('store.revokeAll: returns counts captured BEFORE clearing and empties the graph', () => {
  const store = makeStore();
  seedClient(store, 'client-a');
  seedClient(store, 'client-b');
  const counts = store.revokeAll();
  assert.deepEqual(counts, { accessTokens: 2, refreshTokens: 2, codes: 2 });
  // graph is empty: re-running yields zeroes.
  assert.deepEqual(store.revokeAll(), { accessTokens: 0, refreshTokens: 0, codes: 0 });
  // clients survive a revokeAll (tokens/codes only — clients are dropped only by revokeClient).
  assert.ok(store.getClient('client-a'));
});

test('store.revokeClient: drops only that client and returns its counts', () => {
  const store = makeStore();
  seedClient(store, 'client-a');
  seedClient(store, 'client-b');
  const counts = store.revokeClient('client-a');
  assert.deepEqual(counts, { accessTokens: 1, refreshTokens: 1, codes: 1 });
  assert.equal(store.getClient('client-a'), undefined);
  assert.ok(store.getClient('client-b'), 'other client survives');
});

test('store.revokeClient: unknown client → all-zero counts (no throw)', () => {
  const store = makeStore();
  seedClient(store, 'client-a');
  const counts = store.revokeClient('client-nope');
  assert.deepEqual(counts, { accessTokens: 0, refreshTokens: 0, codes: 0 });
  assert.ok(store.getClient('client-a'), 'untouched');
});

// =========================================================================
// endpoint layer — handleRevoke over a real node:http server
// =========================================================================

function makeRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-revoke-ep-'));
  const store = createStateStore(dir);
  const throttle = createConsentThrottle();
  const handlers = createOAuthHandlers({ store, baseUrl: BASE_URL, operatorToken: OPERATOR, throttle });
  const verifier = createOAuthVerifier(store, BASE_URL);
  const server = http.createServer((req, res) => {
    if (req.url === '/oauth/revoke' && req.method === 'POST') return handlers.handleRevoke(req, res);
    res.statusCode = 404; res.end();
  });
  return { store, verifier, server };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((r) => server.close(r)); }

function postJson(port, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/oauth/revoke', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('revoke {all:true}: 200, zeroes live tokens, verifier rejects after', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const tokA = seedClient(rig.store, 'client-a');
    const tokB = seedClient(rig.store, 'client-b');
    assert.ok(rig.verifier(tokA), 'live before');
    assert.ok(rig.verifier(tokB), 'live before');

    const res = await postJson(port, { all: true });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.revoked, 'all');
    assert.deepEqual(body.counts, { accessTokens: 2, refreshTokens: 2, codes: 2 });

    // LIVE store mutated: both tokens now rejected by the verifier.
    assert.equal(rig.verifier(tokA), null, 'revoked');
    assert.equal(rig.verifier(tokB), null, 'revoked');
  } finally { await close(rig.server); }
});

test('revoke {client_id}: 200, drops that client + tokens, OTHER client survives', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const tokA = seedClient(rig.store, 'client-a');
    const tokB = seedClient(rig.store, 'client-b');

    const res = await postJson(port, { client_id: 'client-a' });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.revoked, 'client');
    assert.equal(body.client_id, 'client-a');
    assert.deepEqual(body.counts, { accessTokens: 1, refreshTokens: 1, codes: 1 });

    assert.equal(rig.store.getClient('client-a'), undefined, 'registration dropped');
    assert.equal(rig.verifier(tokA), null, 'its token revoked');
    assert.ok(rig.store.getClient('client-b'), 'other registration survives');
    assert.ok(rig.verifier(tokB), 'other token survives');
  } finally { await close(rig.server); }
});

test('revoke {client_id} unknown → 404 not_found', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    seedClient(rig.store, 'client-a');
    const res = await postJson(port, { client_id: 'umcl_nope' });
    assert.equal(res.status, 404, res.body);
    assert.equal(JSON.parse(res.body).error, 'not_found');
    assert.ok(rig.store.getClient('client-a'), 'untouched');
  } finally { await close(rig.server); }
});

test('revoke: invalid JSON body → 400 invalid_request', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await postJson(port, '{not json');
    assert.equal(res.status, 400, res.body);
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

test('revoke: empty body (neither all nor client_id) → 400 invalid_request', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await postJson(port, {});
    assert.equal(res.status, 400, res.body);
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

test('revoke: BOTH all and client_id → 400 invalid_request (ambiguous)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await postJson(port, { all: true, client_id: 'client-a' });
    assert.equal(res.status, 400, res.body);
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

test('revoke {all:false} → 400 (all must be literal true)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await postJson(port, { all: false });
    assert.equal(res.status, 400, res.body);
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});
