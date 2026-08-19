// server/test/delete-enumeration-262.test.mjs — #262 regression pins.
//
// #262: reindexDoc duplicated points instead of replacing them because
// deleteByMetadataId enumerated the corpus SHORT — pre-#231 it rode mem0
// getAll's default limit (100), so any target doc past position 100 was
// invisible to the delete pass, and the subsequent umAdd wrote a second
// point. #231 round-2 threaded FULL_SCAN_LIMIT through the call; this file
// pins that threading AND closes the residual hole: at >= FULL_SCAN_LIMIT
// points the same silent-truncation class reopens unless the destructive
// caller fails loud (the contract FULL_SCAN_LIMIT's own doc comment states).
//
// deleteByMetadataId is module-private and bound to the module-level
// `memory` (not ctx-injectable) — the behavioral surface is pinned the same
// way r1-review-fixes.test.mjs pins its withRetry wrapping: a pure unit test
// on the extracted guard + static-shape assertions on the call site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { assertScanNotSaturated, FULL_SCAN_LIMIT } from '../lib/mem0-read.mjs';

test('#262 G1: assertScanNotSaturated passes below the cap', () => {
  assert.doesNotThrow(() =>
    assertScanNotSaturated(new Array(FULL_SCAN_LIMIT - 1), 'deleteByMetadataId'));
  assert.doesNotThrow(() => assertScanNotSaturated([], 'deleteByMetadataId'));
});

test('#262 G2: assertScanNotSaturated throws AT the cap (>= boundary, not >)', () => {
  assert.throws(
    () => assertScanNotSaturated(new Array(FULL_SCAN_LIMIT), 'deleteByMetadataId'),
    (err) => /deleteByMetadataId/.test(err.message)
      && /saturat/i.test(err.message)
      && new RegExp(String(FULL_SCAN_LIMIT)).test(err.message),
    'error must name the op, the saturation, and the cap so an operator log is actionable',
  );
});

test('#262 G3: deleteByMetadataId enumerates with FULL_SCAN_LIMIT and guards saturation (static shape)', async () => {
  const src = await fs.readFile(new URL('../mem0-mcp-http.mjs', import.meta.url), 'utf8');
  const fnBody = src.slice(
    src.indexOf('async function deleteByMetadataId'),
    src.indexOf('async function reindexDoc'),
  );
  assert.ok(fnBody.length > 0, 'deleteByMetadataId body located before reindexDoc');
  assert.match(fnBody, /limit:\s*FULL_SCAN_LIMIT/,
    'the #262 defect: without FULL_SCAN_LIMIT the enumeration rides a 100-point default and delete-then-rewrite resurrects/duplicates');
  assert.match(fnBody, /assertScanNotSaturated\(/,
    'destructive path must fail loud on a saturated (possibly truncated) view — FULL_SCAN_LIMIT contract');
});
