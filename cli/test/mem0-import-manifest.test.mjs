import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeManifest, parseManifest, MANIFEST_SCHEMA_VERSION } from '../lib/mem0-import-manifest.mjs';

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
