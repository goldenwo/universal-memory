// server/test/oauth-endpoints.test.mjs — the OAuth HTTP handlers (authorize GET,
// consent POST, token POST) + the access-token verifier, driven end-to-end over
// a real node:http server on port 0 (handlers read req streams, so real-http is
// closer to production than mock objects). Covers every behaviour bullet of
// Gap-3 OAuth spec section 4.2 / 5 / 6 (PR 2 core flow): client/redirect/PKCE/
// resource validation, the JSON-vs-HTML authorize delivery split (ChatGPT
// 302-gotcha), consent CSRF + Origin enforcement + throttle + operator-token /
// cookie auth, code single-use, refresh rotation + reuse tripwire, and the
// verifier's audience/expiry checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { createStateStore, OAUTH_TTLS, sha256hex } from '../lib/oauth/state-store.mjs';
import { createConsentThrottle } from '../lib/oauth/throttle.mjs';
import { createOAuthVerifier } from '../lib/oauth/verifier.mjs';
import { createOAuthHandlers } from '../lib/oauth/endpoints.mjs';
import { makeOperatorPolicy } from '../lib/oauth/idp/policy.mjs';

const BASE_URL = 'https://um.example.test';
const OPERATOR = 'operator-secret-token';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CLIENT_ID = 'client-abc';

// ---- PKCE pair helper (S256) ----------------------------------------------
function pkcePair() {
  const verifier = randomBytes(32).toString('base64url'); // 43 chars
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

// ---- one disposable store + handlers + server per test --------------------
function makeRig({ now, cimdResolver, operatorPolicy, registry } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-ep-'));
  const clock = now ?? { t: Date.now() };
  const nowFn = () => clock.t;
  const store = createStateStore(dir, { now: nowFn });
  store.putClient({ client_id: CLIENT_ID, redirect_uris: [REDIRECT], client_name: 'Claude' });
  const throttle = createConsentThrottle();
  const handlers = createOAuthHandlers({
    store, baseUrl: BASE_URL, operatorToken: OPERATOR, throttle, now: nowFn, cimdResolver, operatorPolicy, registry,
  });
  const verifier = createOAuthVerifier(store, BASE_URL, { now: nowFn });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE_URL);
    if (url.pathname === '/oauth/authorize' && req.method === 'GET') return handlers.handleAuthorize(req, res);
    if (url.pathname === '/oauth/consent' && req.method === 'POST') return handlers.handleConsent(req, res);
    if (url.pathname === '/oauth/token' && req.method === 'POST') return handlers.handleToken(req, res);
    if (url.pathname === '/oauth/register' && req.method === 'POST') return handlers.handleRegister(req, res);
    if (url.pathname === '/oauth/revoke' && req.method === 'POST') return handlers.handleRevoke(req, res);
    const idpLogin = url.pathname.match(/^\/oauth\/idp\/([^/]+)\/login$/);
    if (idpLogin && req.method === 'POST') return handlers.handleIdpLogin(req, res, idpLogin[1]);
    res.statusCode = 404; res.end();
  });
  return { dir, clock, store, throttle, handlers, verifier, server };
}

// ---- tiny fetch-like client over the test server --------------------------
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

function authorizeQuery(extra = {}) {
  const { challenge } = extra.__pkce ?? {};
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge_method: 'S256',
    ...(challenge ? { code_challenge: challenge } : {}),
  });
  for (const [k, v] of Object.entries(extra)) {
    if (k === '__pkce') continue;
    if (v === undefined) q.delete(k);
    else q.set(k, v);
  }
  return q.toString();
}

// Extract authz_id + csrf hidden fields from a rendered consent HTML page.
function parseConsentForm(html) {
  const authzId = /name="authz_id" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  return { authzId, csrf };
}

// =========================================================================
// handleAuthorize — validation rejections
// =========================================================================

test('authorize: unknown client_id → 400 invalid_client', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, { path: `/oauth/authorize?${authorizeQuery({ client_id: 'nope', code_challenge: challenge })}` });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_client');
  } finally { await close(rig.server); }
});

