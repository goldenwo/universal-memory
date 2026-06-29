import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeManifest,
  parseManifest,
  MANIFEST_SCHEMA_VERSION,
  validateManifest,
  mergeUserEdits,
  buildImportMetadata,
  renderReviewMd,
  countKeepers,
  IMPORT_METADATA_KEYS,
} from '../lib/mem0-import-manifest.mjs';
import { RESERVED_METADATA_FIELDS } from '../../server/lib/dedup-constants.mjs';

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

test('buildImportMetadata shape', () => {
  const m = buildImportMetadata({ mem0_id: 'a', category: 'dev', importedAt: '2026-06-27T00:00:00Z' });
  assert.deepEqual(m, { mem0_id: 'a', category: 'dev', imported_at: '2026-06-27T00:00:00Z' });
});

test('GUARD: import metadata keys never collide with the reserved-field set', () => {
  const reserved = new Set(RESERVED_METADATA_FIELDS);
  for (const k of IMPORT_METADATA_KEYS) {
    assert.ok(!reserved.has(k), `import key ${k} must not be reserved (would break future re-imports)`);
  }
});

test('countKeepers + renderReviewMd', () => {
  const rows = [
    { mem0_id: 'a', text: 't', category: 'personal', keep: true, reason: 'r', decided_by: 'judge' },
    { mem0_id: 'b', text: 'u', category: 'junk', keep: false, reason: 'r', decided_by: 'judge' },
    { mem0_id: 'c', text: 'v', category: 'unjudged', keep: false, reason: 'err', decided_by: 'judge' },
  ];
  assert.equal(countKeepers(rows), 1);
  const md = renderReviewMd(rows);
  // unjudged is its OWN blocking bucket, not folded into "dropped" (spec §4.3).
  assert.ok(md.includes('kept 1') && md.includes('dropped 1') && md.includes('unjudged 1'));
  assert.ok(/unjudged/i.test(md), 'review must surface an unjudged section');
});
