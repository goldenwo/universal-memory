// server/test/checkpoint-openapi-drift-gate.test.mjs — Task 7: the §8 OpenAPI
// drift-gate pin (docs/plans/2026-08-15-checkpoint-chunked-summarization-
// spec.md §8, "New pins to add ... OpenAPI CheckpointSuccess"). House pattern:
// server/test/bridge-drift-gate.test.mjs.
//
// Runs REAL doCheckpoint() calls (mocked summarizeFn only — no network, no
// LLM) against a temp vault, one per envelope shape the chunked pipeline can
// emit, and asserts the ACTUAL result object stays inside the OpenAPI-declared
// CheckpointSuccess / CheckpointAbstained schemas (server/openapi.mjs):
//   - every key the envelope actually carries is declared in the schema's
//     `properties` (an undeclared key is silent drift — a future field added
//     to checkpoint.mjs without a matching openapi.mjs edit would sail through
//     every other test and only ever be caught here);
//   - every property the schema marks `required` is actually present as an
//     own key on the envelope (nullable fields — summary_id/summary_path on a
//     zero-commit run — must stay PRESENT-WITH-NULL, never silently dropped;
//     see the Task-6 carry documented on those two schema properties).
//
// This intentionally does NOT validate value *types* against the schema (no
// new JSON-schema-validator dependency for a presence check) — the brief's
// own description of this gate is a keys/required check, and openapi.test.mjs
// already round-trips the full doc through swagger-parser for structural
// validity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { doCheckpoint } from '../lib/checkpoint.mjs';
import { buildSpec } from '../openapi.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

// ---- fixture helpers (mirrors checkpoint-chunked.test.mjs's conventions) --

function makeVault() {
  return tempDir('um-ck-openapi-drift-');
}

async function seedCapture(vaultDir, project, filename, content) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, filename), content);
}

function makeUpdateStateFn() {
  return async ({ oldStateMd, newSummary }) => ({
    schema_version: 1,
    ok: true,
    mergedMd: `${oldStateMd}\n\n${newSummary}`,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    llmFailure: false,
  });
}

const BASE_CONFIG = {
  schema_version: 1,
  cost_cap_usd_per_day_per_project: 0.50,
  summary_model: 'gpt-4o-mini',
  state_cap_chars: 3000,
  lockdir_stale_timeout_ms: 600000,
  min_transcript_bytes: 0,
  min_transcript_turns: 0,
};

/** A real append-turn-shaped turn header + filler body. */
function makeTurn(iso, role, filler) {
  return `## ${iso} ${role}\n${filler}\n\n`;
}

// ---- schema lookup + the gate itself ---------------------------------------

/** Pull one named branch out of CheckpointResponse's oneOf (server/openapi.mjs). */
function getCheckpointSchema(title) {
  const doc = buildSpec();
  const branch = doc.components.schemas.CheckpointResponse.oneOf.find((b) => b.title === title);
  assert.ok(branch, `CheckpointResponse.oneOf must contain a '${title}' branch`);
  return branch;
}

/**
 * The drift gate: every key the envelope actually carries must be declared
 * in the schema's properties, and every property the schema requires must
 * actually be present (as an own key — nullable-but-present counts) on the
 * envelope.
 */
function assertNoDrift(envelope, schema, label) {
  const declared = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(envelope)) {
    assert.ok(
      declared.has(key),
      `${label}: envelope carries key '${key}' that ${schema.title} does not declare in properties — openapi.mjs has drifted from the runtime envelope`,
    );
  }
  for (const key of schema.required ?? []) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(envelope, key),
      `${label}: ${schema.title} requires '${key}' but the envelope does not carry it (even as null) — openapi.mjs overclaims`,
    );
  }
}

// ---------------------------------------------------------------------------
// CheckpointSuccess — baseline (backlog fully drained, no optional fields)
// ---------------------------------------------------------------------------