test('authorize: redirect_uri not matching stored → 400 invalid_request, no 3xx', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, { path: `/oauth/authorize?${authorizeQuery({ redirect_uri: 'https://evil.example/cb', code_challenge: challenge })}` });
    assert.equal(res.status, 400); // NEVER 3xx to an unvalidated redirect_uri
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

test('authorize: missing code_challenge → 400 invalid_request (PKCE hard req)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, { path: `/oauth/authorize?${authorizeQuery({})}` });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

test('authorize: code_challenge_method != S256 → 400 invalid_request', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, { path: `/oauth/authorize?${authorizeQuery({ code_challenge: challenge, code_challenge_method: 'plain' })}` });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

test('authorize: wrong response_type → 400 invalid_request', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, { path: `/oauth/authorize?${authorizeQuery({ code_challenge: challenge, response_type: 'token' })}` });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

test('authorize: resource mismatch → 400 invalid_target', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, { path: `/oauth/authorize?${authorizeQuery({ code_challenge: challenge, resource: 'https://other.test/mcp' })}` });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_target');
  } finally { await close(rig.server); }
});

test('authorize: resource matching baseUrl/mcp accepted (HTML page)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, { path: `/oauth/authorize?${authorizeQuery({ code_challenge: challenge, resource: `${BASE_URL}/mcp` })}` });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
  } finally { await close(rig.server); }
});

// =========================================================================
// handleAuthorize — delivery split (HTML vs JSON) + Cache-Control
// =========================================================================

