// server/test/oauth-dcr.test.mjs — RFC 7591 Dynamic Client Registration
// (POST /oauth/register), Gap-3 OAuth PR-3, driven end-to-end over a real
// node:http server (the handler reads a JSON request stream, so real-http is
// closer to production than mock objects). Covers spec §4.1 (register row) +
// §6 item 1: JSON-body metadata validation, redirect-URI allowlist enforcement
// (nothing stored on any rejection), client_name truncation, auth-method +
// grant-type subset checks, the 100-client registration cap with prune
// interaction, the onRegistration metric callback outcomes, and the full
// DCR→authorize→consent→token flow (pinning carry-over 1: refresh issuance via
// the registered refresh_token grant WITHOUT the offline_access scope).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { createStateStore } from '../lib/oauth/state-store.mjs';
import { createConsentThrottle } from '../lib/oauth/throttle.mjs';
import { createOAuthHandlers } from '../lib/oauth/endpoints.mjs';

const BASE_URL = 'https://um.example.test';
const OPERATOR = 'operator-secret-token';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

// One disposable store + handlers + server per test. `onRegistration` capture
// lets each test assert the metric callback fired with the right outcome.
function makeRig({ now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-dcr-'));
  const clock = now ?? { t: Date.now() };
  const nowFn = () => clock.t;
  const store = createStateStore(dir, { now: nowFn });
  const throttle = createConsentThrottle();
  const outcomes = [];
  const handlers = createOAuthHandlers({
    store, baseUrl: BASE_URL, operatorToken: OPERATOR, throttle, now: nowFn,
    onRegistration: (outcome) => outcomes.push(outcome),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE_URL);
    if (url.pathname === '/oauth/authorize' && req.method === 'GET') return handlers.handleAuthorize(req, res);
    if (url.pathname === '/oauth/consent' && req.method === 'POST') return handlers.handleConsent(req, res);
    if (url.pathname === '/oauth/token' && req.method === 'POST') return handlers.handleToken(req, res);
    if (url.pathname === '/oauth/register' && req.method === 'POST') return handlers.handleRegister(req, res);
    res.statusCode = 404; res.end();
  });
  return { dir, clock, store, throttle, handlers, server, outcomes, nowFn };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((r) => server.close(r)); }

function req(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const form = (obj) => new URLSearchParams(obj).toString();

// Count persisted clients by reading the on-disk state file (the store exposes
// no list method; this proves "nothing stored" on a rejection path).
function countClients(dir) {
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'oauth-state.json'), 'utf8'));
  return Object.keys(state.clients ?? {}).length;
}

// POST /oauth/register with a JSON metadata body.
function register(port, metadata, { contentType = 'application/json', raw } = {}) {
  const body = raw !== undefined ? raw : JSON.stringify(metadata);
  return req(port, {
    method: 'POST', path: '/oauth/register',
    headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) },
    body,
  });
}

// =========================================================================
// Happy path
// =========================================================================

test('register: valid Claude-shaped metadata → 201 with umcl_ id + stored client', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, {
      redirect_uris: [CLAUDE_REDIRECT],
      client_name: 'Claude',
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(res.status, 201, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = JSON.parse(res.body);
    assert.ok(body.client_id.startsWith('umcl_'), `client_id should be umcl_*, got ${body.client_id}`);
    assert.equal(body.client_name, 'Claude');
    assert.deepEqual(body.redirect_uris, [CLAUDE_REDIRECT]);
    assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
    assert.equal(body.token_endpoint_auth_method, 'none');

    // Persisted + retrievable with the dcr source + timestamps.
    const stored = rig.store.getClient(body.client_id);
    assert.ok(stored, 'registered client must be retrievable from the store');
    assert.equal(stored.source, 'dcr');
    assert.deepEqual(stored.redirect_uris, [CLAUDE_REDIRECT]);
    assert.deepEqual(stored.grant_types, ['authorization_code', 'refresh_token']);
    assert.equal(typeof stored.created, 'number');
    assert.equal(typeof stored.lastUsed, 'number');

    assert.deepEqual(rig.outcomes, ['accepted']);
  } finally { await close(rig.server); }
});

test('register: missing client_name → defaults to (unnamed client)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, { redirect_uris: [CLAUDE_REDIRECT] });
    assert.equal(res.status, 201, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.client_name, '(unnamed client)');
    // grant_types defaults to authorization_code.
    assert.deepEqual(body.grant_types, ['authorization_code']);
  } finally { await close(rig.server); }
});

