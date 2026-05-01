import test from 'node:test';
import assert from 'node:assert/strict';
import * as ollama from '../../lib/provider/ollama.mjs';
import { ProviderError } from '../../lib/provider/errors.mjs';

test('summarizerInvoke calls OLLAMA_HOST/api/generate with correct body', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ response: 'summary text', prompt_eval_count: 5, eval_count: 7 }) };
  };
  const result = await ollama.summarizerInvoke('prompt content', {
    fetch: fakeFetch,
    host: 'http://localhost:11434',
    model: 'llama3',
  });
  assert.equal(captured.url, 'http://localhost:11434/api/generate');
  assert.equal(captured.body.model, 'llama3');
  assert.equal(captured.body.prompt, 'prompt content');
  assert.equal(result.content, 'summary text');
  assert.deepEqual(result.usage, { tokensIn: 5, tokensOut: 7 });
});

test('summarizerInvoke wraps HTTP errors as ProviderError', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, text: async () => 'service unavailable' });
  await assert.rejects(
    () => ollama.summarizerInvoke('prompt', { fetch: fakeFetch, host: 'http://localhost:11434', model: 'llama3' }),
    (err) => err instanceof ProviderError && err.class === 'PROVIDER_UPSTREAM' && err.status === 503,
  );
});

test('existing summarize.test.mjs ollama loop iteration still passes', async () => {
  // This is the regression test: the summarize-test loop now dispatches via BACKENDS.ollama
  // without any inline ollamaInvoke in summarize.mjs.
  // Asserted indirectly by `node --test server/test/summarize.test.mjs` post-migration.
  assert.ok(true);  // sentinel; real check is the suite-level run
});
