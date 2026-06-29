import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeManifest,
  parseManifest,
  MANIFEST_SCHEMA_VERSION,
  validateManifest,
  mergeUserEdits,
} from '../lib/mem0-import-manifest.mjs';

const ok = (over = {}) => ({ mem0_id: 'a', text: 't', category: 'personal', keep: true, reason: 'r', decided_by: 'judge', ...over });

test('serialize/parse round-trips with a schema_version header', () => {
  const rows = [
    { mem0_id: 'a', text: 'x', category: 'personal', keep: true, reason: 'r', decided_by: 'judge' },
    { mem0_id: 'b', text: 'y', category: 'junk', keep: false, reason: 'r2', decided_by: 'judge' },
  ];
  const text = serializeManifest(rows);
  assert.ok(text.startsWith(`{"schema_version":${MANIFEST_SCHEMA_VERSION}}`));
  const { version, rows: back } = parseManifest(text);
  assert.equal(version, MANIFEST_SCHEMA_VERSION);
  assert.deepEqual(back, rows);
});

test('parseManifest rejects an unrecognized schema_version', () => {
  const text = `{"schema_version":999}\n{"mem0_id":"a"}\n`;
  assert.throws(() => parseManifest(text), /schema_version/);
});

test('validateManifest: clean rows pass', () => {
  assert.doesNotThrow(() => validateManifest([ok(), ok({ mem0_id: 'b', keep: false, category: 'junk' })]));
});

test('validateManifest fails closed on a non-boolean keep', () => {
  assert.throws(() => validateManifest([ok({ keep: 'true' })]), /line 1.*keep/s);
});

test('validateManifest fails closed on a duplicate mem0_id', () => {
  assert.throws(() => validateManifest([ok(), ok()]), /duplicate mem0_id/);
});

test('validateManifest fails closed on a missing required field', () => {
  const bad = ok();
  delete bad.category;
  assert.throws(() => validateManifest([bad]), /line 1.*category/s);
});

test('mergeUserEdits: a user decision wins over the judge', () => {
  const judged = [ok({ mem0_id: 'a', keep: true }), ok({ mem0_id: 'b', keep: false, category: 'ops_domain' })];
  const existing = [ok({ mem0_id: 'b', keep: true, category: 'ops_domain', decided_by: 'user' })]; // operator override-kept
  const merged = mergeUserEdits(judged, existing);
  const by = Object.fromEntries(merged.map((r) => [r.mem0_id, r]));
  assert.equal(by.b.keep, true);
  assert.equal(by.b.decided_by, 'user');
  assert.equal(by.a.keep, true);
});
