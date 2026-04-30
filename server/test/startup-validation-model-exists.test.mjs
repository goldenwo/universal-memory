import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelExists } from '../lib/startup-validation.mjs';

test('refuses model not in PRICING for active provider with helpful guidance', () => {
  assert.throws(
    () => validateModelExists({ UM_EMBEDDING_PROVIDER: 'google', UM_EMBEDDING_MODEL: 'text-embedding-3-small' }),
    (err) => {
      assert.match(err.message, /text-embedding-3-small/);
      assert.match(err.message, /not in PRICING/i);
      assert.match(err.message, /google/i);
      assert.match(err.message, /update.*pricing\.mjs|set UM_EMBEDDING_MODEL to one of/i);
      return true;
    },
  );
});

test('passes for known model + provider combo', () => {
  assert.doesNotThrow(() => validateModelExists({ UM_EMBEDDING_PROVIDER: 'openai', UM_EMBEDDING_MODEL: 'text-embedding-3-small' }));
});

test('skips model-existence check for Ollama (any model name allowed; user-managed local pulls)', () => {
  assert.doesNotThrow(() => validateModelExists({ UM_EMBEDDING_PROVIDER: 'ollama', UM_EMBEDDING_MODEL: 'custom-model' }));
});

test('checks all three surfaces independently', () => {
  assert.throws(() => validateModelExists({
    UM_EMBEDDING_PROVIDER: 'openai', UM_EMBEDDING_MODEL: 'text-embedding-3-small',  // ok
    UM_SUMMARIZER_PROVIDER: 'anthropic', UM_SUMMARIZER_MODEL: 'gpt-4o-mini',         // BAD: anthropic doesn't have gpt-4o-mini
  }), /summarizer.*gpt-4o-mini.*not in PRICING.*anthropic/i);
});
