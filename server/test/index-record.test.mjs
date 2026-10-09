// server/test/index-record.test.mjs — #362: the one rule for what a vault doc is indexed as.
//
// reindexDoc, POST /api/reindex and the model-migration CLI all build the record a vault doc
// becomes from this function, so the three can't drift on what is admitted, what text is
// embedded or what metadata is stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { indexRecord } from '../lib/index-record.mjs';

const doc = (fm, body) => parseFrontmatter(`---\n${fm}\n---\n${body}`);

test('indexRecord admits a doc with type, id and title: title + body text, schema_version 1 metadata', () => {
  const rec = indexRecord(doc('type: session_summary\nid: s1\ntitle: Session one\nproject: p', '\nWhat happened.\n\n'));
  assert.deepEqual(rec, {
    ok: true,
    id: 's1',
    text: 'Session one\n\nWhat happened.',
    metadata: { schema_version: 1, type: 'session_summary', id: 's1', title: 'Session one', project: 'p' },
  });
});

test('indexRecord keeps a doc\'s own schema_version over the default', () => {
  const rec = indexRecord(doc('schema_version: 2\ntype: adr\nid: a1\ntitle: T', 'b'));
  assert.equal(rec.metadata.schema_version, 2);
});

test('indexRecord refuses a raw capture: no frontmatter, every required field missing', () => {
  const rec = indexRecord(parseFrontmatter('## 2026-10-09T00:00:00.000Z user\n\nhello\n\n'));
  assert.deepEqual(rec, { ok: false, reason: 'missing_fields', missing: ['type', 'id', 'title'] });
});

test('indexRecord names only the fields that are missing', () => {
  assert.deepEqual(indexRecord(doc('type: note\nid: n1', 'b')), { ok: false, reason: 'missing_fields', missing: ['title'] });
});

test('indexRecord refuses state.md even when its frontmatter is complete', () => {
  assert.deepEqual(indexRecord(doc('type: state\nid: state-p\ntitle: State of play', 'b')), { ok: false, reason: 'state' });
});