test('authorize: navigation request → 200 HTML consent page, no-store', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, {
      path: `/oauth/authorize?${authorizeQuery({ code_challenge: challenge })}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const { authzId, csrf } = parseConsentForm(res.body);
    assert.ok(authzId);
    assert.ok(csrf);
  } finally { await close(rig.server); }
});

test('authorize: programmatic fetch (sec-fetch-mode: cors) → 200 JSON consent_url, no 3xx', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, {
      path: `/oauth/authorize?${authorizeQuery({ code_challenge: challenge, state: 'xyz' })}`,
      headers: { 'sec-fetch-mode': 'cors' },
    });
    assert.equal(res.status, 200); // NOT a 302 — the ChatGPT cross-origin-302 gotcha
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const j = JSON.parse(res.body);
    assert.ok(j.consent_url.startsWith(`${BASE_URL}/oauth/authorize?`));
    assert.match(j.consent_url, /state=xyz/);
  } finally { await close(rig.server); }
});

test('authorize: accept application/json (no text/html) → JSON consent_url', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const { challenge } = pkcePair();
    const res = await req(port, {
      path: `/oauth/authorize?${authorizeQuery({ code_challenge: challenge })}`,
      headers: { accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
  } finally { await close(rig.server); }
});

// =========================================================================
// handleConsent — Origin / Sec-Fetch-Site enforcement (spec section 5)
// =========================================================================

async function freshConsentForm(rig, port, pkce, extraQuery = {}) {
  const res = await req(port, {
    path: `/oauth/authorize?${authorizeQuery({ code_challenge: pkce.challenge, ...extraQuery })}`,
    headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
  });
  return { res, ...parseConsentForm(res.body) };
}

test('consent: cross-origin Origin header → 403', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 403);
  } finally { await close(rig.server); }
});

test('consent: sec-fetch-site cross-site → 403', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 403);
  } finally { await close(rig.server); }
});

// =========================================================================
// handleConsent — throttle, CSRF, pending-record, auth
// =========================================================================

test('consent: throttle blocking → 429 + Retry-After', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    rig.throttle.fail(rig.clock.t); // pre-block the global throttle
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers['retry-after']) >= 1);
  } finally { await close(rig.server); }
});

test('consent: unknown/expired pending record → 403', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: 'deadbeef', csrf: 'x', operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 403);
  } finally { await close(rig.server); }
});

test('consent: forged CSRF → 403', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf: 'forged-token', operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 403);
  } finally { await close(rig.server); }
});

test('consent: wrong operator token → throttle.fail + 200 re-render with error, needsToken', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: 'wrong', decision: 'allow' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /class="error"/);
    assert.match(res.body, /name="operator_token"/); // needsToken still true
    // throttle engaged
    assert.equal(rig.throttle.admitted(rig.clock.t), false);
  } finally { await close(rig.server); }
});

test('consent: correct operator token sets a consent cookie (Set-Cookie)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 303);
    const sc = [].concat(res.headers['set-cookie'] ?? []).join(';');
    assert.match(sc, /um_consent=/);
  } finally { await close(rig.server); }
});

test('consent: deny → 303 to redirect_uri with error=access_denied + state', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce, { state: 'st-1' });
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'deny' }),
    });
    assert.equal(res.status, 303);
    const loc = res.headers.location;
    assert.ok(loc.startsWith(REDIRECT));
    assert.match(loc, /error=access_denied/);
    assert.match(loc, /state=st-1/);
  } finally { await close(rig.server); }
});

test('consent: content-type not form-urlencoded → 4xx (form-only)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    assert.ok(res.status >= 400 && res.status < 500);
  } finally { await close(rig.server); }
});

// =========================================================================
// Full happy flow: authorize(HTML) → consent allow → code → token → verifier
// =========================================================================

// Drive the consent allow and return the issued auth code (from Location).
async function consentAllow(rig, port, authzId, csrf, { offlineAccess } = {}) {
  const res = await req(port, {
    method: 'POST', path: '/oauth/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
  });
  assert.equal(res.status, 303, `consent allow expected 303, got ${res.status}: ${res.body}`);
  const loc = new URL(res.headers.location);
  return { code: loc.searchParams.get('code'), state: loc.searchParams.get('state'), setCookie: res.headers['set-cookie'] };
}

async function exchangeCode(port, { code, verifier, redirect_uri = REDIRECT, client_id = CLIENT_ID, resource }) {
  return req(port, {
    method: 'POST', path: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri, client_id, ...(resource ? { resource } : {}),
    }),
  });
}

test('happy flow: authorize→consent→code→token→verifier accepts', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce, { scope: 'vault offline_access' });
    const { code } = await consentAllow(rig, port, authzId, csrf);
    assert.ok(code);

    const tok = await exchangeCode(port, { code, verifier: pkce.verifier });
    assert.equal(tok.status, 200, tok.body);
    assert.equal(tok.headers['cache-control'], 'no-store');
    const body = JSON.parse(tok.body);
    assert.equal(body.token_type, 'Bearer');
    assert.ok(body.access_token.startsWith('umat_'));
    assert.ok(body.refresh_token.startsWith('umrt_')); // offline_access requested
    assert.equal(body.scope, 'vault');
    assert.ok(body.expires_in > 0);

    // verifier (same store) accepts the access token, with branch=oauth
    const claims = rig.verifier(body.access_token);
    assert.equal(claims.branch, 'oauth');
    assert.equal(claims.sub, 'owner');
    assert.deepEqual(claims.scope, ['vault']);
  } finally { await close(rig.server); }
});

test('happy flow: token sub is the canonical operator sub from policy (github:<id>)', async () => {
  const rig = makeRig({ operatorPolicy: makeOperatorPolicy({ UM_OAUTH_OPERATOR_GITHUB: '5550123' }) });
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce, { scope: 'vault' });
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const tok = await exchangeCode(port, { code, verifier: pkce.verifier });
    assert.equal(tok.status, 200, tok.body);
    const claims = rig.verifier(JSON.parse(tok.body).access_token);
    assert.equal(claims.sub, 'github:5550123'); // was hardcoded 'owner'; now threaded from operatorPolicy
  } finally { await close(rig.server); }
});

test('verifier: wrong audience token → null', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const tok = JSON.parse((await exchangeCode(port, { code, verifier: pkce.verifier })).body);
    // verifier built for a DIFFERENT base → audience mismatch → null
    const otherVerifier = createOAuthVerifier(rig.store, 'https://other.test', { now: () => rig.clock.t });
    assert.equal(otherVerifier(tok.access_token), null);
  } finally { await close(rig.server); }
});

test('verifier: expired token → null', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const tok = JSON.parse((await exchangeCode(port, { code, verifier: pkce.verifier })).body);
    assert.ok(rig.verifier(tok.access_token)); // live now
    rig.clock.t += OAUTH_TTLS.accessMs + 1;     // advance past expiry
    assert.equal(rig.verifier(tok.access_token), null);
  } finally { await close(rig.server); }
});

test('verifier: non-umat bearer → null', () => {
  const rig = makeRig();
  assert.equal(rig.verifier('legacy-token'), null);
  assert.equal(rig.verifier(null), null);
});

// =========================================================================
// handleToken — authorization_code rejection paths
// =========================================================================

test('token: code single-use — second exchange → invalid_grant', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const first = await exchangeCode(port, { code, verifier: pkce.verifier });
    assert.equal(first.status, 200);
    const second = await exchangeCode(port, { code, verifier: pkce.verifier });
    assert.equal(second.status, 400);
    assert.equal(JSON.parse(second.body).error, 'invalid_grant');
  } finally { await close(rig.server); }
});

test('token: wrong PKCE verifier → invalid_grant', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const res = await exchangeCode(port, { code, verifier: randomBytes(32).toString('base64url') });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_grant');
  } finally { await close(rig.server); }
});

test('token: redirect_uri mismatch at exchange → invalid_grant', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const res = await exchangeCode(port, { code, verifier: pkce.verifier, redirect_uri: 'http://localhost:9/cb' });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_grant');
  } finally { await close(rig.server); }
});

test('token: client_id mismatch at exchange → invalid_grant', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const res = await exchangeCode(port, { code, verifier: pkce.verifier, client_id: 'someone-else' });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_grant');
  } finally { await close(rig.server); }
});

test('token: resource mismatch at exchange → invalid_target', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    // bind resource into the code (authorize resource defaults to baseUrl/mcp)
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce, { resource: `${BASE_URL}/mcp` });
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const res = await exchangeCode(port, { code, verifier: pkce.verifier, resource: 'https://other.test/mcp' });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_target');
  } finally { await close(rig.server); }
});

test('token: unknown code → invalid_grant', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await exchangeCode(port, { code: 'never-issued', verifier: pkcePair().verifier });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_grant');
  } finally { await close(rig.server); }
});

test('token: JSON content-type → 400 invalid_request', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, {
      method: 'POST', path: '/oauth/token',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

test('token: unsupported grant_type → 400 unsupported_grant_type', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, {
      method: 'POST', path: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'password', username: 'x' }),
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'unsupported_grant_type');
  } finally { await close(rig.server); }
});

test('token: body > 64KB rejected', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, {
      method: 'POST', path: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&blob=' + 'a'.repeat(70 * 1024),
    });
    assert.equal(res.status, 400);
  } finally { await close(rig.server); }
});

// =========================================================================
// handleToken — refresh rotation + reuse tripwire (through HTTP)
// =========================================================================

async function refreshGrant(port, refresh_token, { client_id = CLIENT_ID } = {}) {
  return req(port, {
    method: 'POST', path: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'refresh_token', refresh_token,
      ...(client_id === null ? {} : { client_id }),
    }),
  });
}

test('token: refresh rotation issues new pair; reused refresh → invalid_grant (family revoked)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce, { scope: 'vault offline_access' });
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const first = JSON.parse((await exchangeCode(port, { code, verifier: pkce.verifier })).body);
    assert.ok(first.refresh_token);

    // rotate
    const rotated = await refreshGrant(port, first.refresh_token);
    assert.equal(rotated.status, 200, rotated.body);
    const rb = JSON.parse(rotated.body);
    assert.ok(rb.access_token.startsWith('umat_'));
    assert.ok(rb.refresh_token.startsWith('umrt_'));
    assert.notEqual(rb.refresh_token, first.refresh_token);
    assert.equal(rb.scope, 'vault'); // scope echoed through rotation (no second lookup)

    // reuse the OLD refresh → tripwire → invalid_grant
    const reuse = await refreshGrant(port, first.refresh_token);
    assert.equal(reuse.status, 400);
    assert.equal(JSON.parse(reuse.body).error, 'invalid_grant');

    // the rotated-away access token family is now dead too: new refresh also fails
    const afterRevoke = await refreshGrant(port, rb.refresh_token);
    assert.equal(afterRevoke.status, 400);
  } finally { await close(rig.server); }
});

test('token: unknown refresh_token → invalid_grant', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const res = await refreshGrant(port, 'umrt_nope');
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_grant');
  } finally { await close(rig.server); }
});

test('token: refresh with WRONG client_id → invalid_grant AND the token is NOT burned', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce, { scope: 'vault offline_access' });
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const first = JSON.parse((await exchangeCode(port, { code, verifier: pkce.verifier })).body);
    assert.ok(first.refresh_token);

    // wrong client_id → rejected BEFORE rotation (RFC 6749 §6)
    const wrong = await refreshGrant(port, first.refresh_token, { client_id: 'someone-else' });
    assert.equal(wrong.status, 400);
    assert.equal(JSON.parse(wrong.body).error, 'invalid_grant');

    // the token must NOT have been consumed by the typo: the right client_id works
    const ok = await refreshGrant(port, first.refresh_token, { client_id: CLIENT_ID });
    assert.equal(ok.status, 200, ok.body);
    const ob = JSON.parse(ok.body);
    assert.ok(ob.access_token.startsWith('umat_'));
    assert.ok(ob.refresh_token.startsWith('umrt_'));
  } finally { await close(rig.server); }
});

test('token: refresh with MISSING client_id → invalid_grant', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce, { scope: 'vault offline_access' });
    const { code } = await consentAllow(rig, port, authzId, csrf);
    const first = JSON.parse((await exchangeCode(port, { code, verifier: pkce.verifier })).body);
    assert.ok(first.refresh_token);

    const missing = await refreshGrant(port, first.refresh_token, { client_id: null });
    assert.equal(missing.status, 400);
    assert.equal(JSON.parse(missing.body).error, 'invalid_grant');

    // still not burned: correct client_id still works
    const ok = await refreshGrant(port, first.refresh_token, { client_id: CLIENT_ID });
    assert.equal(ok.status, 200, ok.body);
  } finally { await close(rig.server); }
});

// =========================================================================
// Cookie path: a valid consent cookie skips the operator-token paste
// =========================================================================

test('consent: valid consent cookie authorizes without operator_token', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    // First consent with operator token to obtain the cookie.
    const pkce1 = pkcePair();
    const f1 = await freshConsentForm(rig, port, pkce1);
    const r1 = await consentAllow(rig, port, f1.authzId, f1.csrf);
    const cookie = [].concat(r1.setCookie ?? []).map((c) => c.split(';')[0]).join('; ');
    assert.match(cookie, /um_consent=/);

    // Second authorization: present the cookie, NO operator_token.
    const pkce2 = pkcePair();
    const f2res = await req(port, {
      path: `/oauth/authorize?${authorizeQuery({ code_challenge: pkce2.challenge })}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html', cookie },
    });
    const { authzId, csrf } = parseConsentForm(f2res.body);
    const consentRes = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: form({ authz_id: authzId, csrf, decision: 'allow' }), // no operator_token
    });
    assert.equal(consentRes.status, 303, consentRes.body);
    assert.ok(new URL(consentRes.headers.location).searchParams.get('code'));
  } finally { await close(rig.server); }
});

