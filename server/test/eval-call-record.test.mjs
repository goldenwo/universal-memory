// server/test/eval-call-record.test.mjs — the per-call record the model-migration Phase B harnesses
// keep (eval/lib/call-record.mjs): timing, the fields kept, and the input hash each run records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { timed, callRecord, fileSha256, CALL_FIELDS } from '../eval/lib/call-record.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

test('callRecord keeps ok, failCause, the R1 fields and ms, leaving out what a verdict does not carry', () => {
  assert.deepEqual(CALL_FIELDS, ['ok', 'failCause', 'requestParams', 'servedModel', 'systemFingerprint', 'reasoningTokens', 'stopReason', 'ms']);
  assert.deepEqual(callRecord({ ok: false, failCause: 'invoke-error', ms: 3, contradicts: false }), { ok: false, failCause: 'invoke-error', ms: 3 });
  assert.deepEqual(callRecord({ ok: true, servedModel: 'm', systemFingerprint: null, ms: 1 }), { ok: true, servedModel: 'm', systemFingerprint: null, ms: 1 }, 'a null is kept; only undefined is left out');
});

test('timed adds the call\'s latency to its resolved object', async () => {
  const v = await timed(async () => ({ ok: true }));
  assert.equal(v.ok, true);
  assert.equal(typeof v.ms, 'number');
});

test('fileSha256 hashes a file\'s bytes', async () => {
  const p = join(tempDir('um-call-record-'), 'f.txt');
  await writeFile(p, 'abc\n');
  assert.equal(await fileSha256(p), createHash('sha256').update('abc\n').digest('hex'));
});