test('register: client_name > 120 chars is truncated to 120 (still 201)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const longName = 'x'.repeat(200);
    const res = await register(port, { redirect_uris: [CLAUDE_REDIRECT], client_name: longName });
    assert.equal(res.status, 201, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.client_name.length, 120);
    assert.equal(rig.store.getClient(body.client_id).client_name.length, 120);
  } finally { await close(rig.server); }
});

// =========================================================================
// Redirect-URI validation — nothing stored on rejection
// =========================================================================

test('register: off-allowlist redirect_uri → 400 invalid_redirect_uri, NOT stored', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, { redirect_uris: ['https://evil.example/callback'] });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_redirect_uri');
    // Nothing persisted — the on-disk clients map stays empty.
    assert.equal(countClients(rig.dir), 0, 'no client stored on rejection');
    assert.deepEqual(rig.outcomes, ['rejected_redirect']);
  } finally { await close(rig.server); }
});

test('register: one bad of two redirect_uris → 400 invalid_redirect_uri, NOT stored', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, { redirect_uris: [CLAUDE_REDIRECT, 'https://evil.example/cb'] });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_redirect_uri');
    assert.equal(countClients(rig.dir), 0, 'no client stored when any redirect is off-allowlist');
    assert.deepEqual(rig.outcomes, ['rejected_redirect']);
  } finally { await close(rig.server); }
});

test('register: empty redirect_uris array → 400', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, { redirect_uris: [] });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_redirect_uri');
  } finally { await close(rig.server); }
});