// =========================================================================
// CIMD authorize path (PR 4) — a URL-shaped client_id is resolved through the
// injected cimdResolver instead of the store. Full authorize→consent→token
// flow with a stub resolver; resolution failure → 400 invalid_client; a URL
// client_id with NO resolver configured → 400 (not a crash).
// =========================================================================

const CIMD_CLIENT = 'https://chatgpt.com/oauth/abc/client.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector/oauth/abc123';

// A stub resolver returning a CIMD client record (the cimd.mjs shape).
function stubCimdResolver(record) {
  return async (clientId) => (clientId === CIMD_CLIENT ? record : null);
}

function cimdAuthorizeQuery(challenge, extra = {}) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: CIMD_CLIENT, redirect_uri: CHATGPT_REDIRECT,
    code_challenge_method: 'S256', code_challenge: challenge, ...extra,
  });
  return q.toString();
}

test('CIMD: full authorize→consent→token flow with a stub resolver', async () => {
  const rig = makeRig({
    cimdResolver: stubCimdResolver({
      client_id: CIMD_CLIENT, client_name: 'ChatGPT',
      redirect_uris: [CHATGPT_REDIRECT], grant_types: ['authorization_code'], source: 'cimd',
    }),
  });
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const authzRes = await req(port, {
      path: `/oauth/authorize?${cimdAuthorizeQuery(pkce.challenge)}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    assert.equal(authzRes.status, 200, authzRes.body);
    assert.match(authzRes.body, /ChatGPT/); // CIMD doc's client_name rendered
    const { authzId, csrf } = parseConsentForm(authzRes.body);

    const consentRes = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(consentRes.status, 303, consentRes.body);
    const loc = new URL(consentRes.headers.location);
    assert.ok(loc.toString().startsWith(CHATGPT_REDIRECT));
    const code = loc.searchParams.get('code');
    assert.ok(code);

    // Token exchange with the SAME URL-shaped client_id string.
    const tok = await exchangeCode(port, {
      code, verifier: pkce.verifier, redirect_uri: CHATGPT_REDIRECT, client_id: CIMD_CLIENT,
    });
    assert.equal(tok.status, 200, tok.body);
    const body = JSON.parse(tok.body);
    assert.ok(body.access_token.startsWith('umat_'));
  } finally { await close(rig.server); }
});

test('CIMD: resolver returns null → 400 invalid_client', async () => {
  const rig = makeRig({ cimdResolver: async () => null });
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const res = await req(port, {
      path: `/oauth/authorize?${cimdAuthorizeQuery(pkce.challenge)}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_client');
  } finally { await close(rig.server); }
});

test('CIMD: URL-shaped client_id with NO resolver configured → 400 invalid_client (no crash)', async () => {
  const rig = makeRig(); // no cimdResolver
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const res = await req(port, {
      path: `/oauth/authorize?${cimdAuthorizeQuery(pkce.challenge)}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_client');
  } finally { await close(rig.server); }
});

// =========================================================================
// PR-5 observability callbacks (spec §6 item 12) — onConsent(outcome) and
// onTokenGrant(grantType, outcome) fire at every terminal path. These are the
// metrics seam: endpoints.mjs stays metrics-free, the dispatcher owns the inc.
// Asserted UNIT-level by injecting spy callbacks (no prom-client dependency).
// =========================================================================

// Build a rig whose handlers capture every onConsent / onTokenGrant call.
function makeSpyRig({ now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-spy-'));
  const clock = now ?? { t: Date.now() };
  const nowFn = () => clock.t;
  const store = createStateStore(dir, { now: nowFn });
  store.putClient({ client_id: CLIENT_ID, redirect_uris: [REDIRECT], client_name: 'Claude' });
  const throttle = createConsentThrottle();
  const consentCalls = [];
  const tokenCalls = [];
  const handlers = createOAuthHandlers({
    store, baseUrl: BASE_URL, operatorToken: OPERATOR, throttle, now: nowFn,
    onConsent: (outcome) => consentCalls.push(outcome),
    onTokenGrant: (grantType, outcome) => tokenCalls.push({ grantType, outcome }),
  });
  const server = http.createServer((rq, rs) => {
    const u = new URL(rq.url, BASE_URL);
    if (u.pathname === '/oauth/authorize' && rq.method === 'GET') return handlers.handleAuthorize(rq, rs);
    if (u.pathname === '/oauth/consent' && rq.method === 'POST') return handlers.handleConsent(rq, rs);
    if (u.pathname === '/oauth/token' && rq.method === 'POST') return handlers.handleToken(rq, rs);
    rs.statusCode = 404; rs.end();
  });
  return { dir, clock, store, throttle, handlers, server, consentCalls, tokenCalls };
}

async function spyFreshConsentForm(port, pkce, extraQuery = {}) {
  const res = await req(port, {
    path: `/oauth/authorize?${authorizeQuery({ code_challenge: pkce.challenge, ...extraQuery })}`,
    headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
  });
  return parseConsentForm(res.body);
}

test('onConsent fires outcome="allow" on a successful consent', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await spyFreshConsentForm(port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 303);
    assert.deepEqual(rig.consentCalls, ['allow']);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

test('onConsent fires outcome="deny" on a denied consent', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await spyFreshConsentForm(port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'deny' }),
    });
    assert.equal(res.status, 303);
    assert.deepEqual(rig.consentCalls, ['deny']);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

test('onConsent fires outcome="bad_token" on a wrong operator token re-render', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await spyFreshConsentForm(port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: 'wrong', decision: 'allow' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(rig.consentCalls, ['bad_token']);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

test('onConsent fires outcome="throttled" when the throttle blocks', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await spyFreshConsentForm(port, pkce);
    rig.throttle.fail(rig.clock.t); // pre-block the throttle
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 429);
    assert.deepEqual(rig.consentCalls, ['throttled']);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

test('onConsent fires outcome="csrf_reject" on a forged CSRF token', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId } = await spyFreshConsentForm(port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf: 'forged', operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(rig.consentCalls, ['csrf_reject']);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

test('onTokenGrant fires (authorization_code, "issued") on a successful exchange', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await spyFreshConsentForm(port, pkce, { scope: 'vault offline_access' });
    const allow = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    const code = new URL(allow.headers.location).searchParams.get('code');
    const tok = await exchangeCode(port, { code, verifier: pkce.verifier });
    assert.equal(tok.status, 200, tok.body);
    assert.deepEqual(rig.tokenCalls, [{ grantType: 'authorization_code', outcome: 'issued' }]);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

test('onTokenGrant fires (authorization_code, "invalid_grant") on an unknown code', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const res = await exchangeCode(port, { code: 'never-issued', verifier: pkcePair().verifier });
    assert.equal(res.status, 400);
    assert.deepEqual(rig.tokenCalls, [{ grantType: 'authorization_code', outcome: 'invalid_grant' }]);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

test('onTokenGrant fires (refresh_token, "issued") then (refresh_token, "reuse_blocked")', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await spyFreshConsentForm(port, pkce, { scope: 'vault offline_access' });
    const allow = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    const code = new URL(allow.headers.location).searchParams.get('code');
    const first = JSON.parse((await exchangeCode(port, { code, verifier: pkce.verifier })).body);
    rig.tokenCalls.length = 0; // drop the authorization_code issuance

    // rotate (refresh issued), then reuse the OLD token (reuse_blocked)
    const rotated = await refreshGrant(port, first.refresh_token);
    assert.equal(rotated.status, 200, rotated.body);
    const reuse = await refreshGrant(port, first.refresh_token);
    assert.equal(reuse.status, 400);
    assert.deepEqual(rig.tokenCalls, [
      { grantType: 'refresh_token', outcome: 'issued' },
      { grantType: 'refresh_token', outcome: 'reuse_blocked' },
    ]);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

test('onTokenGrant fires (unknown, "unsupported") on an unsupported grant_type', async () => {
  const rig = makeSpyRig();
  const port = await listen(rig.server);
  try {
    const res = await req(port, {
      method: 'POST', path: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'password', username: 'x' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(rig.tokenCalls, [{ grantType: 'unknown', outcome: 'unsupported' }]);
  } finally { await close(rig.server); fs.rmSync(rig.dir, { recursive: true, force: true }); }
});

// =========================================================================
// Stubs (PR 3 / PR 5)
// =========================================================================

// revoke is implemented (PR 5) — full behaviour (counts, client/all selectors,
// 404/400 paths, live-store mutation) is covered in oauth-revoke.test.mjs. This
// smoke check only asserts the route is wired and no longer the 501 stub.
test('revoke: route is implemented (empty body → 400, not the old 501 stub)', async () => {
  const rig = makeRig();
  const port = await listen(rig.server);
  try {
    const rev = await req(port, { method: 'POST', path: '/oauth/revoke', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(rev.status, 400);
    assert.equal(JSON.parse(rev.body).error, 'invalid_request');
  } finally { await close(rig.server); }
});

// =========================================================================
// Pending-authz map cap (carry-over Nit from 2.6 review) — the map never grows
// past pendingCap. Build a dedicated handlers instance with a small cap and
// drive cap+1 authorize requests; the oldest pending entry must be evicted, so
// a consent referencing the FIRST authz_id now 403s ("no pending"), while a
// fresh authz still works.
// =========================================================================

test('pending-cap: oldest pending authz is evicted past the cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-cap-'));
  const store = createStateStore(dir);
  store.putClient({ client_id: CLIENT_ID, redirect_uris: [REDIRECT], client_name: 'Claude' });
  const handlers = createOAuthHandlers({
    store, baseUrl: BASE_URL, operatorToken: OPERATOR, throttle: createConsentThrottle(), pendingCap: 3,
  });
  const server = http.createServer((rq, rs) => {
    const u = new URL(rq.url, BASE_URL);
    if (u.pathname === '/oauth/authorize') return handlers.handleAuthorize(rq, rs);
    if (u.pathname === '/oauth/consent') return handlers.handleConsent(rq, rs);
    rs.statusCode = 404; rs.end();
  });
  const port = await listen(server);
  try {
    // First authorize — capture its authz_id + csrf (the eviction target).
    const first = await req(port, {
      path: `/oauth/authorize?${authorizeQuery({ code_challenge: pkcePair().challenge })}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    const firstForm = parseConsentForm(first.body);
    assert.ok(firstForm.authzId);

    // Fill + overflow the cap (cap=3): 3 more authorize calls → size hits 4 →
    // overflow evicts the oldest (the first).
    for (let i = 0; i < 3; i++) {
      await req(port, {
        path: `/oauth/authorize?${authorizeQuery({ code_challenge: pkcePair().challenge })}`,
        headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
      });
    }

    // Consent on the (now-evicted) first authz → 403 no-pending.
    const evicted = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: firstForm.authzId, csrf: firstForm.csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(evicted.status, 403, 'oldest pending authz must be evicted past the cap');

    // A freshly-issued authz still consents fine (cap evicts oldest, not newest).
    const fresh = await req(port, {
      path: `/oauth/authorize?${authorizeQuery({ code_challenge: pkcePair().challenge })}`,
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    const freshForm = parseConsentForm(fresh.body);
    const ok = await req(port, {
      method: 'POST', path: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: freshForm.authzId, csrf: freshForm.csrf, operator_token: OPERATOR, decision: 'allow' }),
    });
    assert.equal(ok.status, 303, 'a fresh pending authz must still consent');
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// IdP login flow (fake adapter injected via the registry; no network)
// =========================================================================

const fakeAdapter = {
  id: 'github',
  buildAuthorizeUrl: ({ state, redirectUri }) =>
    `https://github.com/login/oauth/authorize?client_id=cid&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode: async () => ({ credentials: { accessToken: 'gho_x' } }),
  fetchIdentity: async () => ({ subject: '5550123', displayName: 'goldenwo' }),
};
const fakeRegistry = { get: (id) => (id === 'github' ? fakeAdapter : undefined), list: () => [fakeAdapter] };

test('idp login: valid CSRF + same-origin → 303 to provider authorize URL with a minted state', async () => {
  const rig = makeRig({ registry: fakeRegistry });
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/idp/github/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf }),
    });
    assert.equal(res.status, 303, res.body);
    const loc = new URL(res.headers.location);
    assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
    assert.ok(loc.searchParams.get('state'), 'a minted idp-state must be present');
    assert.match(loc.searchParams.get('redirect_uri'), /\/oauth\/idp\/github\/callback$/);
  } finally { await close(rig.server); }
});

test('idp login: cross-origin Origin header → 403 (no redirect)', async () => {
  const rig = makeRig({ registry: fakeRegistry });
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/idp/github/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: form({ authz_id: authzId, csrf }),
    });
    assert.equal(res.status, 403);
  } finally { await close(rig.server); }
});

test('idp login: Sec-Fetch-Site cross-site → 403', async () => {
  const rig = makeRig({ registry: fakeRegistry });
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId, csrf } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/idp/github/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
      body: form({ authz_id: authzId, csrf }),
    });
    assert.equal(res.status, 403);
  } finally { await close(rig.server); }
});

test('idp login: forged CSRF → 403', async () => {
  const rig = makeRig({ registry: fakeRegistry });
  const port = await listen(rig.server);
  try {
    const pkce = pkcePair();
    const { authzId } = await freshConsentForm(rig, port, pkce);
    const res = await req(port, {
      method: 'POST', path: '/oauth/idp/github/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ authz_id: authzId, csrf: 'forged-token' }),
    });
    assert.equal(res.status, 403);
  } finally { await close(rig.server); }
});
