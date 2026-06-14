/**
 * OAuth discovery endpoint tests — Gap-3 PR-1 Task 1.3.
 *
 * Covers:
 *   1. Flag on + base set → 200 JSON for all three discovery paths; correct doc fields.
 *   2. Flag off → 404 for all three paths.
 *   3. /mcp 401 with flag on → WWW-Authenticate header present; flag off → absent.
 *   4. Host-mismatch → still 200 with config-derived URLs (warn fired, behavior is the contract).
 *   5. Limiter independence: exhausting the OAuth limiter does NOT 429 a /mcp request.
 *   6. validateOAuthConfig: throws/passes per spec.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequestHandler } from '../mem0-mcp-http.mjs';
import { validateOAuthConfig, idpConfigWarning } from '../lib/startup-validation.mjs';

const BASE = 'https://um.example.com';

const fakeMemory = {
  getAll: async () => ({ results: [] }),
};

// ---------------------------------------------------------------------------
// Server helpers — mirrors middleware-chain.test.mjs pattern exactly.
// ---------------------------------------------------------------------------

/**
 * Start a server with the given env overrides.
 * Returns { url(path), close }.
 * Saves and restores all touched env vars on close.
 */
async function startServer({ oauthEnabled = false, base = BASE, token = 'test-token', memory = fakeMemory } = {}) {
  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  const del = (k) => { saved[k] = process.env[k]; delete process.env[k]; };

  if (oauthEnabled) {
    set('UM_OAUTH_ENABLED', 'true');
    set('UM_PUBLIC_BASE_URL', base);
  } else {
    del('UM_OAUTH_ENABLED');
    del('UM_PUBLIC_BASE_URL');
  }
  set('UM_AUTH_TOKEN', token);

  const srv = createServer(createRequestHandler({ memory }));
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

// ---------------------------------------------------------------------------
// Test 1 — Flag on: all three paths return 200 JSON with correct fields.
// ---------------------------------------------------------------------------

test('OAuth discovery: flag on → 200 JSON for all three paths', async () => {
  const { url, close } = await startServer({ oauthEnabled: true });
  try {
    const paths = [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ];
    for (const p of paths) {
      const r = await fetch(url(p));
      assert.equal(r.status, 200, `expected 200 for ${p}, got ${r.status}`);
      const ct = r.headers.get('content-type') ?? '';
      assert.ok(ct.includes('application/json'), `expected JSON content-type for ${p}, got ${ct}`);
      // Consume body so no connection leak
      await r.json();
    }
  } finally { await close(); }
});

test('OAuth discovery: AS doc has issuer === base', async () => {
  const { url, close } = await startServer({ oauthEnabled: true });
  try {
    const r = await fetch(url('/.well-known/oauth-authorization-server'));
    assert.equal(r.status, 200);
    const doc = await r.json();
    assert.equal(doc.issuer, BASE);
  } finally { await close(); }
});

test('OAuth discovery: both PRM paths have resource === base + /mcp', async () => {
  const { url, close } = await startServer({ oauthEnabled: true });
  try {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await fetch(url(p));
      assert.equal(r.status, 200);
      const doc = await r.json();
      assert.equal(doc.resource, `${BASE}/mcp`, `resource mismatch on ${p}`);
    }
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Test 2 — Flag off: all three paths return 404.
// ---------------------------------------------------------------------------

test('OAuth discovery: flag off → 404 for all three paths', async () => {
  const { url, close } = await startServer({ oauthEnabled: false });
  try {
    const paths = [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ];
    for (const p of paths) {
      const r = await fetch(url(p));
      assert.equal(r.status, 404, `expected 404 for ${p} when flag off, got ${r.status}`);
    }
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Test 3 — 401 WWW-Authenticate breadcrumb.
// ---------------------------------------------------------------------------

test('OAuth 401: /mcp with bad bearer + flag on → 401 WITH WWW-Authenticate', async () => {
  const { url, close } = await startServer({ oauthEnabled: true });
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer wrong-token',
        'X-Forwarded-For': '1.2.3.4',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(r.status, 401);
    const wwwAuth = r.headers.get('www-authenticate');
    assert.ok(wwwAuth != null, 'expected WWW-Authenticate header to be present');
    assert.ok(
      wwwAuth.includes('/.well-known/oauth-protected-resource/mcp'),
      `WWW-Authenticate should reference PRM path, got: ${wwwAuth}`,
    );
    assert.ok(
      wwwAuth.includes('scope="vault"'),
      `WWW-Authenticate should include scope="vault", got: ${wwwAuth}`,
    );
    // Exact format check
    const expectedPrefix = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`;
    assert.ok(wwwAuth.startsWith(expectedPrefix), `WWW-Authenticate header format wrong: ${wwwAuth}`);
  } finally { await close(); }
});

test('OAuth 401: /mcp with bad bearer + flag off → 401 WITHOUT WWW-Authenticate', async () => {
  const { url, close } = await startServer({ oauthEnabled: false });
  // We need UM_AUTH_TOKEN set so we get 401 (not 500). Base not set when flag off.
  try {
    const r = await fetch(url('/mcp'), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer wrong-token',
        'X-Forwarded-For': '1.2.3.4',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(r.status, 401);
    const wwwAuth = r.headers.get('www-authenticate');
    assert.equal(wwwAuth, null, `expected no WWW-Authenticate when OAuth off, got: ${wwwAuth}`);
  } finally { await close(); }
});

test('OAuth 401: non-/mcp path with flag on → 401 WITHOUT WWW-Authenticate', async () => {
  const { url, close } = await startServer({ oauthEnabled: true });
  try {
    const r = await fetch(url('/api/list'), {
      headers: {
        'Authorization': 'Bearer wrong-token',
        'X-Forwarded-For': '1.2.3.4',
      },
    });
    assert.equal(r.status, 401);
    const wwwAuth = r.headers.get('www-authenticate');
    assert.equal(wwwAuth, null, `expected no WWW-Authenticate on /api/list, got: ${wwwAuth}`);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Test 4 — Host mismatch: still 200 with config-derived URLs.
// ---------------------------------------------------------------------------

test('OAuth discovery: host-mismatch → 200 with config-derived URLs (not host-derived)', async () => {
  const { url, close } = await startServer({ oauthEnabled: true, base: 'https://um.example.com' });
  try {
    // Use a Host header that differs from UM_PUBLIC_BASE_URL's host
    const r = await fetch(url('/.well-known/oauth-authorization-server'), {
      headers: { 'Host': 'attacker.example.com' },
    });
    assert.equal(r.status, 200, `expected 200 despite host mismatch, got ${r.status}`);
    const doc = await r.json();
    // URLs must be derived from UM_PUBLIC_BASE_URL, not the Host header
    assert.equal(doc.issuer, 'https://um.example.com');
    assert.ok(
      !doc.issuer.includes('attacker'),
      `issuer must not contain attacker's host, got: ${doc.issuer}`,
    );
  } finally { await close(); }
});

test('OAuth discovery: host-mismatch on PRM → 200 with config-derived resource URL', async () => {
  const { url, close } = await startServer({ oauthEnabled: true, base: 'https://um.example.com' });
  try {
    const r = await fetch(url('/.well-known/oauth-protected-resource'), {
      headers: { 'Host': 'proxy.internal' },
    });
    assert.equal(r.status, 200);
    const doc = await r.json();
    assert.equal(doc.resource, 'https://um.example.com/mcp');
    assert.ok(!doc.resource.includes('proxy'), `resource must not contain proxy host, got: ${doc.resource}`);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Test 5 — Limiter independence: exhausting OAuth limiter ≠ 429 on /mcp.
// ---------------------------------------------------------------------------

test('Limiter independence: OAuth limiter exhausted does NOT 429 a /mcp request', async () => {
  // The OAuth limiter uses fixed opts (rpm:30, burst:10) so we exhaust by
  // sending > burst requests. Send 12 GETs from the same IP (via
  // X-Forwarded-For) to a well-known path until we see a 429, then verify
  // /mcp is NOT 429 from that IP (shared admit bucket is independent).
  const { url, close } = await startServer({ oauthEnabled: true });
  try {
    const headers = { 'X-Forwarded-For': '5.6.7.8' };
    // The dedicated OAuth limiter has burst=10. Send 12 requests to exhaust it.
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(url('/.well-known/oauth-authorization-server'), { headers });
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, 'Expected to hit 429 from OAuth limiter after burst exhaustion');

    // Now a /mcp request from the same IP (with X-Forwarded-For) should NOT be 429.
    // It will be 401 (bad/missing token) — that's fine. The shared admit bucket
    // is separate from oauthAdmit.
    const mcpR = await fetch(url('/mcp'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(mcpR.status, 429, `expected /mcp to not be 429 (got ${mcpR.status}); shared limiter must be independent`);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// Test 6 — validateOAuthConfig unit tests.
// ---------------------------------------------------------------------------

test('validateOAuthConfig: throws when on + UM_PUBLIC_BASE_URL unset', () => {
  assert.throws(
    () => validateOAuthConfig({ UM_OAUTH_ENABLED: 'true' }),
    /UM_PUBLIC_BASE_URL/,
  );
});

test('validateOAuthConfig: throws when on + UM_PUBLIC_BASE_URL empty string', () => {
  assert.throws(
    () => validateOAuthConfig({ UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: '' }),
    /UM_PUBLIC_BASE_URL/,
  );
});

test('validateOAuthConfig: throws when on + ftp:// scheme', () => {
  assert.throws(
    () => validateOAuthConfig({ UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'ftp://um.example.com' }),
    /UM_PUBLIC_BASE_URL/,
  );
});

test('validateOAuthConfig: throws when on + not a URL', () => {
  assert.throws(
    () => validateOAuthConfig({ UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'not a url' }),
    /UM_PUBLIC_BASE_URL/,
  );
});

test('validateOAuthConfig: passes when on + https:// URL', () => {
  assert.doesNotThrow(
    () => validateOAuthConfig({ UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'https://um.example.com' }),
  );
});

test('validateOAuthConfig: passes when on + http:// URL', () => {
  assert.doesNotThrow(
    () => validateOAuthConfig({ UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'http://localhost:6335' }),
  );
});

test('validateOAuthConfig: no-op when OAuth off (no UM_PUBLIC_BASE_URL needed)', () => {
  assert.doesNotThrow(
    () => validateOAuthConfig({ UM_OAUTH_ENABLED: 'false' }),
  );
});

test('validateOAuthConfig: no-op when UM_OAUTH_ENABLED absent', () => {
  assert.doesNotThrow(
    () => validateOAuthConfig({}),
  );
});

// ---------------------------------------------------------------------------
// Social-login IdP trio validation (PR-1).
// ---------------------------------------------------------------------------
test('validateOAuthConfig: throws on a partial GitHub IdP trio (CLIENT_ID only)', () => {
  assert.throws(
    () => validateOAuthConfig({
      UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'https://um.example.com',
      UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'cid', // secret + operator missing
    }),
    /all of|CLIENT_SECRET|half-enabled/i,
  );
});

test('validateOAuthConfig: passes on a full GitHub IdP trio', () => {
  assert.doesNotThrow(
    () => validateOAuthConfig({
      UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'https://um.example.com',
      UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'cid', UM_OAUTH_IDP_GITHUB_CLIENT_SECRET: 'sec',
      UM_OAUTH_OPERATOR_GITHUB: '5550123',
    }),
  );
});

test('validateOAuthConfig: passes when no IdP configured (token-only install)', () => {
  assert.doesNotThrow(
    () => validateOAuthConfig({ UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'https://um.example.com' }),
  );
});

test('idpConfigWarning: login-only operator → namespace-incoherence warning', () => {
  const msg = idpConfigWarning({
    UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'cid', UM_OAUTH_IDP_GITHUB_CLIENT_SECRET: 'sec',
    UM_OAUTH_OPERATOR_GITHUB: 'goldenwo',
  });
  assert.match(msg, /numeric id/i);
});

test('idpConfigWarning: numeric operator → null (coherent seam)', () => {
  assert.equal(idpConfigWarning({
    UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'cid', UM_OAUTH_IDP_GITHUB_CLIENT_SECRET: 'sec',
    UM_OAUTH_OPERATOR_GITHUB: '5550123',
  }), null);
});

test('idpConfigWarning: unconfigured → null', () => {
  assert.equal(idpConfigWarning({}), null);
});

test('validateOAuthConfig: throws on a partial GitHub IdP trio (SECRET + OPERATOR, no CLIENT_ID)', () => {
  assert.throws(
    () => validateOAuthConfig({
      UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'https://um.example.com',
      UM_OAUTH_IDP_GITHUB_CLIENT_SECRET: 'sec',
      UM_OAUTH_OPERATOR_GITHUB: '5550123',
    }),
    /all of|CLIENT_ID|half-enabled/i,
  );
});

test('validateOAuthConfig: whitespace-only IdP value treated as absent (partial trio throws)', () => {
  assert.throws(
    () => validateOAuthConfig({
      UM_OAUTH_ENABLED: 'true', UM_PUBLIC_BASE_URL: 'https://um.example.com',
      UM_OAUTH_IDP_GITHUB_CLIENT_ID: '   ', UM_OAUTH_IDP_GITHUB_CLIENT_SECRET: 'sec',
      UM_OAUTH_OPERATOR_GITHUB: '5550123',
    }),
    /all of|CLIENT_ID|half-enabled/i,
  );
});
