/**
 * server/test/provider-matrix.test.mjs — exercises pairing combinations
 * + unknown-provider clean-error path. Complements provider-mock-sdk.test.mjs
 * (which locks per-method invocation shape) by exercising the full
 * embed-surface × summarizer-surface matrix and the unused-provider clean-error
 * path.
 *
 * All SDK calls short-circuit via UM_TEST_MOCK_SDK=1 — no network,
 * no live SDK loaded, no creds required.
 *
 * Cite: docs/plans/2026-05-07-w6.2-image-size-spec.md §Test strategy and
 * §Implementation plan Phase 1.5.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as anthropic from '../lib/provider/anthropic.mjs';
import * as google from '../lib/provider/google.mjs';
import * as ollama from '../lib/provider/ollama.mjs';
import * as openai from '../lib/provider/openai.mjs';
import { getProvider, supportingProviders } from '../lib/provider/registry.mjs';
import { validateProviderSupport } from '../lib/startup-validation.mjs';

const explosiveFetch = async () => { throw new Error('SDK called despite UM_TEST_MOCK_SDK=1'); };
const explosiveClient = new Proxy({}, { get() { throw new Error('SDK called despite UM_TEST_MOCK_SDK=1'); } });

const PROVIDERS = { openai, anthropic, google, ollama };

// Embed-capable providers — anthropic intentionally excluded (supports.embeddings === false).
// Source of truth: lib/provider/registry.mjs supportingProviders('embeddings').
const EMBED_PROVIDERS = ['openai', 'google', 'ollama'];
const SUMMARIZER_PROVIDERS = ['openai', 'anthropic', 'google', 'ollama'];

// Prevent registry-flag drift from silently shrinking the matrix without a test signal.
test('matrix preflight: registry supportingProviders matches expected sets', () => {
  assert.deepEqual(supportingProviders('embeddings').sort(), [...EMBED_PROVIDERS].sort());
  assert.deepEqual(supportingProviders('summarizer').sort(), [...SUMMARIZER_PROVIDERS].sort());
});

async function callEmbed(provider, env) {
  const fn = PROVIDERS[provider].embed;
  if (provider === 'ollama') {
    const prev = process.env.UM_TEST_MOCK_SDK;
    process.env.UM_TEST_MOCK_SDK = '1';
    try { return await fn('hello', { fetch: explosiveFetch, host: 'http://localhost:11434', model: 'nomic-embed-text' }); }
    finally { if (prev === undefined) delete process.env.UM_TEST_MOCK_SDK; else process.env.UM_TEST_MOCK_SDK = prev; }
  }
  return await fn('hello', { env, client: explosiveClient });
}

async function callSummarizer(provider, env) {
  const fn = PROVIDERS[provider].summarizerInvoke;
  if (provider === 'ollama') {
    const prev = process.env.UM_TEST_MOCK_SDK;
    process.env.UM_TEST_MOCK_SDK = '1';
    try { return await fn('hello', { fetch: explosiveFetch, host: 'http://localhost:11434', model: 'llama3' }); }
    finally { if (prev === undefined) delete process.env.UM_TEST_MOCK_SDK; else process.env.UM_TEST_MOCK_SDK = prev; }
  }
  return await fn('hello', { env, client: explosiveClient });
}

// 3 embed × 4 summarizer = 12 pairings. Each pair runs both surfaces independently
// with mocked SDK calls — verifies the surfaces don't interfere via shared imports
// (a class of regression option-A stubs would catch loudly but the patch makes
// fail-soft, so the matrix asserts the fail-quiet invariant per pair).
for (const embedProvider of EMBED_PROVIDERS) {
  for (const summarizerProvider of SUMMARIZER_PROVIDERS) {
    test(`pair: embed=${embedProvider} + summarizer=${summarizerProvider} — both invoke under UM_TEST_MOCK_SDK=1`, async () => {
      const env = { UM_TEST_MOCK_SDK: '1' };
      const embedResult = await callEmbed(embedProvider, env);
      assert.equal(typeof embedResult.vector, 'object', 'embed.vector must be array');
      assert(Array.isArray(embedResult.vector), 'embed.vector must be array');
      assert(embedResult.vector.length > 0, 'embed.vector must be non-empty');

      const summarizerResult = await callSummarizer(summarizerProvider, env);
      assert.equal(typeof summarizerResult.content, 'string');
      assert(summarizerResult.content.startsWith('[MOCK]'));
    });
  }
}

// Unused-provider clean-error path — the boot-validation tier rejects names
// not in the registry. mem0's patched dynamic-import never gets a chance to fire
// because validateProviderSupport throws first. This is the cleanest failure
// mode: operator gets a registry-anchored error pointing at valid alternatives.
test('unused provider mistral: validateProviderSupport throws clean message', () => {
  const env = { UM_EMBEDDING_PROVIDER: 'mistral' };
  assert.throws(() => validateProviderSupport(env), /unknown provider: mistral/);
});

test('unused provider azure: validateProviderSupport throws clean message', () => {
  const env = { UM_EMBEDDING_PROVIDER: 'azure' };
  assert.throws(() => validateProviderSupport(env), /unknown provider: azure/);
});

test('unused provider supabase: validateProviderSupport throws clean message', () => {
  const env = { UM_SUMMARIZER_PROVIDER: 'supabase' };
  assert.throws(() => validateProviderSupport(env), /unknown provider: supabase/);
});

// Capability mismatch — anthropic configured as embedder is rejected at boot
// before any SDK / mem0 module is invoked. Same clean-error tier as the
// unknown-provider case; covers the supports.embeddings === false branch.
test('capability mismatch: anthropic-as-embedder is rejected at boot', () => {
  const env = { UM_EMBEDDING_PROVIDER: 'anthropic' };
  assert.throws(() => validateProviderSupport(env), /anthropic does not support embeddings/);
});

// Registry sanity — getProvider directly returns the expected module shapes.
for (const name of Object.keys(PROVIDERS)) {
  test(`registry: getProvider('${name}') returns module with supports flag`, () => {
    const p = getProvider(name);
    assert.equal(typeof p.supports, 'object');
    assert.equal(typeof p.supports.summarizer, 'boolean');
  });
}
