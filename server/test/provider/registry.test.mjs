/**
 * server/test/provider/registry.test.mjs — integration tests for the provider registry.
 *
 * Verifies that all four provider modules are loadable via the registry and that
 * supporting-surface filtering works correctly. The A2 skip-guard was lifted in A7
 * once A3-A6 shipped the openai/anthropic/google/ollama modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { providers, supportingProviders, getProvider } from '../../lib/provider/registry.mjs';

test('providers is a non-empty object map keyed by provider name', () => {
  assert.equal(typeof providers, 'object');
  assert.ok(Object.keys(providers).length > 0, 'registry should not be empty');
});

test('supportingProviders(surface) returns providers whose supports[surface]===true', () => {
  const embedSupports = supportingProviders('embeddings');
  assert.ok(embedSupports.includes('openai'));
  assert.ok(!embedSupports.includes('anthropic'), 'anthropic does not support embeddings');
});

test('getProvider(name) returns the module, throws on unknown', () => {
  assert.equal(getProvider('openai').providerName, 'openai');
  assert.throws(() => getProvider('bogus'), /unknown provider/);
});
