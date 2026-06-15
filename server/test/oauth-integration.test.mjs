/**
 * OAuth PR-2 integration tests (Gap-3 Task 2.7) — the OAuth modules wired into
 * the LIVE server via createRequestHandler. A real node:http server is started
 * on an ephemeral port; the OAuth state store is a tmpdir-rooted store injected
 * through `ctx.oauth` (mirroring how middleware-chain.test.mjs injects
 * `ctx.memory`), so the suite never touches a real vault.
 *
 * Every auth-exercising request sends `X-Forwarded-For: 1.2.3.4` — a bare
 * loopback request hits shouldBypassLoopback() and SKIPS the auth block
 * entirely, which would make these tests meaningless.
 *
 * Coverage:
 *   1. FULL happy path: seeded manual client → authorize → consent → code →
 *      token → Bearer umat_ on /mcp tools/list → 200 real MCP result.
 *   2. Legacy bearer still works on /mcp (regression).
 *   3. OAuth token is scoped to /mcp — accepted on /mcp, 401 on /api/* (least-privilege).
 *   4. Flag-off gating: a valid umat_ token, server built with the flag off
 *      (ctx.oauth absent) → 401.
 *   5. Expired/invalid token on /mcp with flag on → 401 with BOTH the
 *      WWW-Authenticate header AND the JSON-RPC body's _meta re-auth trigger.
 *   6. Metrics: branch="oauth" and branch="legacy" both ≥1 after the flows.
 *   6b. Auth-branch metric population: a legacy bearer on /api/* must NOT
 *       increment branch="legacy" (only /mcp authentications are counted, so the
 *       legacy-vs-oauth auth-mix metric compares like with like).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { createRequestHandler } from '../mem0-mcp-http.mjs';
import { createStateStore } from '../lib/oauth/state-store.mjs';
import { createConsentThrottle } from '../lib/oauth/throttle.mjs';
import { createOAuthVerifier } from '../lib/oauth/verifier.mjs';
import { createOAuthHandlers } from '../lib/oauth/endpoints.mjs';
import { umMcpAuthBranchTotal } from '../lib/metrics.mjs';

const BASE = 'https://um.example.com';
const OPERATOR = 'operator-secret-token';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CLIENT_ID = 'client-happy';
const FWD = { 'X-Forwarded-For': '1.2.3.4' }; // defeat shouldBypassLoopback

const fakeMemory = { getAll: async () => ({ results: [] }) };

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

// Build a tmpdir-rooted ctx.oauth (store + handlers + verify) exactly as the
// production seam does, so tests can pre-seed the store and inspect it.
function makeOAuthCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-int-'));
  const store = createStateStore(dir);
  const handlers = createOAuthHandlers({
    store, baseUrl: BASE, operatorToken: OPERATOR, throttle: createConsentThrottle(),
  });
  const verify = createOAuthVerifier(store, BASE);
  return { dir, oauth: { store, handlers, verify } };
}

/**
 * Start a server. When `oauth` is passed it is injected via ctx (and the env
 * flag is set so the endpoint-class rows admit /oauth/* + the middleware adds
 * the OAuth breadcrumb). When omitted, the flag is forced off and ctx.oauth is
 * absent — the flag-off gating case.
 */
