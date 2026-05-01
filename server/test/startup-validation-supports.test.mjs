import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderSupport } from '../lib/startup-validation.mjs';

test('refuses anthropic-as-embedder with valid-provider list', () => {
  assert.throws(
    () => validateProviderSupport({ UM_EMBEDDING_PROVIDER: 'anthropic' }),
    /anthropic does not support embeddings.*valid:.*openai.*google.*ollama/i,
  );
});

test('passes when all surfaces map to supporting providers', () => {
  assert.doesNotThrow(() => validateProviderSupport({
    UM_EMBEDDING_PROVIDER: 'openai', UM_SUMMARIZER_PROVIDER: 'anthropic', UM_FACTS_PROVIDER: 'google',
  }));
});

test('refuses unknown provider with helpful message', () => {
  assert.throws(
    () => validateProviderSupport({ UM_EMBEDDING_PROVIDER: 'cohere' }),
    /unknown provider.*cohere/i,
  );
});

test('refuses each surface independently', () => {
  // anthropic supports facts, so this only fails for embeddings, not for facts.
  assert.throws(() => validateProviderSupport({ UM_EMBEDDING_PROVIDER: 'anthropic' }), /embeddings/i);
  assert.doesNotThrow(() => validateProviderSupport({ UM_FACTS_PROVIDER: 'anthropic' }));
});
