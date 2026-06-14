// server/test/oauth-idp-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredProviders, buildRegistry } from '../lib/oauth/idp/registry.mjs';

const full = {
  UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'cid',
  UM_OAUTH_IDP_GITHUB_CLIENT_SECRET: 'sec',
  UM_OAUTH_OPERATOR_GITHUB: '5550123',
};

test('configuredProviders lists github only when the full trio is present', () => {
  assert.deepEqual(configuredProviders(full), ['github']);
  assert.deepEqual(configuredProviders({}), []);
  // partial trio is NOT "configured" (boot-validation rejects it; registry just excludes it)
  assert.deepEqual(configuredProviders({ UM_OAUTH_IDP_GITHUB_CLIENT_ID: 'cid' }), []);
});

test('buildRegistry exposes get()/list() for configured providers only', () => {
  const reg = buildRegistry(full);
  assert.deepEqual(reg.list().map((a) => a.id), ['github']);
  assert.equal(reg.get('github').id, 'github');
  assert.equal(reg.get('gitlab'), undefined); // unknown → undefined (dispatch 404s)
});

test('buildRegistry is empty when unconfigured', () => {
  assert.deepEqual(buildRegistry({}).list(), []);
});
