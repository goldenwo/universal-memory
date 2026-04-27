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
