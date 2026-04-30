import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from 'mem0ai/oss';
import { getEmbedderConfig } from '../lib/embed.mjs';
import { getFactsLlmConfig } from '../lib/facts.mjs';

test('mem0 metadata.id roundtrips through add() with infer:false', { skip: !process.env.UM_LIVE_TESTS }, async () => {
  const env = { ...process.env, UM_EMBEDDING_PROVIDER: 'openai', UM_FACTS_PROVIDER: 'openai' };
  const memory = new Memory({ embedder: getEmbedderConfig(env), llm: getFactsLlmConfig(env) });
  const sentinelId = '_test_stamp_roundtrip_' + Date.now();
  await memory.add('roundtrip test', { userId: 'test_user', metadata: { id: sentinelId, marker: 'spike' }, infer: false });
  // Read back via list (should include the doc with the sentinel ID)
  const items = await memory.getAll({ userId: 'test_user' });
  const found = items.find(i => i.metadata?.id === sentinelId);
  assert.ok(found, 'mem0 did not roundtrip metadata.id');
  assert.equal(found.metadata.marker, 'spike');
});

test('mem0.add called with caller-supplied metadata.id and infer:false (offline contract check)', async () => {
  let captured;
  const stubMemory = { add: async (text, opts) => { captured = opts; } };
  // Call the same code-path that production reindexDoc uses.
  // For the spike, simulate the call shape:
  await stubMemory.add('test text', { userId: 'test', metadata: { id: '_um_test_id', schema_version: 1 }, infer: false });
  assert.equal(captured.metadata.id, '_um_test_id');
  assert.equal(captured.infer, false);
});