test('register: redirect_uris over the length cap → 400, NOT stored (PR-5 hardening)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    // 11 individually-valid (loopback) callbacks — all allowlisted, but the
    // array exceeds MAX_REDIRECT_URIS (10), so the array-length bound rejects.
    const tooMany = Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${3000 + i}/cb`);
    const res = await register(port, { redirect_uris: tooMany });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_redirect_uri');
    assert.equal(countClients(rig.dir), 0, 'over-cap registration is not stored');
    assert.deepEqual(rig.outcomes, ['rejected_redirect']);
  } finally { await close(rig.server); }
});

test('register: missing redirect_uris → 400', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, { client_name: 'No URIs' });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_redirect_uri');
  } finally { await close(rig.server); }
});

// =========================================================================
// Metadata-shape validation
// =========================================================================

test('register: token_endpoint_auth_method client_secret_basic → 400 invalid_client_metadata', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, {
      redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: 'client_secret_basic',
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_client_metadata');
    assert.deepEqual(rig.outcomes, ['rejected_metadata']);
  } finally { await close(rig.server); }
});

test('register: token_endpoint_auth_method none explicitly → accepted', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, {
      redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: 'none',
    });
    assert.equal(res.status, 201, res.body);
  } finally { await close(rig.server); }
});

test('register: grant_types with client_credentials → 400 invalid_client_metadata', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, {
      redirect_uris: [CLAUDE_REDIRECT], grant_types: ['authorization_code', 'client_credentials'],
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_client_metadata');
    assert.deepEqual(rig.outcomes, ['rejected_metadata']);
  } finally { await close(rig.server); }
});

test('register: non-JSON body → 400 invalid_client_metadata', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, null, { raw: 'not json at all', contentType: 'application/json' });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_client_metadata');
    assert.deepEqual(rig.outcomes, ['rejected_metadata']);
  } finally { await close(rig.server); }
});

test('register: JSON array body (not an object) → 400 invalid_client_metadata', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await register(port, null, { raw: JSON.stringify(['x']) });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_client_metadata');
  } finally { await close(rig.server); }
});

// =========================================================================
// Registration cap + prune interaction
// =========================================================================

// Fill the store directly (fast) with N dcr clients at a given timestamp.
function fillClients(store, n, { created, source = 'dcr' } = {}) {
  for (let i = 0; i < n; i++) {
    const id = `umcl_fill_${i}`;
    store.putClient({
      client_id: id, client_name: `fill ${i}`, redirect_uris: [CLAUDE_REDIRECT],
      grant_types: ['authorization_code'], created, lastUsed: created, source,
    });
  }
}

test('register: 101st client when at cap of 100 → 400 with registration limit', async () => {
  const clock = { t: Date.now() };
  const rig = makeRig({ now: clock });
  const port = await listen(rig.server);
  try {
    // 100 ACTIVE clients (lastUsed != created so prune cannot drop them).
    for (let i = 0; i < 100; i++) {
      rig.store.putClient({
        client_id: `umcl_active_${i}`, client_name: `a ${i}`, redirect_uris: [CLAUDE_REDIRECT],
        grant_types: ['authorization_code'], created: clock.t, lastUsed: clock.t + 1, source: 'dcr',
      });
    }
    const res = await register(port, { redirect_uris: [CLAUDE_REDIRECT], client_name: '101st' });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'invalid_client_metadata');
    assert.match(body.error_description, /registration limit/i);
    assert.deepEqual(rig.outcomes, ['rejected_limit']);
  } finally { await close(rig.server); }
});

test('register: at cap of 100 stale dcr clients → prune frees room → 201', async () => {
  const clock = { t: 1_000_000_000_000 };
  const rig = makeRig({ now: clock });
  const port = await listen(rig.server);
  try {
    // 100 stale dcr clients created long ago, never used (created === lastUsed),
    // older than the 30-day DCR_CLIENT_MAX_AGE_MS — prune() will drop all of them.
    fillClients(rig.store, 100, { created: clock.t });
    // Advance the clock past 30 days so the fillers are prune-eligible.
    clock.t += 31 * 24 * 3600 * 1000;

    const res = await register(port, { redirect_uris: [CLAUDE_REDIRECT], client_name: 'after-prune' });
    assert.equal(res.status, 201, res.body);
    assert.deepEqual(rig.outcomes, ['accepted']);
  } finally { await close(rig.server); }
});

// =========================================================================
// Full DCR → authorize → consent → token (pins carry-over 1)
// =========================================================================

function parseConsentForm(html) {
  const authzId = /name="authz_id" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  return { authzId, csrf };
}

test('register → authorize → consent → token: refresh issued via grant_types WITHOUT offline_access scope', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    // (a) Register a client that declares the refresh_token grant.
    const regRes = await register(port, {
      redirect_uris: [CLAUDE_REDIRECT], client_name: 'Claude',
      grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
    });
    assert.equal(regRes.status, 201, regRes.body);
    const clientId = JSON.parse(regRes.body).client_id;

    // (b) Authorize — note: scope is ONLY 'vault' (NO offline_access). The refresh
    // token must still be issued because the client registered refresh_token.
    const pkce = pkcePair();
    const authzQuery = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_REDIRECT,
      code_challenge: pkce.challenge, code_challenge_method: 'S256', scope: 'vault',
    }).toString();
    const authzRes = await req(port, {
      path: `/oauth/authorize?${authzQuery}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    assert.equal(authzRes.status, 200, authzRes.body);
    const { authzId, csrf } = parseConsentForm(authzRes.body);
    assert.ok(authzId && csrf);

    // (c) Consent allow → 303 with ?code=.
    const consentRes = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(consentRes.status, 303, consentRes.body);
    const code = new URL(consentRes.headers.location).searchParams.get('code');
    assert.ok(code);

    // (d) Token exchange → access + REFRESH token (the carry-over-1 assertion).
    const tokRes = await req(port, {
      method: 'POST', path: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code', code, code_verifier: pkce.verifier,
        redirect_uri: CLAUDE_REDIRECT, client_id: clientId,
      }),
    });
    assert.equal(tokRes.status, 200, tokRes.body);
    const tok = JSON.parse(tokRes.body);
    assert.ok(tok.access_token.startsWith('umat_'));
    assert.ok(
      tok.refresh_token?.startsWith('umrt_'),
      'refresh token must be issued via the registered refresh_token grant even without offline_access scope',
    );
  } finally { await close(rig.server); }
});

test('register → authorize → token: NO refresh when neither offline_access nor refresh_token grant', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    // Register WITHOUT refresh_token grant (defaults to authorization_code only).
    const regRes = await register(port, { redirect_uris: [CLAUDE_REDIRECT], client_name: 'NoRefresh' });
    assert.equal(regRes.status, 201, regRes.body);
    const clientId = JSON.parse(regRes.body).client_id;

    const pkce = pkcePair();
    const authzQuery = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_REDIRECT,
      code_challenge: pkce.challenge, code_challenge_method: 'S256', scope: 'vault',
    }).toString();
    const authzRes = await req(port, {
      path: `/oauth/authorize?${authzQuery}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    const { authzId, csrf } = parseConsentForm(authzRes.body);
    const consentRes = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    const code = new URL(consentRes.headers.location).searchParams.get('code');
    const tokRes = await req(port, {
      method: 'POST', path: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code', code, code_verifier: pkce.verifier,
        redirect_uri: CLAUDE_REDIRECT, client_id: clientId,
      }),
    });
    assert.equal(tokRes.status, 200, tokRes.body);
    const tok = JSON.parse(tokRes.body);
    assert.equal(tok.refresh_token, undefined, 'no refresh without offline_access scope or refresh_token grant');
  } finally { await close(rig.server); }
});
