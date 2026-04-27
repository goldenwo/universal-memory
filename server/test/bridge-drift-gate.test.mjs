// bridge-drift-gate.test.mjs — D.7 drift-gate cross-test
//
// Asserts that markdown emitted by the bridge translation layer (translateRows)
// round-trips cleanly through parseFrontmatter / serializeFrontmatter and passes
// validateSource('claude-mem').  This closes the D.2 drift-gate concern: a
// bridge refactor that silently changes frontmatter keys or source values would
// break this test before any production impact.
//
// Run: npm test (from server/) — picked up by the *.test.mjs glob.
//
// Cross-tree import: translate.mjs lives in plugins/ but can be imported from
// server/test/ using pathToFileURL to produce a valid file:// URL on Windows
// (bare Windows paths like 'E:/...' are not valid ESM specifiers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import {
  parseFrontmatter,
  serializeFrontmatter,
  validateSource,
} from '../lib/frontmatter.mjs';

// ---------------------------------------------------------------------------
// Cross-tree import: translate.mjs from plugins/
// ---------------------------------------------------------------------------
const _here = dirname(fileURLToPath(import.meta.url));
const _translatePath = resolve(
  _here,
  '../../plugins/claude-code/universal-memory/bin/translate.mjs',
);
const { translateRows } = await import(pathToFileURL(_translatePath).href);

// ---------------------------------------------------------------------------
// Shared mock row (V1 JOIN shape)
// ---------------------------------------------------------------------------
const MOCK_ROW = {
  rowid: 1,
  session_id: 'test-session-001',
  project_raw: 'Projects/universal-memory',
  created_at: '2026-01-15T22:00:00.000Z',
  created_at_epoch: 1768514400,
  title: 'Test session',
  summary: 'Body content goes here.',
};

// ---------------------------------------------------------------------------
// Helper: expected id SHA
// ---------------------------------------------------------------------------
function sha(sid) {
  return createHash('sha256').update(sid).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// T1 (happy path): translateRows emits one translated record, zero skipped
// ---------------------------------------------------------------------------
test('drift-gate T1: translateRows emits 1 translated, 0 skipped for mock row', () => {
  const { translated, skipped } = translateRows([MOCK_ROW]);
  assert.strictEqual(translated.length, 1, '1 translated');
  assert.strictEqual(skipped.length, 0, '0 skipped');
});

// ---------------------------------------------------------------------------
// T2: parseFrontmatter produces all required frontmatter keys
// ---------------------------------------------------------------------------
test('drift-gate T2: emitted markdown has all required frontmatter keys', () => {
  const { translated } = translateRows([MOCK_ROW]);
  const { frontmatter, body } = parseFrontmatter(translated[0].content);

  const required = [
    'type',
    'id',
    'title',
    'project',
    'status',
    'schema_version',
    'valid_from',
    'source',
    'source_session_id',
  ];

  for (const key of required) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(frontmatter, key),
      `frontmatter missing required key: ${key}`,
    );
  }

  // Body must be non-empty (wrapper comment + marker)
  assert.ok(body.length > 0, 'body is non-empty');
});

// ---------------------------------------------------------------------------
// T3: source field is 'claude-mem' and passes validateSource
// ---------------------------------------------------------------------------
test('drift-gate T3: source is "claude-mem" and passes validateSource', () => {
  const { translated } = translateRows([MOCK_ROW]);
  const { frontmatter } = parseFrontmatter(translated[0].content);

  assert.strictEqual(frontmatter.source, 'claude-mem', 'source is claude-mem');

  // validateSource must not throw — if 'claude-mem' is not in BRIDGES.md this fails
  assert.doesNotThrow(
    () => validateSource(frontmatter.source),
    'validateSource("claude-mem") must not throw',
  );
});

// ---------------------------------------------------------------------------
// T4: source_session_id matches the input session_id (TEXT, not numeric rowid)
// ---------------------------------------------------------------------------
test('drift-gate T4: source_session_id matches input session_id', () => {
  const { translated } = translateRows([MOCK_ROW]);
  const { frontmatter } = parseFrontmatter(translated[0].content);

  // YAML parses source_session_id as a string (it's text in the frontmatter)
  assert.strictEqual(
    String(frontmatter.source_session_id),
    MOCK_ROW.session_id,
    'source_session_id matches input TEXT session_id',
  );

  // Must NOT equal the integer rowid
  assert.notStrictEqual(
    String(frontmatter.source_session_id),
    String(MOCK_ROW.rowid),
    'source_session_id is not the integer rowid',
  );
});

// ---------------------------------------------------------------------------
// T5: serializeFrontmatter round-trip — re-parse produces identical frontmatter
// ---------------------------------------------------------------------------
test('drift-gate T5: serialize→parse round-trip preserves all frontmatter keys', () => {
  const { translated } = translateRows([MOCK_ROW]);
  const { frontmatter: fm1, body: body1 } = parseFrontmatter(translated[0].content);

  // Round-trip: serialize back to markdown, then parse again
  const serialized = serializeFrontmatter(fm1, body1);
  const { frontmatter: fm2 } = parseFrontmatter(serialized);

  // All keys from the first parse must be present in the second parse
  for (const [key, value] of Object.entries(fm1)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(fm2, key),
      `round-trip lost key: ${key}`,
    );
    // Compare as strings (YAML may change number types on round-trip)
    assert.strictEqual(
      String(fm2[key]),
      String(value),
      `round-trip changed value of key '${key}': ${value} → ${fm2[key]}`,
    );
  }

  // source must still pass validateSource after round-trip
  assert.doesNotThrow(() => validateSource(fm2.source), 'source still valid after round-trip');
});
