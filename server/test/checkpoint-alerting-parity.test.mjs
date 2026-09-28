// #323: the checkpoint-failure alerting set lives in two places that must agree —
// the server's CHECKPOINT_FAILURE_ALERTING (it sets the log level of each
// settlement line) and the alert client's `trigger` tuple for the
// checkpoint_failure family in um-alert.sh (it decides whether the daily run
// alerts). A drift between them means the log calls a settlement an error while
// the alert stays silent, or the reverse. This test reads the client's tuple out
// of the shell script and pins both to the promoted set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CHECKPOINT_FAILURE_ALERTING,
  CHECKPOINT_FAILURE_OUTCOMES,
} from '../lib/checkpoint-signal.mjs';

const UM_ALERT = fileURLToPath(
  new URL('../../plugins/claude-code/universal-memory/bin/um-alert.sh', import.meta.url),
);

// The pre-registered #323 read (the 7-day window ending 2026-09-28): zero_commit and
// provider_stalled were zero across 112 accepted checkpoints on the main client
// host, so both were promoted. contended (lock contention, a retry succeeds) and
// other (a vocabulary drift tripwire) stay recorded-not-triggering.
const PROMOTED = ['rejected', 'failed', 'zero_commit', 'provider_stalled'];

test('#323: the server alerting set is exactly the promoted four', () => {
  assert.deepEqual([...CHECKPOINT_FAILURE_ALERTING], PROMOTED);
});

test('#323: every alerting outcome is a recorded outcome; contended and other never alert', () => {
  for (const o of CHECKPOINT_FAILURE_ALERTING) assert.ok(CHECKPOINT_FAILURE_OUTCOMES.includes(o), o);
  assert.ok(!CHECKPOINT_FAILURE_ALERTING.includes('contended'));
  assert.ok(!CHECKPOINT_FAILURE_ALERTING.includes('other'));
});

test('#323: um-alert.sh triggers on the same set as the server (parity)', async () => {
  const src = await readFile(UM_ALERT, 'utf8');
  const family = src.match(/"checkpoint_failure":\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(family, 'the checkpoint_failure CFG block moved; update this parity test');
  const trigger = family[1].match(/"trigger":\s*\(([^)]*)\)/);
  assert.ok(trigger, 'the checkpoint_failure trigger is no longer a tuple; update this parity test');
  const clientSet = [...trigger[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...clientSet].sort(), [...CHECKPOINT_FAILURE_ALERTING].sort());
});
