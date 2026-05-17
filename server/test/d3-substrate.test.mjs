import test from 'node:test';
import assert from 'node:assert/strict';
import { RESERVED_METADATA_FIELDS, assertNoReservedFields } from '../lib/dedup-constants.mjs';

test('D3.1 status/supersededBy/supersededAt are reserved', () => {
  for (const f of ['status', 'supersededBy', 'supersededAt']) {
    assert.ok(RESERVED_METADATA_FIELDS.includes(f), `${f} reserved`);
    assert.throws(() => assertNoReservedFields({ [f]: 'x' }), /reserved/i);
  }
});