async function startServer({ token = 'legacy-secret', memory = fakeMemory, oauth = null } = {}) {
  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  const del = (k) => { saved[k] = process.env[k]; delete process.env[k]; };

  set('UM_AUTH_TOKEN', token);
  if (oauth) {
    set('UM_OAUTH_ENABLED', 'true');
    set('UM_PUBLIC_BASE_URL', BASE);
  } else {
    del('UM_OAUTH_ENABLED');
    del('UM_PUBLIC_BASE_URL');
  }

  const ctx = oauth ? { memory, oauth } : { memory };
  const srv = createServer(createRequestHandler(ctx));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();

  const close = async () => {
    srv.close();
    await once(srv, 'close');
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  return { url, close };
}

// Raw GET via node:http so we can send `Sec-Fetch-Mode: navigate` — undici's
// fetch forces sec-fetch-mode:cors (a forbidden header), which would drive the
// programmatic JSON-consent_url path instead of the browser HTML page. The real
// operator opens consent_url in a browser (sfm=navigate); this simulates that.
function rawGet(fullUrl, headers = {}) {
  const u = new URL(fullUrl);
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

// Pull authz_id + csrf out of the rendered consent page.
function parseConsentForm(html) {
  const authzId = html.match(/name="authz_id" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  return { authzId, csrf };
}

// --------------------------------------------------------------------------
// Test 1 — FULL happy path through the live server.
// --------------------------------------------------------------------------

test('OAuth integration: full happy path → umat_ token authenticates /mcp tools/list', async () => {
  const { dir, oauth } = makeOAuthCtx();
  const now = Date.now();
  oauth.store.putClient({
    client_id: CLIENT_ID, client_name: 'Seeded client', redirect_uris: [REDIRECT],
    created: now, lastUsed: now, source: 'manual',
  });
  const { url, close } = await startServer({ oauth });
  try {
    const { verifier, challenge } = pkcePair();

    // (a) GET /oauth/authorize — browser-shaped (Accept text/html) → consent HTML.
    const authzQuery = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'vault offline_access',
      state: 'xyz',
    }).toString();
    // Browser-navigation GET (raw http so Sec-Fetch-Mode: navigate survives) →
    // HTML consent page carrying authz_id + csrf.
    const authzRes = await rawGet(url(`/oauth/authorize?${authzQuery}`), {
      ...FWD, 'Accept': 'text/html', 'Sec-Fetch-Mode': 'navigate',
    });
    assert.equal(authzRes.status, 200, 'authorize should render consent HTML');
    const { authzId, csrf } = parseConsentForm(authzRes.body);
    assert.ok(authzId && csrf, 'consent page must carry authz_id + csrf');
    assert.match(authzRes.body, /Seeded client/, 'consent page must display the client_name');

    // (b) POST /oauth/consent with the operator token → 303 with ?code=.
    const consentRes = await fetch(url('/oauth/consent'), {
      method: 'POST', redirect: 'manual',
      headers: { ...FWD, 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': BASE },
      body: new URLSearchParams({
        authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow',
      }).toString(),
    });
    assert.equal(consentRes.status, 303, 'consent allow should 303-redirect');
    const loc = consentRes.headers.get('location');
    const code = new URL(loc).searchParams.get('code');
    assert.ok(code, 'redirect Location must carry the authorization code');

    // (c) POST /oauth/token with the PKCE verifier → access token.
    const tokenRes = await fetch(url('/oauth/token'), {
      method: 'POST',
      headers: { ...FWD, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: CLIENT_ID,
        redirect_uri: REDIRECT, code_verifier: verifier,
      }).toString(),
    });
    assert.equal(tokenRes.status, 200, 'token exchange should succeed');
    const tok = await tokenRes.json();
    assert.ok(tok.access_token?.startsWith('umat_'), 'should mint a umat_ access token');

    // (d) POST /mcp tools/list with Bearer umat_… → 200 real MCP result.
    const mcpRes = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(mcpRes.status, 200, 'OAuth bearer must authenticate /mcp');
    const mcpBody = await mcpRes.json();
    assert.ok(Array.isArray(mcpBody.result?.tools), 'tools/list must return a real MCP result');
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// PR-5 operator revocation — loopback POST /oauth/revoke through the LIVE
// server. The endpoint-class row (oauthRevokePolicy) makes /oauth/revoke
// loopback-only: a loopback caller bypasses the legacy auth block, so the
// operator CLI never needs the auth token. The off-loopback 404 posture is
// asserted directly at the policy layer in endpoint-class.test.mjs (sourceIp =
// socket.remoteAddress, which is ALWAYS 127.0.0.1 over a real test socket — an
// X-Forwarded-For header does not change the revoke row's decision, so it
// cannot be exercised through a real socket here).
// --------------------------------------------------------------------------

test('OAuth integration: loopback POST /oauth/revoke {all} kills live tokens WITHOUT auth header', async () => {
  const { dir, oauth } = makeOAuthCtx();
  const now = Date.now();
  oauth.store.putClient({
    client_id: CLIENT_ID, client_name: 'Seeded client', redirect_uris: [REDIRECT],
    created: now, lastUsed: now, source: 'manual',
  });
  // Mint a live access token straight through the store (the issuance flow is
  // covered above; here we only need a live umat_ to watch die).
  const issued = oauth.store.issueTokens({
    sub: 'owner', aud: `${BASE}/mcp`, scope: ['vault'], offlineAccess: true, clientId: CLIENT_ID,
  });
  const { url, close } = await startServer({ oauth });
  try {
    // Sanity: the token authenticates /mcp first (loopback, no XFF → still goes
    // through the OAuth verifier branch which trusts the bearer regardless).
    // /mcp carries X-Forwarded-For so it does NOT take the loopback auth bypass
    // (shouldBypassLoopback) — the OAuth verifier branch must actually run.
    const before = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': `Bearer ${issued.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(before.status, 200, 'token live before revoke');

    // Loopback revoke — NO Authorization header (the loopback row bypasses auth).
    const rev = await fetch(url('/oauth/revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    assert.equal(rev.status, 200, 'loopback revoke bypasses auth');
    const revBody = await rev.json();
    assert.equal(revBody.revoked, 'all');
    assert.ok(revBody.counts.accessTokens >= 1, 'counts report the killed token');

    // The SAME revoke after the kill reports zeroes — confirms the live store mutated.
    const after = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': `Bearer ${issued.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(after.status, 401, 'revoked token no longer authenticates /mcp');
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Manual-client seeding (spec §8 PR-2) + 405 on wrong method.
// --------------------------------------------------------------------------

test('OAuth integration: UM_OAUTH_SEED_CLIENT seeds a manual client at construction', async () => {
  // Exercise seeding through the LIVE construction seam (no ctx.oauth injected):
  // the handler builds its own store at UM_VAULT_DIR and runs seedManualClient.
  // Re-open that on-disk store afterward to assert the client landed.
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-vault-'));
  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set('UM_VAULT_DIR', vaultDir);
  set('UM_OAUTH_SEED_CLIENT', `seeded-id|${REDIRECT}`);
  set('UM_OAUTH_ENABLED', 'true');
  set('UM_PUBLIC_BASE_URL', BASE);
  set('UM_AUTH_TOKEN', 'legacy-secret');
  try {
    createRequestHandler({ memory: fakeMemory }); // construction triggers the seam
    const seededStore = createStateStore(vaultDir);
    const client = seededStore.getClient('seeded-id');
    assert.ok(client, 'manual client must be seeded');
    assert.equal(client.source, 'manual');
    assert.deepEqual(client.redirect_uris, [REDIRECT]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// CIMD (PR 4) — a URL-shaped client_id is resolved through a stub cimdResolver
// wired into the handlers, driven over HTTP through the LIVE server. Asserts
// the consent page renders the CIMD document's client_name.
// --------------------------------------------------------------------------

test('OAuth integration: CIMD URL client_id renders the document client_name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-oauth-cimd-'));
  const store = createStateStore(dir);
  const cimdUrl = 'https://chatgpt.com/oauth/abc/client.json';
  const cimdRedirect = 'https://chatgpt.com/connector/oauth/abc123';
  const cimdResolver = async (clientId) => (clientId === cimdUrl ? {
    client_id: cimdUrl, client_name: 'ChatGPT Connector',
    redirect_uris: [cimdRedirect], grant_types: ['authorization_code'], source: 'cimd',
  } : null);
  const handlers = createOAuthHandlers({
    store, baseUrl: BASE, operatorToken: OPERATOR, throttle: createConsentThrottle(), cimdResolver,
  });
  const verify = createOAuthVerifier(store, BASE);
  const { url, close } = await startServer({ oauth: { store, handlers, verify } });
  try {
    const { challenge } = pkcePair();
    const q = new URLSearchParams({
      response_type: 'code', client_id: cimdUrl, redirect_uri: cimdRedirect,
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'vault',
    }).toString();
    const res = await rawGet(url(`/oauth/authorize?${q}`), {
      ...FWD, 'Accept': 'text/html', 'Sec-Fetch-Mode': 'navigate',
    });
    assert.equal(res.status, 200, res.body);
    assert.match(res.body, /ChatGPT Connector/, 'consent page must render the CIMD doc client_name');
    const { authzId, csrf } = parseConsentForm(res.body);
    assert.ok(authzId && csrf, 'consent page must carry authz_id + csrf');
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth integration: wrong method on /oauth/token → 405', async () => {
  const { dir, oauth } = makeOAuthCtx();
  const { url, close } = await startServer({ oauth });
  try {
    const r = await fetch(url('/oauth/token'), { method: 'GET', headers: FWD });
    assert.equal(r.status, 405, 'GET on a POST-only OAuth route → 405');
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 2 — legacy bearer still works on /mcp (regression).
// --------------------------------------------------------------------------

test('OAuth integration: legacy bearer still authenticates /mcp when OAuth is on', async () => {
  const { dir, oauth } = makeOAuthCtx();
  const { url, close } = await startServer({ oauth, token: 'legacy-secret' });
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': 'Bearer legacy-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.result?.tools));
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 3 — OAuth tokens are SCOPED TO /mcp (least-privilege, holistic-review
// finding 2026-06-13): the same umat_ token authenticates /mcp but is REJECTED
// on the REST surface, so a consented vendor token cannot mutate the mem0 store
// over /api/*. (The legacy bearer keeps full-surface access — test 2 / the
// broader auth suite cover that.)
// --------------------------------------------------------------------------

test('OAuth integration: umat_ token is scoped to /mcp — accepted on /mcp, 401 on /api/*', async () => {
  const { dir, oauth } = makeOAuthCtx();
  // Mint a token directly in the injected store (issuance path covered by test 1).
  const issued = oauth.store.issueTokens({
    sub: 'owner', aud: `${BASE}/mcp`, scope: ['vault'], offlineAccess: false, clientId: CLIENT_ID,
  });
  const memory = { getAll: async () => ({ results: [{ id: 'm1', memory: 'x', metadata: { id: 'd1' } }] }) };
  const { url, close } = await startServer({ oauth, memory });
  try {
    // Accepted on /mcp.
    const mcp = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': `Bearer ${issued.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(mcp.status, 200, 'OAuth token must authenticate /mcp');

    // Rejected on the REST surface (scoped out) — same token, 401.
    const rest = await fetch(url('/api/list'), {
      headers: { ...FWD, 'Authorization': `Bearer ${issued.accessToken}` },
    });
    assert.equal(rest.status, 401, 'OAuth token must NOT authenticate /api/* (scoped to /mcp)');
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 4 — flag-off gating: a structurally valid umat_ token never authenticates.
// --------------------------------------------------------------------------

test('OAuth integration: flag OFF → valid-looking umat_ token is rejected (ctx.oauth absent)', async () => {
  // Build a token in a store, but start the server WITHOUT oauth ctx (flag off).
  const { dir, oauth } = makeOAuthCtx();
  const issued = oauth.store.issueTokens({
    sub: 'owner', aud: `${BASE}/mcp`, scope: ['vault'], offlineAccess: false, clientId: CLIENT_ID,
  });
  const { url, close } = await startServer({ oauth: null }); // flag off, no ctx.oauth
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': `Bearer ${issued.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    assert.equal(r.status, 401, 'OAuth token must NOT authenticate when the flag is off');
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 5 — invalid/expired token on /mcp with flag on → 401 with BOTH the
// WWW-Authenticate header AND the JSON-RPC _meta re-auth trigger.
// --------------------------------------------------------------------------

test('OAuth integration: /mcp 401 carries WWW-Authenticate + _meta re-auth trigger', async () => {
  const { dir, oauth } = makeOAuthCtx();
  const { url, close } = await startServer({ oauth });
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': 'Bearer umat_not-a-real-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });
    assert.equal(r.status, 401);
    const www = r.headers.get('www-authenticate');
    assert.ok(www?.includes('/.well-known/oauth-protected-resource/mcp'), 'WWW-Authenticate present');

    const body = await r.json();
    // JSON-RPC-shaped error envelope with the ChatGPT re-auth trigger.
    const meta = body?.error?.data?._meta?.['mcp/www_authenticate'];
    assert.ok(meta, '_meta["mcp/www_authenticate"] must be present on /mcp 401');
    assert.equal(meta.error, 'invalid_token');
    assert.ok(typeof meta.error_description === 'string' && meta.error_description.length > 0);
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth integration: non-/mcp 401 keeps the legacy envelope (no _meta re-auth)', async () => {
  const { dir, oauth } = makeOAuthCtx();
  const { url, close } = await startServer({ oauth });
  try {
    const r = await fetch(url('/api/list'), {
      headers: { ...FWD, 'Authorization': 'Bearer wrong' },
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body?.ok, false);
    assert.equal(body?.error?.code, 'AUTH_INVALID');
    assert.equal(body?.error?.data?._meta, undefined, 'non-/mcp 401 must keep the legacy envelope');
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 6 — metrics: both branches counted.
// --------------------------------------------------------------------------

test('OAuth integration: um_mcp_auth_branch_total counts oauth + legacy branches', async () => {
  const { dir, oauth } = makeOAuthCtx();
  const issued = oauth.store.issueTokens({
    sub: 'owner', aud: `${BASE}/mcp`, scope: ['vault'], offlineAccess: false, clientId: CLIENT_ID,
  });
  const { url, close } = await startServer({ oauth, token: 'legacy-secret' });
  try {
    // One oauth-branch admit.
    await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': `Bearer ${issued.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    });
    // One legacy-branch admit.
    await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': 'Bearer legacy-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
    });
    // /metrics is loopback-only by default — fetch from loopback (no X-Forwarded-For).
    const m = await fetch(url('/metrics'));
    const text = await m.text();
    assert.match(text, /um_mcp_auth_branch_total\{branch="oauth"\}\s+[1-9]/);
    assert.match(text, /um_mcp_auth_branch_total\{branch="legacy"\}\s+[1-9]/);
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 6b — auth-branch metric POPULATION scoping (bugfix 2026-06-14).
//
// branch="oauth" only ever increments for /mcp — the OAuth arm is gated on
// url.pathname === '/mcp' (PR #114 / the least-privilege scoping above). The
// branch="legacy" counter MUST count the same population (/mcp authentications
// only) so the legacy-vs-oauth auth-mix metric (docs/oauth.md §8) compares like
// with like. A legacy bearer also authenticates the REST surface (/api/*), but
// those admits must NOT pollute branch="legacy" — otherwise the mix is skewed by
// REST traffic the oauth branch never sees. Asserted as a DELTA around a single
// request so it is independent of any increments from other tests sharing this
// counter singleton. No OAuth ctx needed — this is purely the legacy arm.
// --------------------------------------------------------------------------

// Current value of um_mcp_auth_branch_total{branch="legacy"} (0 if untouched).
async function legacyBranchCount() {
  const metric = await umMcpAuthBranchTotal.get();
  return metric.values.find((v) => v.labels.branch === 'legacy')?.value ?? 0;
}

test('OAuth integration: a legacy-token /api/* request does NOT increment branch="legacy"', async () => {
  const { url, close } = await startServer({ token: 'legacy-secret' });
  try {
    const before = await legacyBranchCount();
    // Valid legacy bearer on the REST surface. X-Forwarded-For defeats the
    // loopback auth bypass so the auth block (and its metric inc) actually runs.
    const r = await fetch(url('/api/list'), {
      headers: { ...FWD, 'Authorization': 'Bearer legacy-secret' },
    });
    assert.notEqual(r.status, 401, 'legacy bearer must still authenticate /api/* (auth behavior unchanged)');
    const after = await legacyBranchCount();
    assert.equal(after - before, 0, '/api/* admit must NOT increment branch="legacy" (not a /mcp auth)');
  } finally {
    await close();
  }
});

test('OAuth integration: a legacy-token /mcp request DOES increment branch="legacy"', async () => {
  const { url, close } = await startServer({ token: 'legacy-secret' });
  try {
    const before = await legacyBranchCount();
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...FWD, 'Authorization': 'Bearer legacy-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    assert.equal(r.status, 200, 'legacy bearer must authenticate /mcp');
    const after = await legacyBranchCount();
    assert.equal(after - before, 1, '/mcp legacy admit must increment branch="legacy" exactly once');
  } finally {
    await close();
  }
});

// --------------------------------------------------------------------------
// Test 7 — DCR (PR-3): register over HTTP on the live server, then assert the
// um_oauth_registrations_total{outcome="accepted"} metric appears in /metrics.
// Proves the onRegistration callback is wired through the production seam.
// --------------------------------------------------------------------------

// The onRegistration→metric wiring lives in the PRODUCTION construction seam
// (createRequestHandler), which an injected ctx.oauth would bypass (the `??=`
// skips it). So this test drives the LIVE construction path: flag on + a real
// UM_VAULT_DIR, no injected ctx.oauth. The server builds its own store +
// handlers and wires onRegistration → umOauthRegistrationsTotal.inc.
test('OAuth integration: POST /oauth/register increments um_oauth_registrations_total{accepted}', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-dcr-int-'));
  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set('UM_VAULT_DIR', vaultDir);
  set('UM_OAUTH_ENABLED', 'true');
  set('UM_PUBLIC_BASE_URL', BASE);
  set('UM_AUTH_TOKEN', 'legacy-secret');

  const srv = createServer(createRequestHandler({ memory: fakeMemory }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    const regRes = await fetch(url('/oauth/register'), {
      method: 'POST',
      headers: { ...FWD, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT], client_name: 'DCR client',
        grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(regRes.status, 201, 'DCR registration should succeed over the live server');
    const reg = await regRes.json();
    assert.ok(reg.client_id?.startsWith('umcl_'), 'should mint a umcl_ client_id');
    // The registered client landed in the on-disk store the server built.
    const persisted = createStateStore(vaultDir).getClient(reg.client_id);
    assert.ok(persisted, 'registered client must be persisted');
    assert.equal(persisted.source, 'dcr');

    // /metrics is loopback-only by default — fetch from loopback (no X-Forwarded-For).
    const m = await fetch(url('/metrics'));
    const text = await m.text();
    assert.match(text, /um_oauth_registrations_total\{outcome="accepted"\}\s+[1-9]/);
  } finally {
    srv.close();
    await once(srv, 'close');
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 8 — PR-5 consent + token-grant metrics (spec §6 item 12). Drive a full
// live consent-allow + authorization_code exchange through the PRODUCTION
// construction seam (no injected ctx.oauth — the `??=` would skip the wiring),
// then assert BOTH new counters appear in /metrics. Proves the onConsent +
// onTokenGrant callbacks are wired into the prom-client counters, mirroring the
// registrations metric test above.
// --------------------------------------------------------------------------
test('OAuth integration: consent allow + token issue increment um_oauth_consent_total + um_oauth_token_grants_total', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-grant-int-'));
  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set('UM_VAULT_DIR', vaultDir);
  set('UM_OAUTH_ENABLED', 'true');
  set('UM_PUBLIC_BASE_URL', BASE);
  set('UM_AUTH_TOKEN', OPERATOR);                       // operator token = consent paste
  set('UM_OAUTH_SEED_CLIENT', `${CLIENT_ID}|${REDIRECT}`); // seed a manual client at construction

  const srv = createServer(createRequestHandler({ memory: fakeMemory }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    const { verifier, challenge } = pkcePair();

    // (a) authorize — browser-navigation GET (raw http so Sec-Fetch-Mode survives).
    const authzQuery = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'vault', state: 'pr5',
    }).toString();
    const authzRes = await rawGet(url(`/oauth/authorize?${authzQuery}`), {
      ...FWD, 'Accept': 'text/html', 'Sec-Fetch-Mode': 'navigate',
    });
    assert.equal(authzRes.status, 200, authzRes.body);
    const { authzId, csrf } = parseConsentForm(authzRes.body);
    assert.ok(authzId && csrf, 'consent page must carry authz_id + csrf');

    // (b) consent allow → 303 with code (drives onConsent('allow')).
    const consentRes = await fetch(url('/oauth/consent'), {
      method: 'POST', redirect: 'manual',
      headers: { ...FWD, 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': BASE },
      body: new URLSearchParams({ authz_id: authzId, csrf, operator_token: OPERATOR, decision: 'allow' }).toString(),
    });
    assert.equal(consentRes.status, 303, 'consent allow should 303-redirect');
    const code = new URL(consentRes.headers.get('location')).searchParams.get('code');
    assert.ok(code, 'redirect Location must carry the authorization code');

    // (c) token exchange → 200 (drives onTokenGrant('authorization_code','issued')).
    const tokenRes = await fetch(url('/oauth/token'), {
      method: 'POST',
      headers: { ...FWD, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: CLIENT_ID,
        redirect_uri: REDIRECT, code_verifier: verifier,
      }).toString(),
    });
    assert.equal(tokenRes.status, 200, 'token exchange should succeed');

    // (d) /metrics (loopback) carries BOTH new counters.
    const m = await fetch(url('/metrics'));
    const text = await m.text();
    assert.match(text, /um_oauth_consent_total\{outcome="allow",method="token"\}\s+[1-9]/);
    assert.match(text, /um_oauth_token_grants_total\{grant_type="authorization_code",outcome="issued"\}\s+[1-9]/);
  } finally {
    srv.close();
    await once(srv, 'close');
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Task 2.9 — social-login wiring through the PRODUCTION construction seam.
// The registry/operatorPolicy/callbackThrottle are built inside the
// `ctx.oauth ??=` IIFE from env (createRequestHandler), which an injected
// ctx.oauth would bypass. So this drives the LIVE path: flag on + the GitHub
// trio + a real UM_VAULT_DIR, NO injected ctx.oauth. Only this catches a
// bootstrap-glue bug (registry not built, or not passed to the dispatch).
//   - GET  /oauth/idp/github/login  → 405 (registry HAS github → not 404;
//        login is POST-only so the method gate fires) — proves the IIFE built
//        the real registry AND the dispatch found github in it.
//   - POST /oauth/idp/unknown/login → 404 (registry is the allowlist).
//   - full authorize → POST /oauth/idp/github/login (valid authz_id+csrf) →
//        303 to github.com/login/oauth/authorize — proves the whole prod chain
//        incl. the real adapter's pure buildAuthorizeUrl.
// --------------------------------------------------------------------------
test('production bootstrap: real IdP env builds the registry and /oauth/idp routes via it', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-idp-int-'));
  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set('UM_VAULT_DIR', vaultDir);
  set('UM_OAUTH_ENABLED', 'true');
  set('UM_PUBLIC_BASE_URL', BASE);
  set('UM_AUTH_TOKEN', OPERATOR);
  set('UM_OAUTH_IDP_GITHUB_CLIENT_ID', 'Iv1.testclientid');
  set('UM_OAUTH_IDP_GITHUB_CLIENT_SECRET', 'gh-secret');
  set('UM_OAUTH_OPERATOR_GITHUB', '5550123');             // numeric id → coherent (no advisory)
  set('UM_OAUTH_SEED_CLIENT', `${CLIENT_ID}|${REDIRECT}`); // seed a manual client so authorize works

  // ctx = { memory } only — NO injected oauth → the IIFE builds the registry from env.
  const srv = createServer(createRequestHandler({ memory: fakeMemory }));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    // (1) GET on the POST-only login leg → 405 (provider is in the registry).
    const wrongMethod = await fetch(url('/oauth/idp/github/login'), { method: 'GET', headers: FWD });
    assert.equal(wrongMethod.status, 405, 'github is in the registry → method-gated, not 404');
    assert.equal(wrongMethod.headers.get('allow'), 'POST', '405 must advertise the allowed method');

    // (1b) callback leg is GET-only → POST is method-gated
    const cbPost = await fetch(url('/oauth/idp/github/callback'), { method: 'POST', headers: { ...FWD } });
    assert.equal(cbPost.status, 405, 'callback leg is GET-only → POST must be method-gated');

    // (2) Unknown provider → 404 (registry is the allowlist).
    const unknown = await fetch(url('/oauth/idp/unknown/login'), { method: 'POST', headers: FWD });
    assert.equal(unknown.status, 404, 'unknown provider → 404 via the registry allowlist');

    // (3) Full prod chain: authorize → consent-page parse → login → 302 to GitHub.
    const { challenge } = pkcePair();
    const authzQuery = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'vault', state: 't29',
    }).toString();
    const authzRes = await rawGet(url(`/oauth/authorize?${authzQuery}`), {
      ...FWD, 'Accept': 'text/html', 'Sec-Fetch-Mode': 'navigate',
    });
    assert.equal(authzRes.status, 200, authzRes.body);
    const { authzId, csrf } = parseConsentForm(authzRes.body);
    assert.ok(authzId && csrf, 'consent page must carry authz_id + csrf');

    const loginRes = await fetch(url('/oauth/idp/github/login'), {
      method: 'POST', redirect: 'manual',
      headers: { ...FWD, 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': BASE, 'Sec-Fetch-Site': 'same-origin' },
      body: new URLSearchParams({ authz_id: authzId, csrf }).toString(),
    });
    // 303 (See Other) — the POST login leg redirects the browser to a GET at the
    // provider via the shared redirect() helper (POST→GET semantics).
    assert.equal(loginRes.status, 303, 'login leg should redirect to the provider');
    const loc = loginRes.headers.get('location');
    assert.ok(loc?.startsWith('https://github.com/login/oauth/authorize'),
      `login must redirect to GitHub authorize (real adapter buildAuthorizeUrl); got ${loc}`);
  } finally {
    srv.close();
    await once(srv, 'close');
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});
