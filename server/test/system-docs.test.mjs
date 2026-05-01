import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_METADATA_IDS,
  isSystemDoc,
  filterSystemDocs,
  filterSystemDocsByTopLevelId,
} from '../lib/system-docs.mjs';

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

// ---------------------------------------------------------------------------
// filterSystemDocsByTopLevelId — used by read paths whose records expose `id`
// at the top level (e.g. doRecent's projected `{ id, title, snippet }` shape).
// ---------------------------------------------------------------------------

test('filterSystemDocsByTopLevelId returns [] for empty array', () => {
  assert.deepEqual(filterSystemDocsByTopLevelId([]), []);
});

test('filterSystemDocsByTopLevelId returns [] when every item is a system doc', () => {
  const items = [
    { id: '_um_embedding_stamp', title: 'Stamp 1' },
    { id: '_um_embedding_stamp', title: 'Stamp 2' },
  ];
  assert.deepEqual(filterSystemDocsByTopLevelId(items), []);
});

test('filterSystemDocsByTopLevelId strips system docs from a mixed list', () => {
  const items = [
    { id: 'real-a', title: 'A' },
    { id: '_um_embedding_stamp', title: 'Stamp' },
    { id: 'real-b', title: 'B' },
  ];
  const out = filterSystemDocsByTopLevelId(items);
  assert.deepEqual(out.map((i) => i.id), ['real-a', 'real-b']);
});

test('filterSystemDocsByTopLevelId returns [] for non-array input', () => {
  assert.deepEqual(filterSystemDocsByTopLevelId('not-an-array'), []);
  assert.deepEqual(filterSystemDocsByTopLevelId(42), []);
  assert.deepEqual(filterSystemDocsByTopLevelId({}), []);
});

test('filterSystemDocsByTopLevelId returns [] for null', () => {
  assert.deepEqual(filterSystemDocsByTopLevelId(null), []);
});

test('filterSystemDocsByTopLevelId returns [] for undefined', () => {
  assert.deepEqual(filterSystemDocsByTopLevelId(undefined), []);
});

test('filterSystemDocsByTopLevelId keeps items with id: null (non-system)', () => {
  const items = [
    { id: null, title: 'Null id' },
    { id: '_um_embedding_stamp', title: 'Stamp' },
    { id: undefined, title: 'Undefined id' },
  ];
  const out = filterSystemDocsByTopLevelId(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Null id');
  assert.equal(out[1].title, 'Undefined id');
});
