// server/test/oauth-redirects.test.mjs — registration allowlist + authorize-time matching pins (spec 4.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedRegistrationRedirect, isLoopbackRedirect, redirectMatches } from '../lib/oauth/redirects.mjs';

test('Claude exact callback allowed', () => {
  assert.equal(isAllowedRegistrationRedirect('https://claude.ai/api/mcp/auth_callback'), true);
});
test('ChatGPT per-connector URI allowed (literal stored, prefix is registration rule only)', () => {
  assert.equal(isAllowedRegistrationRedirect('https://chatgpt.com/connector/oauth/abc123'), true);
});
test('ChatGPT legacy exact callback allowed', () => {
  assert.equal(isAllowedRegistrationRedirect('https://chatgpt.com/connector_platform_oauth_redirect'), true);
});
test('off-allowlist and lookalike hosts rejected', () => {
  for (const uri of [
    'https://evil.com/cb',
    'https://chatgpt.com.evil.com/connector/oauth/x',
    'https://claude.ai.evil.com/api/mcp/auth_callback',
    'https://chatgpt.com/other/path',
    'https://claude.ai/api/mcp/auth_callback2',
    'not a url',
  ]) {
    assert.equal(isAllowedRegistrationRedirect(uri), false, uri);
  }
});
test('bare ChatGPT connector prefix (no id) rejected', () => {
  assert.equal(isAllowedRegistrationRedirect('https://chatgpt.com/connector/oauth/'), false);
});
test('loopback http URIs allowed for registration (RFC 8252, Claude Code)', () => {
  assert.equal(isAllowedRegistrationRedirect('http://localhost:3118/callback'), true);
  assert.equal(isAllowedRegistrationRedirect('http://127.0.0.1:9999/cb'), true);
});
test('https localhost is NOT loopback-special (must be http)', () => {
  assert.equal(isLoopbackRedirect('https://localhost/cb'), false);
  assert.equal(isAllowedRegistrationRedirect('https://localhost/cb'), false);
});
test('authorize-time: non-loopback requires exact string equality', () => {
  const stored = 'https://chatgpt.com/connector/oauth/abc123';
  assert.equal(redirectMatches(stored, stored), true);
  assert.equal(redirectMatches(stored, 'https://chatgpt.com/connector/oauth/abc124'), false);
  assert.equal(redirectMatches(stored, 'https://chatgpt.com/connector/oauth/ABC123'), false);
});
test('authorize-time: loopback matches port-agnostic (Claude Code ephemeral port)', () => {
  assert.equal(redirectMatches('http://localhost:3118/callback', 'http://localhost:60123/callback'), true);
  assert.equal(redirectMatches('http://127.0.0.1:1/cb', 'http://127.0.0.1:65000/cb'), true);
});
test('authorize-time: localhost and 127.0.0.1 are equivalent loopback hosts', () => {
  assert.equal(redirectMatches('http://localhost:3118/callback', 'http://127.0.0.1:60123/callback'), true);
});
test('authorize-time: loopback still requires same path and query', () => {
  assert.equal(redirectMatches('http://localhost:1/callback', 'http://localhost:2/other'), false);
  assert.equal(redirectMatches('http://localhost:1/cb?x=1', 'http://localhost:2/cb?x=2'), false);
});
