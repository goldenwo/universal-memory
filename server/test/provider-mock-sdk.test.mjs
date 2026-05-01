/**
 * server/test/provider-mock-sdk.test.mjs — locks the UM_TEST_MOCK_SDK
 * contract for every SDK-calling provider method (Task G2.5, spec §9.4).
 *
 * The smoke-gate boots the server with UM_TEST_MOCK_SDK=1 against each
 * non-default provider so we can exercise registry wiring + container
 * startup without real API calls / a live Ollama daemon. These tests
 * ensure each provider's invoke method short-circuits to a well-shaped
 * canned response when the env var is truthy, and does NOT hit the real
 * SDK path (which would require live network + valid creds).
 *
 * Negative test (UM_TEST_MOCK_SDK unset) is implicit: every existing
 * provider/<name>.test.mjs already exercises the real-fetch / SDK code
 * path with fakes — they would fail-fast if the short-circuit fired
 * unintentionally.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as anthropic from '../lib/provider/anthropic.mjs';
import * as google from '../lib/provider/google.mjs';
import * as ollama from '../lib/provider/ollama.mjs';
import * as openai from '../lib/provider/openai.mjs';

const SHAPE = (r) => {
  assert.equal(typeof r.content, 'string', 'content must be string');
  assert(r.content.startsWith('[MOCK]'), 'content must be marked as mock');
  assert.equal(typeof r.usage, 'object', 'usage must be object');
  assert.equal(typeof r.usage.tokensIn, 'number', 'usage.tokensIn must be number');
  assert.equal(typeof r.usage.tokensOut, 'number', 'usage.tokensOut must be number');
};

// A throwing fetch / client guarantees the test fails loudly if the
// short-circuit ever regresses — proves the mock path runs *before*
// any real SDK / network call.
const explosiveFetch = async () => { throw new Error('SDK called despite UM_TEST_MOCK_SDK=1'); };
const explosiveClient = new Proxy({}, { get() { throw new Error('SDK called despite UM_TEST_MOCK_SDK=1'); } });

test('anthropic.summarizerInvoke short-circuits when UM_TEST_MOCK_SDK=1', async () => {
  const result = await anthropic.summarizerInvoke('hello', {
    env: { UM_TEST_MOCK_SDK: '1' },
    client: explosiveClient,
  });
  SHAPE(result);
});

test('google.summarizerInvoke short-circuits when UM_TEST_MOCK_SDK=1', async () => {
  const result = await google.summarizerInvoke('hello', {
    env: { UM_TEST_MOCK_SDK: '1' },
    client: explosiveClient,
  });
  SHAPE(result);
});

test('openai.summarizerInvoke short-circuits when UM_TEST_MOCK_SDK=1', async () => {
  const result = await openai.summarizerInvoke('hello', {
    env: { UM_TEST_MOCK_SDK: '1' },
    client: explosiveClient,
  });
  SHAPE(result);
});

test('ollama.summarizerInvoke short-circuits when process.env.UM_TEST_MOCK_SDK=1', async () => {
  const prev = process.env.UM_TEST_MOCK_SDK;
  process.env.UM_TEST_MOCK_SDK = '1';
  try {
    const result = await ollama.summarizerInvoke('hello', {
      fetch: explosiveFetch,
      host: 'http://localhost:11434',
      model: 'llama3',
    });
    SHAPE(result);
  } finally {
    if (prev === undefined) delete process.env.UM_TEST_MOCK_SDK;
    else process.env.UM_TEST_MOCK_SDK = prev;
  }
});

test('ollama.probeModel short-circuits to true when process.env.UM_TEST_MOCK_SDK=1', async () => {
  const prev = process.env.UM_TEST_MOCK_SDK;
  process.env.UM_TEST_MOCK_SDK = '1';
  try {
    // explosiveFetch would throw if not short-circuited — proves the mock
    // path runs before any real /api/tags call.
    const found = await ollama.probeModel('http://localhost:11434', 'llama3', {
      fetch: explosiveFetch,
    });
    assert.equal(found, true, 'probeModel must return true under UM_TEST_MOCK_SDK');
  } finally {
    if (prev === undefined) delete process.env.UM_TEST_MOCK_SDK;
    else process.env.UM_TEST_MOCK_SDK = prev;
  }
});
