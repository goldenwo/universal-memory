// server/test/oauth-scopes.test.mjs — scope negotiation + table pins (spec 3 Q3, 4.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negotiateScopes, scopeAllowsTool, insufficientScopeChallenge, RESOURCE_SCOPES } from '../lib/oauth/scopes.mjs';

test('offline_access + unknown scopes are down-scoped, never rejected', () => {
  const r = negotiateScopes('vault offline_access unknown_x');
  assert.deepEqual(r.granted, ['vault']);
  assert.equal(r.offlineAccess, true);
});
test('empty/undefined request defaults to the resource scopes, no offline_access', () => {
  for (const v of ['', undefined, null]) {
    const r = negotiateScopes(v);
    assert.deepEqual(r.granted, ['vault']);
    assert.equal(r.offlineAccess, false);
  }
});
test('bare offline_access still grants the default resource scopes', () => {
  const r = negotiateScopes('offline_access');
  assert.deepEqual(r.granted, ['vault']);
  assert.equal(r.offlineAccess, true);
});
test('vault is the full-access superset (wildcard tool grant)', () => {
  for (const toolClass of ['read', 'write', 'anything-future']) {
    assert.equal(scopeAllowsTool(['vault'], toolClass), true);
  }
});
test('no scopes → no tools', () => {
  assert.equal(scopeAllowsTool([], 'read'), false);
  assert.equal(scopeAllowsTool(['unknown'], 'read'), false);
});
test('insufficient_scope challenge has the RFC 6750 shape (spec 6 item 6)', () => {
  assert.equal(insufficientScopeChallenge('vault'), 'Bearer error="insufficient_scope", scope="vault"');
});
test('RESOURCE_SCOPES is the advertised PRM scope list', () => {
  assert.deepEqual(RESOURCE_SCOPES, ['vault']);
});
