import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_METADATA_IDS, isSystemDoc, filterSystemDocs } from '../lib/system-docs.mjs';

test('SYSTEM_METADATA_IDS contains stamp id', () => {
  assert.ok(SYSTEM_METADATA_IDS.includes('_um_embedding_stamp'));
});

test('isSystemDoc identifies stamp by metadata.id', () => {
  assert.equal(isSystemDoc({ metadata: { id: '_um_embedding_stamp' } }), true);
  assert.equal(isSystemDoc({ metadata: { id: 'real-doc' } }), false);
  assert.equal(isSystemDoc({}), false);
});

test('filterSystemDocs strips stamp from a list', () => {
  const items = [
    { metadata: { id: 'a' } },
    { metadata: { id: '_um_embedding_stamp' } },
    { metadata: { id: 'b' } },
  ];
  const out = filterSystemDocs(items);
  assert.deepEqual(out.map(i => i.metadata.id), ['a', 'b']);
});
