// Fixture driven by server/test/tmpdir-no-leak.test.mjs — NOT a suite member.
// Named `.fixture.mjs` so the `test/**/*.test.mjs` discovery glob skips it; the
// regression test runs it explicitly, once per failure mode, in a child process
// with an isolated TMPDIR.
//
// It records the dir it created so the parent can assert that a dir really was
// created and then removed — an empty temp root alone would also "pass" if this
// fixture silently did nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from '../helpers/tmpdir.mjs';

const MODE = process.env.LEAK_FIXTURE_MODE;
const RECORD = process.env.LEAK_FIXTURE_RECORD;

test(`tmpdir leak fixture — ${MODE}`, async () => {
  if (MODE === 'raw-leak-control') {
    // NEGATIVE CONTROL — deliberately bypasses tempDir(). The regression test
    // asserts this one DOES leak, which is what proves the other modes' "no
    // leftovers" assertions can actually observe a leak rather than passing
    // vacuously (e.g. against the wrong temp root). Exempted by path in
    // test/lint/no-raw-mkdtemp.test.mjs.
    appendFileSync(RECORD, `${mkdtempSync(join(tmpdir(), 'um-leakprobe-raw-'))}\n`);
    return;
  }

  appendFileSync(RECORD, `${tempDir('um-leakprobe-')}\n`);

  switch (MODE) {
    case 'pass':
      return;
    case 'assert-fail':
      assert.equal(1, 2, 'deliberate failure');
      return;
    case 'async-reject':
      await Promise.reject(new Error('deliberate rejection'));
      return;
    case 'uncaught-timer':
      // Throws off the test's own call stack — node:test cannot attribute it to
      // this test, so it is the harshest realistic path short of a hard exit.
      setTimeout(() => { throw new Error('deliberate async throw'); }, 5);
      await new Promise((r) => setTimeout(r, 50));
      return;
    case 'process-exit':
      // Skips node:test's `after` hooks entirely; only the `exit` listener runs.
      process.exit(3);
      return;
    default:
      throw new Error(`unknown LEAK_FIXTURE_MODE: ${MODE}`);
  }
});
