// server/test/oauth-iss-application-type.test.mjs — #172: 2026-07-28 MCP auth
// spec revision compliance. Two additive behaviors, driven end-to-end over a
// real node:http server (same rationale as oauth-dcr.test.mjs):
//
//   1. RFC 9207 — every authorization response redirected back to the
//      connector carries `iss=<issuer>`, on BOTH the success (code) and the
//      deny (error=access_denied) redirects (RFC 9207 §2 covers error
//      responses too). The iss value must equal the RFC 8414 metadata
//      `issuer` byte-for-byte.
//   2. RFC 7591 `application_type` — DCR accepts the optional field,
//      validates it against {web, native}, persists it, and echoes it in the
//      201 response. Absent stays absent (no defaulting); invalid rejects
//      with invalid_client_metadata and stores nothing.
//
// Plus one deliberate-omission lock: the RFC 8414 advertisement
// `authorization_response_iss_parameter_supported` is WITHHELD on purpose —
// claude.ai's connector validator (2026-07-17, ua python-httpx) aborts
// discovery when it sees the field (observed live in the boostcamp-mcp
// vendored deployment, which differed from a working config by only that
// line). The iss parameter itself is emitted unconditionally; only the
// advertisement is deferred until their parser tolerates it. The test locks
// the omission so it cannot drift in accidentally and break live discovery.
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
import { authorizationServerMetadata } from '../lib/oauth/metadata.mjs';

const BASE_URL = 'https://um.example.test';
const OPERATOR = 'operator-secret-token';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function makeRig({ now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-iss-'));
  const clock = now ?? { t: Date.now() };
  const nowFn = () => clock.t;
  const store = createStateStore(dir, { now: nowFn });
  const throttle = createConsentThrottle();
  const handlers = createOAuthHandlers({
    store, baseUrl: BASE_URL, operatorToken: OPERATOR, throttle, now: nowFn,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE_URL);
    if (url.pathname === '/oauth/authorize' && req.method === 'GET') return handlers.handleAuthorize(req, res);
    if (url.pathname === '/oauth/consent' && req.method === 'POST') return handlers.handleConsent(req, res);
    if (url.pathname === '/oauth/register' && req.method === 'POST') return handlers.handleRegister(req, res);
    res.statusCode = 404; res.end();
  });
  return { dir, server };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));

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

function parseConsentForm(html) {
  const authzId = /name="authz_id" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  return { authzId, csrf };
}

function countClients(dir) {
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'oauth-state.json'), 'utf8'));
  return Object.keys(state.clients ?? {}).length;
}

// Register a client and drive authorize → consent form, returning the pieces a
// consent POST needs. Shared by both redirect tests.
async function driveToConsent(port, { state } = {}) {
  const regRes = await req(port, {
    method: 'POST', path: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], client_name: 'Claude' }),
  });
  assert.equal(regRes.status, 201, regRes.body);
  const clientId = JSON.parse(regRes.body).client_id;

  const pkce = pkcePair();
  const authzQuery = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_REDIRECT,
    code_challenge: pkce.challenge, code_challenge_method: 'S256', scope: 'vault',
    ...(state !== undefined ? { state } : {}),
  }).toString();
  const authzRes = await req(port, {
    path: `/oauth/authorize?${authzQuery}`,
    headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
  });
  assert.equal(authzRes.status, 200, authzRes.body);
  const { authzId, csrf } = parseConsentForm(authzRes.body);
  assert.ok(authzId && csrf, 'consent form must expose authz_id + csrf');
  return { authzId, csrf };
}

test('RFC 9207: allow redirect carries iss equal to the metadata issuer, beside code + state', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { authzId, csrf } = await driveToConsent(port, { state: 'conn-state-1' });
    const consentRes = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(consentRes.status, 303, consentRes.body);
    const loc = new URL(consentRes.headers.location);
    assert.ok(loc.searchParams.get('code'), 'code still present');
    assert.equal(loc.searchParams.get('state'), 'conn-state-1', 'state still echoed');
    assert.equal(
      loc.searchParams.get('iss'), authorizationServerMetadata(BASE_URL).issuer,
      'iss must equal the RFC 8414 issuer byte-for-byte',
    );
  } finally { await close(rig.server); }
});

test('RFC 9207: deny redirect carries iss too (§2 covers error responses)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { authzId, csrf } = await driveToConsent(port, { state: 'conn-state-2' });
    const consentRes = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'deny' }),
    });
    assert.equal(consentRes.status, 303, consentRes.body);
    const loc = new URL(consentRes.headers.location);
    assert.equal(loc.searchParams.get('error'), 'access_denied');
    assert.equal(loc.searchParams.get('state'), 'conn-state-2');
    assert.equal(loc.searchParams.get('iss'), authorizationServerMetadata(BASE_URL).issuer);
  } finally { await close(rig.server); }
});

test('DCR application_type: web and native accepted, persisted, and echoed', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    for (const applicationType of ['web', 'native']) {
      const res = await req(port, {
        method: 'POST', path: '/oauth/register',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], application_type: applicationType }),
      });
      assert.equal(res.status, 201, res.body);
      assert.equal(JSON.parse(res.body).application_type, applicationType, 'echoed in the 201');
    }
    // Persisted, not just echoed: both stored client records carry the field.
    const state = JSON.parse(fs.readFileSync(path.join(rig.dir, 'oauth-state.json'), 'utf8'));
    const stored = Object.values(state.clients ?? {}).map((c) => c.application_type).sort();
    assert.deepEqual(stored, ['native', 'web']);
  } finally { await close(rig.server); }
});

test('DCR application_type: absent stays absent — no defaulting on echo or storage', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, {
      method: 'POST', path: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT] }),
    });
    assert.equal(res.status, 201, res.body);
    assert.ok(!('application_type' in JSON.parse(res.body)), 'no application_type key in the 201');
    const state = JSON.parse(fs.readFileSync(path.join(rig.dir, 'oauth-state.json'), 'utf8'));
    const [client] = Object.values(state.clients ?? {});
    assert.ok(client && !('application_type' in client), 'no application_type key persisted');
  } finally { await close(rig.server); }
});

test('DCR application_type: invalid value rejects with invalid_client_metadata, nothing stored', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, {
      method: 'POST', path: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT], application_type: 'browser' }),
    });
    assert.equal(res.status, 400, res.body);
    assert.equal(JSON.parse(res.body).error, 'invalid_client_metadata');
    assert.equal(countClients(rig.dir), 0, 'rejection must store nothing');
  } finally { await close(rig.server); }
});

test('RFC 8414 advert authorization_response_iss_parameter_supported is DELIBERATELY withheld (claude.ai validator abort, 2026-07-17)', () => {
  const md = authorizationServerMetadata(BASE_URL);
  assert.ok(
    !('authorization_response_iss_parameter_supported' in md),
    'the advert is deferred until claude.ai discovery tolerates it — emitting iss without the advert is RFC 9207-conformant (the advert is a SHOULD); adding the advert broke live connector discovery. If you are here to add it, verify against a live claude.ai connector first, then update this test WITH that evidence.',
  );
});
