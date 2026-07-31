// server/test/collection-init.test.mjs — payload-index boot contract.
//
// #201 added `hash` alongside lane/persona: the attach path's reindex
// re-resolution filters on (userId, hash), and the Layer-1 hash-dedup query
// benefits from the same index. This pins the indexed-field set so a future
// edit can't silently drop one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ensurePayloadIndexes } from '../lib/collection-init.mjs';

test('ensurePayloadIndexes creates keyword indexes for lane, persona, and hash', async () => {
  const calls = [];
  const client = {
    createPayloadIndex: async (collection, body) => { calls.push({ collection, body }); },
  };
  await ensurePayloadIndexes(client, 'memories');
  assert.deepEqual(
    calls.map((c) => c.body.field_name).sort(),
    ['hash', 'lane', 'persona'],
  );
  assert.ok(calls.every((c) => c.body.field_schema === 'keyword' && c.collection === 'memories'));
});

test('a 409 (already exists) on one field does not stop the others', async () => {
  const calls = [];
  const client = {
    createPayloadIndex: async (collection, body) => {
      calls.push(body.field_name);
      if (body.field_name === 'lane') { const e = new Error('exists'); e.status = 409; throw e; }
    },
  };
  await ensurePayloadIndexes(client, 'memories');
  assert.deepEqual(calls.sort(), ['hash', 'lane', 'persona']);
});
