/**
 * Tests for server/lib/endpoint-class.mjs
 *
 * Run with: node --test server/test/endpoint-class.test.mjs
 *
 * Pins the table-driven routing policy from spec §4.2 step 3:
 * for each request, decide whether auth + rate-limit apply, or
 * whether the endpoint is public / loopback-gated / reserved.
 *
 * First-match-wins scan order matters: the `?gpt=1` rule MUST fire
 * before the catch-all /openapi.yaml row. Reserved /providers/*
 * (v0.7) and /admin/* (v1.0) are present as fall-through rows now
 * so v0.7 adds rows, not switch branches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointClassRoute } from '../lib/endpoint-class.mjs';

const req = (pathname, search = '') => ({ url: pathname + search, headers: {} });

// ---------------------------------------------------------------------------
// Baseline 8 (from Task B.2 spec)
// ---------------------------------------------------------------------------

test('/health bypasses auth and rate-limit', () => {
  const r = endpointClassRoute(req('/health'));
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true);
});

test('/openapi.yaml?gpt=1 bypasses auth', () => {
  const r = endpointClassRoute(req('/openapi.yaml', '?gpt=1'));
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true);
});

test('/openapi.yaml (no ?gpt=1) with default UM_OPENAPI_AUTH_REQUIRED=true requires auth', () => {
  const r = endpointClassRoute(req('/openapi.yaml'), { UM_OPENAPI_AUTH_REQUIRED: 'true' });
  assert.equal(r.bypassAuth, false);
});

test('/metrics with loopback-only + loopback IP bypasses auth', () => {
  const r = endpointClassRoute(req('/metrics'), { UM_METRICS_LOOPBACK_ONLY: 'true' }, '127.0.0.1');
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true);
});

test('/metrics with loopback-only + non-loopback IP returns 404', () => {
  const r = endpointClassRoute(req('/metrics'), { UM_METRICS_LOOPBACK_ONLY: 'true' }, '10.0.0.5');
  assert.equal(r.returnStatus, 404);
});

test('/metrics with loopback-only=false requires auth', () => {
  const r = endpointClassRoute(req('/metrics'), { UM_METRICS_LOOPBACK_ONLY: 'false', UM_METRICS_AUTH_REQUIRED: 'true' }, '10.0.0.5');
  assert.equal(r.bypassAuth, false);
});

test('/api/* falls through to auth + rate-limit', () => {
  const r = endpointClassRoute(req('/api/recent/foo'));
  assert.equal(r.bypassAuth, false);
  assert.equal(r.bypassRateLimit, false);
});

test('/providers/* (v0.7 reserved) falls through (no 404 in v0.6)', () => {
  const r = endpointClassRoute(req('/providers/foo'));
  assert.equal(r.bypassAuth, false);
});

// ---------------------------------------------------------------------------
// Additional guard tests (self-review additions)
// ---------------------------------------------------------------------------

test('/health/foo is NOT /health (exact match guard)', () => {
  // /health/foo must not inherit the /health bypass — it falls through
  // to the catch-all (auth + rate-limit).
  const r = endpointClassRoute(req('/health/foo'));
  assert.equal(r.bypassAuth, false);
  assert.equal(r.bypassRateLimit, false);
});

test('/Providers/foo (uppercase) does NOT match /providers/* (case-sensitive)', () => {
  // URL paths are case-sensitive per RFC 3986; /Providers/* must not
  // silently match the reserved row. It falls through to catch-all.
  const r = endpointClassRoute(req('/Providers/foo'));
  assert.equal(r.bypassAuth, false);
  assert.equal(r.bypassRateLimit, false);
});

test('/api (no trailing slash) does NOT match /api/* prefix', () => {
  // Boundary guard: the prefix row is /api/ (with slash). /api bare
  // must fall through to the catch-all — it's not an API route.
  const r = endpointClassRoute(req('/api'));
  assert.equal(r.bypassAuth, false);
  assert.equal(r.bypassRateLimit, false);
});

test('/metrics with IPv6 loopback ::1 bypasses auth', () => {
  // Node's req.socket.remoteAddress commonly reports ::1 for IPv6
  // loopback. Must be treated as loopback alongside 127.0.0.1.
  const r = endpointClassRoute(req('/metrics'), { UM_METRICS_LOOPBACK_ONLY: 'true' }, '::1');
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true);
});

test('/metrics public + auth NOT required → bypass', () => {
  // loopback-only=false + auth-required=false → ops explicitly opted
  // out; function bypasses auth + rate-limit so the scrape succeeds.
  const r = endpointClassRoute(req('/metrics'), { UM_METRICS_LOOPBACK_ONLY: 'false', UM_METRICS_AUTH_REQUIRED: 'false' }, '10.0.0.5');
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true);
});

test('/openapi.yaml with UM_OPENAPI_AUTH_REQUIRED=false bypasses auth', () => {
  // Explicit opt-out for the OpenAPI spec (no ?gpt=1).
  const r = endpointClassRoute(req('/openapi.yaml'), { UM_OPENAPI_AUTH_REQUIRED: 'false' });
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true);
});

test('/mcp falls through to auth + rate-limit', () => {
  // MCP HTTP transport must stay authenticated.
  const r = endpointClassRoute(req('/mcp'));
  assert.equal(r.bypassAuth, false);
  assert.equal(r.bypassRateLimit, false);
});

test('unknown path (catch-all) falls through to auth + rate-limit (safe default)', () => {
  // If no row matches, the function must default-close: require auth
  // and rate-limit. This prevents a missing row from silently opening
  // a public endpoint.
  const r = endpointClassRoute(req('/totally-unknown-path'));
  assert.equal(r.bypassAuth, false);
  assert.equal(r.bypassRateLimit, false);
});

test('/admin/* (v1.0 reserved) falls through to auth + rate-limit', () => {
  // Reserved for v1.0; until then it just requires auth like any API.
  const r = endpointClassRoute(req('/admin/users'));
  assert.equal(r.bypassAuth, false);
  assert.equal(r.bypassRateLimit, false);
});

test('first-match-wins: ?gpt=1 row fires before catch-all /openapi.yaml row', () => {
  // Regression guard for the row-order contract. If someone reorders
  // the table and puts the catch-all first, ?gpt=1 would stop
  // bypassing auth. This pins the invariant.
  const r = endpointClassRoute(req('/openapi.yaml', '?gpt=1'), { UM_OPENAPI_AUTH_REQUIRED: 'true' });
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true);
});

// ---------------------------------------------------------------------------
// OAuth rows — spec 4.1: one ROW per route, 404 when UM_OAUTH_ENABLED!=='true'
// ---------------------------------------------------------------------------

const OAUTH_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/register', '/oauth/authorize', '/oauth/consent', '/oauth/token',
];
for (const p of OAUTH_PATHS) {
  test(`${p} hard-404s when OAuth disabled (no half-enabled state)`, () => {
    assert.deepEqual(endpointClassRoute(req(p), { UM_OAUTH_ENABLED: 'false' }), { returnStatus: 404 });
    assert.deepEqual(endpointClassRoute(req(p), {}), { returnStatus: 404 }); // unset = off
  });
}
test('OAuth routes bypass the SHARED limiter when enabled — they get their own (spec 6 item 1: independent of /mcp)', () => {
  // bypassRateLimit:true here means "skip the shared /mcp limiter"; the
  // dedicated oauthAdmit limiter is applied inside the dispatch (Task 1.3)
  // so a vendor connect storm cannot consume the /mcp budget or vice versa.
  for (const p of OAUTH_PATHS) {
    assert.deepEqual(endpointClassRoute(req(p), { UM_OAUTH_ENABLED: 'true' }),
      { bypassAuth: true, bypassRateLimit: true });
  }
});
test('/oauth/revoke is loopback-only (404 off-loopback) even when enabled', () => {
  assert.deepEqual(endpointClassRoute(req('/oauth/revoke'), { UM_OAUTH_ENABLED: 'true' }, '10.0.0.5'), { returnStatus: 404 });
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.deepEqual(endpointClassRoute(req('/oauth/revoke'), { UM_OAUTH_ENABLED: 'true' }, ip), { bypassAuth: true, bypassRateLimit: true });
  }
});
test('/oauth/revoke 404s when OAuth disabled even from loopback', () => {
  assert.deepEqual(endpointClassRoute(req('/oauth/revoke'), {}, '127.0.0.1'), { returnStatus: 404 });
});

test('/metrics with IPv4-mapped loopback ::ffff:127.0.0.1 bypasses auth', () => {
  // Dual-stack Node sockets can report the IPv4-mapped form; must be
  // treated as loopback alongside 127.0.0.1 and ::1.
  const r = endpointClassRoute(req('/metrics'), { UM_METRICS_LOOPBACK_ONLY: 'true' }, '::ffff:127.0.0.1');
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true);
});

// ---------------------------------------------------------------------------
// /oauth/idp/* rows — social-login (Gap-4 bridge): default-closed until a
// provider is fully configured (the social-login trio).
// ---------------------------------------------------------------------------

test('/oauth/idp/* is public when OAuth on AND a provider is configured', () => {
  const on = { UM_OAUTH_ENABLED: 'true', UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'c', UM_OAUTH_IDP_GITHUB_CLIENT_SECRET: 's', UM_OAUTH_OPERATOR_GITHUB: '1' };
  const r = endpointClassRoute(req('/oauth/idp/github/login'), on);
  assert.equal(r.bypassAuth, true);
  assert.equal(r.bypassRateLimit, true); // dedicated OAuth limiter covers it in dispatch (like sibling /oauth/* rows)
});

test('/oauth/idp/* hard-404s when OAuth is off (default-closed)', () => {
  const r = endpointClassRoute(req('/oauth/idp/github/login'), {});
  assert.equal(r.returnStatus, 404);
});

test('/oauth/idp/* hard-404s when OAuth on but NO provider configured', () => {
  const r = endpointClassRoute(req('/oauth/idp/github/callback'), { UM_OAUTH_ENABLED: 'true' });
  assert.equal(r.returnStatus, 404);
});

test('/oauth/idp/* hard-404s on a partial provider trio (not fully configured)', () => {
  const partial = { UM_OAUTH_ENABLED: 'true', UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'c' };
  assert.equal(endpointClassRoute(req('/oauth/idp/github/login'), partial).returnStatus, 404);
});

// ---------------------------------------------------------------------------
// /favicon.svg + /favicon.ico rows — static brand assets, unconditionally
// public (spec 2026-07-09 public-release-polish §4).
// ---------------------------------------------------------------------------

test('/favicon.svg and /favicon.ico bypass auth and rate-limit', () => {
  for (const p of ['/favicon.svg', '/favicon.ico']) {
    const r = endpointClassRoute(req(p));
    assert.deepEqual(r, { bypassAuth: true, bypassRateLimit: true });
  }
});

test('favicon rows are flag-independent (public even with OAuth off and auth configured)', () => {
  const env = { UM_OAUTH_ENABLED: 'false', UM_AUTH_TOKEN: 'sometoken' };
  const r = endpointClassRoute(req('/favicon.svg'), env);
  assert.deepEqual(r, { bypassAuth: true, bypassRateLimit: true });
});

test('/favicon.svg/x is NOT a favicon path (exact match guard)', () => {
  const r = endpointClassRoute(req('/favicon.svg/x'));
  assert.deepEqual(r, { bypassAuth: false, bypassRateLimit: false });
});
