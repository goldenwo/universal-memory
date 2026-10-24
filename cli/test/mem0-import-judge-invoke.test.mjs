import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJudgeInvoke } from '../mem0-import.mjs';
import { defaults } from '../../server/lib/provider/openai.mjs';

// The import judge builds its own OpenAI client, outside the provider modules, so it
// gets its own pins for the 2026-10-23 model migration (spec R1): it falls back to the
// provider's facts default, and it sends each model only the params it accepts.

function capturingClient() {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (args) => {
      calls.push(args);
      return { choices: [{ message: { content: '{"decisions": []}' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
    } } },
  };
}

const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }];

test('makeJudgeInvoke falls back to the openai provider\'s facts default', async () => {
  const client = capturingClient();
  await makeJudgeInvoke({ OPENAI_API_KEY: 'sk-x' }, { client })('sys', 'user');
  assert.equal(client.calls[0].model, defaults.factsModel);
});

test('makeJudgeInvoke keeps temperature 0 and JSON mode on a legacy model', async () => {
  const client = capturingClient();
  const out = await makeJudgeInvoke({ OPENAI_API_KEY: 'sk-x', UM_IMPORT_JUDGE_MODEL: 'gpt-4o-mini' }, { client })('sys', 'user');
  assert.deepEqual(client.calls[0], {
    model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages,
  });
  assert.deepEqual(out, { content: '{"decisions": []}', usage: { tokensIn: 2, tokensOut: 1 } });
});

test('makeJudgeInvoke on a luna model drops temperature and sends reasoning_effort none', async () => {
  const client = capturingClient();
  await makeJudgeInvoke({ OPENAI_API_KEY: 'sk-x', UM_IMPORT_JUDGE_MODEL: 'gpt-6-luna' }, { client })('sys', 'user');
  assert.deepEqual(client.calls[0], {
    model: 'gpt-6-luna', reasoning_effort: 'none', response_format: { type: 'json_object' }, messages,
  });
});
