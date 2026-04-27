import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRequestContext, currentRequestId } from '../lib/request-context.mjs';

test('currentRequestId inside withRequestContext returns id', async () => {
  await withRequestContext({ id: 'abc' }, async () => {
    assert.equal(currentRequestId(), 'abc');
  });
});

test('currentRequestId outside returns null', () => {
  assert.equal(currentRequestId(), null);
});

test('concurrent withRequestContext does not leak', async () => {
  const a = withRequestContext({ id: 'a' }, async () => {
    await new Promise((r) => setTimeout(r, 20));
    return currentRequestId();
  });
  const b = withRequestContext({ id: 'b' }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    return currentRequestId();
  });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, 'a');
  assert.equal(rb, 'b');
});

test('request_id propagates through NESTED async ops (mem0 path simulation)', async () => {
  // §6.1 logging matrix: request_id must propagate through nested mem0 ops
  const ids = [];
  const innerHttpCall = async () => {
    await new Promise((r) => setTimeout(r, 5));
    ids.push(currentRequestId());
  };
  const memoryAdd = async () => {
    await new Promise((r) => setTimeout(r, 5));
    await innerHttpCall();
  };
  await withRequestContext({ id: 'req-outer' }, async () => {
    await memoryAdd();
  });
  assert.deepEqual(ids, ['req-outer']);
});

test('withRequestContext auto-generates id when omitted (uuid-ish)', async () => {
  await withRequestContext({}, async () => {
    const id = currentRequestId();
    assert.ok(id, 'auto-generated id should not be null');
    assert.match(id, /^[0-9a-f]{8}-/i, 'should look like uuid');
  });
});
