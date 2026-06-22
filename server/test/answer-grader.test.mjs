// server/test/answer-grader.test.mjs — unit tests for the answer-correctness grader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerGradeInvoke, ANSWER_GRADER_MAX_TOKENS } from '../lib/provider/openai.mjs';

test('answerGradeInvoke: UM_TEST_MOCK_SDK short-circuit returns answer-shaped JSON', async () => {
  const out = await answerGradeInvoke('Q\n\nMEMORY:\n"""x"""', { env: { UM_TEST_MOCK_SDK: '1' }, systemPrompt: 'sys' });
  const parsed = JSON.parse(out.content);
  assert.equal(typeof parsed.answers, 'boolean');
  assert.equal(typeof parsed.confidence, 'number');
  assert.ok('reasoning' in parsed);
  assert.deepEqual(out.usage, { tokensIn: 10, tokensOut: 5 });
});

test('answerGradeInvoke: passes model, temperature 0, and ANSWER_GRADER_MAX_TOKENS to the client', async () => {
  let seen = null;
  const fakeClient = {
    chat: {
      completions: {
        create: async (args) => {
          seen = args;
          return { choices: [{ message: { content: '{"answers":true,"confidence":0.9,"reasoning":"ok"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    },
  };
  await answerGradeInvoke('prompt', { client: fakeClient, model: 'gpt-4o-mini', systemPrompt: 'sys', env: {} });
  assert.equal(seen.model, 'gpt-4o-mini');
  assert.equal(seen.temperature, 0);
  assert.equal(seen.max_tokens, ANSWER_GRADER_MAX_TOKENS);
  assert.equal(ANSWER_GRADER_MAX_TOKENS, 256); // drift-assert: one home, pinned value
  assert.equal(seen.messages[0].role, 'system');
  assert.equal(seen.messages[1].role, 'user');
});
