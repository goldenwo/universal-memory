/**
 * server/test/provider/registry.test.mjs — integration tests for the provider registry.
 *
 * These tests are SKIP-GUARDED until A3-A6 land (openai/anthropic/google/ollama modules).
 * registry.mjs uses static top-level imports; loading it before those modules exist causes
 * a load-time "Cannot find module" failure that test-level { skip: ... } cannot intercept.
 * The fix: dynamic import inside `if (RUN)`, so the registry is never loaded unless the
 * integration env var is explicitly set. A7 removes the guard and makes these run always.
 *
 * To run: UM_REGISTRY_INTEGRATION=1 node --test server/test/provider/registry.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const SKIP_REASON = 'integration test: depends on A3-A6 provider modules; gated until A7 lands';
const RUN = !!process.env.UM_REGISTRY_INTEGRATION;

// Conditional dynamic import: only load registry.mjs when integration env is set.
// Without the gate, registry.mjs's static imports of openai/anthropic/google/ollama
// (modules that A3-A6 haven't shipped yet) would fail at file-load time, regardless
// of test-level skip flags. Dynamic import inside `if (RUN)` defers the load until
// after we confirm the env opts in.
let providers, supportingProviders, getProvider;
if (RUN) {
  ({ providers, supportingProviders, getProvider } = await import('../../lib/provider/registry.mjs'));
}

test('providers is a non-empty object map keyed by provider name', { skip: !RUN && SKIP_REASON }, () => {
  assert.equal(typeof providers, 'object');
  assert.ok(Object.keys(providers).length > 0, 'registry should not be empty');
});

test('supportingProviders(surface) returns providers whose supports[surface]===true', { skip: !RUN && SKIP_REASON }, () => {
  const embedSupports = supportingProviders('embeddings');
  assert.ok(embedSupports.includes('openai'));
  assert.ok(!embedSupports.includes('anthropic'), 'anthropic does not support embeddings');
});

test('getProvider(name) returns the module, throws on unknown', { skip: !RUN && SKIP_REASON }, () => {
  assert.equal(getProvider('openai').providerName, 'openai');
  assert.throws(() => getProvider('bogus'), /unknown provider/);
});