test('drift-gate: full-drain CheckpointSuccess envelope matches openapi.mjs declarations', async () => {
  const vaultDir = await makeVault();
  const t1 = makeTurn('2026-01-01T00:00:01.000Z', 'user', 'a'.repeat(1000));
  const t2 = makeTurn('2026-01-01T00:00:02.000Z', 'assistant', 'b'.repeat(1000));
  await seedCapture(vaultDir, 'driftproj', '2026-01-01.md', t1 + t2);

  const chunkMaxBytes = Math.max(Buffer.byteLength(t1, 'utf8'), Buffer.byteLength(t2, 'utf8')) + 20;

  const result = await doCheckpoint(
    { project: 'driftproj' },
    {
      config: { ...BASE_CONFIG, chunk_max_bytes: chunkMaxBytes, max_chunks_per_run: 5 },
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assertNoDrift(result, getCheckpointSchema('CheckpointSuccess'), 'full-drain');
});

// ---------------------------------------------------------------------------
// CheckpointSuccess — chunk_cap (stopped + deprecated truncated alias present)
// ---------------------------------------------------------------------------

test('drift-gate: chunk_cap CheckpointSuccess envelope (stopped + truncated present) matches openapi.mjs', async () => {
  const vaultDir = await makeVault();
  const t1 = makeTurn('2026-01-01T00:00:01.000Z', 'user', 'a'.repeat(1000));
  const t2 = makeTurn('2026-01-01T00:00:02.000Z', 'assistant', 'b'.repeat(1000));
  const t3 = makeTurn('2026-01-01T00:00:03.000Z', 'user', 'c'.repeat(1000));
  await seedCapture(vaultDir, 'driftcapproj', '2026-01-01.md', t1 + t2 + t3);

  const chunkMaxBytes = Math.max(
    Buffer.byteLength(t1, 'utf8'), Buffer.byteLength(t2, 'utf8'), Buffer.byteLength(t3, 'utf8'),
  ) + 20;

  const result = await doCheckpoint(
    { project: 'driftcapproj' },
    {
      config: { ...BASE_CONFIG, chunk_max_bytes: chunkMaxBytes, max_chunks_per_run: 2 },
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.stopped?.reason, 'chunk_cap', 'fixture must actually exercise the stopped field');
  assert.equal(result.truncated, true, 'fixture must actually exercise the deprecated truncated alias');
  assertNoDrift(result, getCheckpointSchema('CheckpointSuccess'), 'chunk_cap');
});

// ---------------------------------------------------------------------------
// CheckpointSuccess — thin_tail
// ---------------------------------------------------------------------------

test('drift-gate: thin_tail CheckpointSuccess envelope matches openapi.mjs', async () => {
  const vaultDir = await makeVault();
  const t1 = makeTurn('2026-01-01T00:00:01.000Z', 'user', 'a'.repeat(1000));
  const t2 = makeTurn('2026-01-01T00:00:02.000Z', 'assistant', 'hi');
  await seedCapture(vaultDir, 'drifttailproj', '2026-01-01.md', t1 + t2);

  const chunkMaxBytes = Buffer.byteLength(t1, 'utf8') + 20;

  const result = await doCheckpoint(
    { project: 'drifttailproj' },
    {
      config: {
        ...BASE_CONFIG, chunk_max_bytes: chunkMaxBytes, max_chunks_per_run: 5,
        min_transcript_bytes: 500, min_transcript_turns: 2,
      },
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.thin_tail, true, 'fixture must actually exercise thin_tail');
  assertNoDrift(result, getCheckpointSchema('CheckpointSuccess'), 'thin_tail');
});

// ---------------------------------------------------------------------------
// CheckpointSuccess — raw_lock, ZERO chunks committed: summary_id/summary_path
// must stay PRESENT-WITH-NULL, not absent (the Task-6 carry this task's
// nullable-schema fix targets). Real (fresh) lockdir contention, ~5s.
// ---------------------------------------------------------------------------

test('drift-gate: raw_lock zero-commit CheckpointSuccess envelope (null summary_id/summary_path) matches openapi.mjs', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'driftrawlockproj', '2026-01-01.md', makeTurn('2026-01-01T00:00:00.000Z', 'user', 'short'));
  await seedCapture(vaultDir, 'driftrawlockproj', '2026-01-02.md', '# never read\n');

  const file2Lockdir = path.join(vaultDir, 'captures', 'driftrawlockproj', 'raw', '2026-01-02.md.lockdir');
  await fs.mkdir(file2Lockdir, { recursive: true });

  const result = await doCheckpoint(
    { project: 'driftrawlockproj' },
    {
      config: { ...BASE_CONFIG, min_transcript_bytes: 500, min_transcript_turns: 2 },
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 0, 'fixture must actually exercise the zero-commit path');
  assert.equal(result.summary_id, null, 'zero-commit summary_id must be present-with-null, not absent');
  assert.equal(result.summary_path, null, 'zero-commit summary_path must be present-with-null, not absent');
  assertNoDrift(result, getCheckpointSchema('CheckpointSuccess'), 'raw_lock zero-commit');
});

// ---------------------------------------------------------------------------
// CheckpointAbstained
// ---------------------------------------------------------------------------

test('drift-gate: abstention envelope matches CheckpointAbstained openapi.mjs declaration', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'driftthinproj', '2026-01-01.md', 'too small');

  const result = await doCheckpoint(
    { project: 'driftthinproj' },
    {
      config: { ...BASE_CONFIG, min_transcript_bytes: 500, min_transcript_turns: 2 },
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.skipped, 'thin_transcript', 'fixture must actually exercise the abstention envelope');
  assertNoDrift(result, getCheckpointSchema('CheckpointAbstained'), 'abstention');
});
