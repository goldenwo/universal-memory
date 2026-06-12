// server/test/oauth-metadata.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectedResourceMetadata, authorizationServerMetadata } from '../lib/oauth/metadata.mjs';

const BASE = 'https://um.example.ts.net';

test('PRM doc has the RFC 9728 MUST fields', () => {
  const prm = protectedResourceMetadata(BASE);
  assert.equal(prm.resource, `${BASE}/mcp`);
  assert.deepEqual(prm.authorization_servers, [BASE]);
  assert.deepEqual(prm.scopes_supported, ['vault']); // PRM = resource scopes only (spec §4.1)
});

test('AS metadata advertises everything both vendors gate on', () => {
  const as = authorizationServerMetadata(BASE);
  assert.equal(as.issuer, BASE);
  assert.equal(as.authorization_endpoint, `${BASE}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${BASE}/oauth/token`);
  assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);   // Claude refuses without
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']); // CIMD gate 1/2
  assert.equal(as.client_id_metadata_document_supported, true);         // CIMD gate 2/2
  assert.deepEqual(as.scopes_supported, ['vault', 'offline_access']);   // spec §4.2 negotiation
  assert.deepEqual(as.response_types_supported, ['code']);
});

test('no trailing slash leaks into constructed URLs', () => {
  const as = authorizationServerMetadata(`${BASE}/`);
  assert.equal(as.issuer, BASE);
  assert.equal(as.token_endpoint, `${BASE}/oauth/token`);
});
