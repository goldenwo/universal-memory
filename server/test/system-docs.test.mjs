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

test('filterSystemDocs returns [] for empty array', () => {
  assert.deepEqual(filterSystemDocs([]), []);
});

test('filterSystemDocs returns [] for null', () => {
  assert.deepEqual(filterSystemDocs(null), []);
});

test('filterSystemDocs returns [] for undefined', () => {
  assert.deepEqual(filterSystemDocs(undefined), []);
});

test('filterSystemDocs returns [] when every item is a system doc', () => {
  const items = [
    { metadata: { id: '_um_embedding_stamp' } },
    { metadata: { id: '_um_embedding_stamp' } },
  ];
  assert.deepEqual(filterSystemDocs(items), []);
});

test('isSystemDoc returns false for null', () => {
  assert.equal(isSystemDoc(null), false);
});

test('isSystemDoc returns false for undefined', () => {
  assert.equal(isSystemDoc(undefined), false);
});

test('isSystemDoc returns false when metadata is null', () => {
  assert.equal(isSystemDoc({ metadata: null }), false);
});
