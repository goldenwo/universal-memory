// plugins/openclaw/reaction-producer/lib.test.mjs — pure-helper tests for the
// Discord reaction producer (#201 PR 2). Run: node --test plugins/openclaw/reaction-producer/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  snowflakeToIso,
  absoluteCount,
  reactionTypes,
  buildRunId,
  backoffDelaysMs,
} from './lib.mjs';

test('snowflakeToIso decodes the Discord epoch timestamp', () => {
  // 175928847299117063 is the documented example snowflake → 2016-04-30T11:18:25.796Z
  assert.equal(snowflakeToIso('175928847299117063'), '2016-04-30T11:18:25.796Z');
});

test('absoluteCount sums reaction counts and excludes the bot own reactions via the me flag', () => {
  const message = {
    reactions: [
      { emoji: { name: '👍' }, count: 3, me: true },   // one of the 3 is the bot
      { emoji: { name: '🔥' }, count: 2, me: false },
    ],
  };
  assert.equal(absoluteCount(message), 4);
});

test('absoluteCount of a message with no reactions (or removed-all) is 0', () => {
  assert.equal(absoluteCount({}), 0);
  assert.equal(absoluteCount({ reactions: [] }), 0);
});

test('reactionTypes lists emoji names, custom emoji by name, deduped, in order', () => {
  const message = {
    reactions: [
      { emoji: { name: '👍' }, count: 1, me: false },
      { emoji: { name: 'blobcat', id: '123' }, count: 1, me: false },
      { emoji: { name: '👍' }, count: 1, me: false },
    ],
  };
  assert.deepEqual(reactionTypes(message), ['👍', 'blobcat']);
});

test('buildRunId matches the OpenClaw sessionKey shape captures carry', () => {
  assert.equal(
    buildRunId('agent:main:discord:channel:{channelId}', '1485162110563647599'),
    'agent:main:discord:channel:1485162110563647599',
  );
});

test('backoff schedule is capped at ~10 minutes total per the producer contract', () => {
  const delays = backoffDelaysMs();
  assert.ok(delays.length >= 4);
  const total = delays.reduce((a, d) => a + d, 0);
  assert.ok(total <= 10.5 * 60_000, `total ${total}ms exceeds the ~10min cap`);
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1]);
});
