/**
 * Wire-level guard for the Google provider: the REAL @google/genai SDK with fetch
 * stubbed, so nothing leaves the machine and no key is needed.
 *
 * Why this file exists: every other Google test injects a fake client, so the suite
 * cannot see what the SDK puts on the wire. @google/genai 3.0.0 moved the Gemini
 * Developer API default from v1beta to v1 and that suite stayed green (PR #426).
 * google.mjs keeps the calls on v1beta; these tests fail if a later SDK, or a change
 * here, moves them again. They also cover mem0's Google embedder, which builds its own
 * client and is the path every embedding takes when UM_EMBEDDING_PROVIDER=google.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const VERSION_ENV = 'GOOGLE_GENAI_API_VERSION';
const HOST = 'https://generativelanguage.googleapis.com';
const env = { GOOGLE_API_KEY: 'AIza-test-1234567890abcdef' };

// The pin is a default, so start from a shell that exported nothing.
delete process.env[VERSION_ENV];
const google = await import('../../lib/provider/google.mjs');

// Replaces fetch for one test; returns the Gemini URLs the SDK asked for.
function stubFetch(t) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    urls.push(url);
    const body = /embed/i.test(url)
      ? { embeddings: [{ values: [0.1, 0.2, 0.3] }] }
      : {
          candidates: [{ content: { role: 'model', parts: [{ text: '{"facts":[]}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return () => urls.filter((u) => u.startsWith(HOST));
}

const GENERATE_SURFACES = {
  summarizerInvoke: () => google.summarizerInvoke('prompt', { env, systemPrompt: 'system' }),
  contradictionJudgeInvoke: () => google.contradictionJudgeInvoke('prompt', { env, systemPrompt: 'system' }),
  factsInvoke: () => google.factsInvoke('text', { env }),
};

for (const [name, invoke] of Object.entries(GENERATE_SURFACES)) {
  test(`${name} sends generateContent to the v1beta endpoint`, async (t) => {
    const geminiUrls = stubFetch(t);
    await invoke();
    assert.deepEqual(geminiUrls(), [`${HOST}/v1beta/models/${google.defaults.summarizerModel}:generateContent`]);
  });
}

test('embed sends batchEmbedContents to the v1beta endpoint', async (t) => {
  const geminiUrls = stubFetch(t);
  const { vector } = await google.embed('text', { env });
  assert.equal(vector.length, 3);
  assert.deepEqual(geminiUrls(), [`${HOST}/v1beta/models/${google.defaults.embeddingModel}:batchEmbedContents`]);
});

test("mem0's Google embedder, built from embedderConfig, uses the v1beta endpoint too", async (t) => {
  const { Memory } = await import('mem0ai/oss');
  const geminiUrls = stubFetch(t);
  const mem = new Memory({ embedder: google.embedderConfig(env), llm: google.factsLlmConfig(env) });
  assert.equal(typeof mem.embedder?.embed, 'function', 'mem0 Memory no longer exposes embedder.embed — update this test');
  await mem.embedder.embed('text');
  assert.deepEqual(geminiUrls(), [`${HOST}/v1beta/models/${google.defaults.embeddingModel}:batchEmbedContents`]);
});

// Sets the env variable for one test and puts the previous state back afterwards
// (delete, not assign: assigning undefined would store the string "undefined").
function setVersionFor(t, value) {
  const before = process.env[VERSION_ENV];
  process.env[VERSION_ENV] = value;
  t.after(() => {
    if (before === undefined) delete process.env[VERSION_ENV];
    else process.env[VERSION_ENV] = before;
  });
}

test('loading the provider pins the API version when the operator set none', () => {
  assert.equal(process.env[VERSION_ENV], 'v1beta');
});

test('an API version the operator sets is used instead of the pin', async (t) => {
  const geminiUrls = stubFetch(t);
  setVersionFor(t, 'v1');
  await google.summarizerInvoke('prompt', { env });
  assert.deepEqual(geminiUrls(), [`${HOST}/v1/models/${google.defaults.summarizerModel}:generateContent`]);
});

test('loading the provider leaves an API version the operator exported alone', async (t) => {
  setVersionFor(t, 'v1');
  // The query string makes Node evaluate the module again instead of reusing the cached one.
  await import('../../lib/provider/google.mjs?operator-set-version');
  assert.equal(process.env[VERSION_ENV], 'v1');
});
