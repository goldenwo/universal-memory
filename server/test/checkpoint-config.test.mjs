// server/test/checkpoint-config.test.mjs — checkpoint-config.mjs resolver
// tests (Task 1, docs/plans/2026-08-15-checkpoint-chunked-summarization-plan).
//
// Covers:
//  - resolvePositiveInt matrix: env-valid wins, env-invalid falls through to
//    config, config-invalid falls through to fallback.
//  - resolveFloor: env '0' YIELDS 0 (disable semantics) — the deliberate
//    contrast with resolvePositiveInt.
//  - resolveChunkingConfig: all five defaults, each env override, and the
//    load-bearing blank-env regression (UM_CHECKPOINT_MAX_CHUNKS_PER_RUN=''
//    must land on 3, not 0).
//  - Constants exact values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePositiveInt,
  resolveFloor,
  resolveChunkingConfig,
  DEFAULT_MIN_TRANSCRIPT_BYTES,
  DEFAULT_MIN_TRANSCRIPT_TURNS,
  HEARTBEAT_INTERVAL_MS,
  RECOVERY_SLACK_MS,
} from '../lib/checkpoint-config.mjs';
import { DEFAULT_LOW_DISK_STALE_MS } from '../lib/lockdir.mjs';

const ENV_NAME = 'UM_TEST_CHECKPOINT_CONFIG_KEY';

// Save/restore the single env key each resolvePositiveInt/resolveFloor case
// touches, so cases never leak into each other or the rest of the suite.
function withEnv(value, fn) {
  const prev = process.env[ENV_NAME];
  if (value === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = prev;
  }
}

// --- resolvePositiveInt ------------------------------------------------

test('resolvePositiveInt: env valid > 0 wins over config and fallback', () => {
  withEnv('42', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 42);
  });
});

test('resolvePositiveInt: blank env falls through to config', () => {
  withEnv('', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 7);
  });
});

test('resolvePositiveInt: env "0" falls through to config', () => {
  withEnv('0', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 7);
  });
});

test('resolvePositiveInt: negative env falls through to config', () => {
  withEnv('-5', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 7);
  });
});

test('resolvePositiveInt: non-numeric env ("abc") falls through to config', () => {
  withEnv('abc', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 7);
  });
});

test('resolvePositiveInt: config 0 falls through to fallback', () => {
  withEnv(undefined, () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 0, fallback: 9 });
    assert.equal(v, 9);
  });
});

test('resolvePositiveInt: config negative falls through to fallback', () => {
  withEnv(undefined, () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: -3, fallback: 9 });
    assert.equal(v, 9);
  });
});

test('resolvePositiveInt: config absent falls through to fallback', () => {
  withEnv(undefined, () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: undefined, fallback: 9 });
    assert.equal(v, 9);
  });
});

// Final-review ledger (cheap item): a non-numeric configValue (e.g. a raw
// JSON-parsed checkpoint.json field that came through as a string instead of
// a number) must fall through exactly like 0/negative/absent — Number.
// isSafeInteger(configValue) is false for any non-number typeof, so this was
// already the resolver's real behavior; only the pin was missing.
test('resolvePositiveInt: non-numeric configValue (string "7") falls through to fallback', () => {
  withEnv(undefined, () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: '7', fallback: 9 });
    assert.equal(v, 9);
  });
});

test('resolvePositiveInt: env absent, config valid wins over fallback', () => {
  withEnv(undefined, () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 15, fallback: 9 });
    assert.equal(v, 15);
  });
});

// --- resolvePositiveInt: integrality matrix (round-1 review IMPORTANT 2) --
// Fractional/non-safe-integer values must fall through exactly like NaN or
// negative values do — a persisted fractional chunk offset would fail
// checkpoint-cursor.mjs's `Number.isSafeInteger(offset)` shape guard
// forever (a permanent recovery-reinit loop). Also closes Task 1's deferred
// minor ("200000.5 would pass un-rounded").

test('resolvePositiveInt: fractional env ("7.5") falls through to config', () => {
  withEnv('7.5', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 7);
  });
});

test('resolvePositiveInt: fractional config (200000.5) falls through to fallback', () => {
  withEnv(undefined, () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 200000.5, fallback: 200_000 });
    assert.equal(v, 200_000);
  });
});

test('resolvePositiveInt: env Infinity falls through to config (not a safe integer)', () => {
  withEnv('Infinity', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 7);
  });
});

test('resolvePositiveInt: env beyond MAX_SAFE_INTEGER falls through to config', () => {
  withEnv(String(Number.MAX_SAFE_INTEGER + 1024), () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 7);
  });
});

test('resolvePositiveInt: a whole-number-valued env string ("42.0") is accepted (still a safe integer)', () => {
  withEnv('42.0', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 7, fallback: 1 });
    assert.equal(v, 42);
  });
});

// --- resolvePositiveInt: `min` param (round-1 review IMPORTANT 2) --------
// Values that clear "positive integer" but not a caller-supplied usability
// floor fall through exactly like any other invalid value — never silently
// accepted just because they're technically > 0.

test('resolvePositiveInt: env below min falls through to config', () => {
  withEnv('3', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 5000, fallback: 9000, min: 1024 });
    assert.equal(v, 5000);
  });
});

test('resolvePositiveInt: env at exactly min is accepted', () => {
  withEnv('1024', () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 5000, fallback: 9000, min: 1024 });
    assert.equal(v, 1024);
  });
});

test('resolvePositiveInt: config below min falls through to fallback', () => {
  withEnv(undefined, () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 500, fallback: 9000, min: 1024 });
    assert.equal(v, 9000);
  });
});

test('resolvePositiveInt: default min is 1 (unchanged ">0" behavior when omitted)', () => {
  withEnv(undefined, () => {
    const v = resolvePositiveInt({ envName: ENV_NAME, configValue: 1, fallback: 9000 });
    assert.equal(v, 1);
  });
});

// --- resolveFloor --------------------------------------------------------

test('resolveFloor: env "0" YIELDS 0 (disable semantics — contrast with resolvePositiveInt)', () => {
  withEnv('0', () => {
    const v = resolveFloor(ENV_NAME, 7, 1);
    assert.equal(v, 0);
  });
});

test('resolveFloor: env absent falls through to config', () => {
  withEnv(undefined, () => {
    const v = resolveFloor(ENV_NAME, 7, 1);
    assert.equal(v, 7);
  });
});

test('resolveFloor: env absent and config absent falls through to fallback', () => {
  withEnv(undefined, () => {
    const v = resolveFloor(ENV_NAME, undefined, 1);
    assert.equal(v, 1);
  });
});

// --- resolveChunkingConfig ------------------------------------------------

const CHUNKING_ENV_NAMES = [
  'UM_CHECKPOINT_CHUNK_MAX_BYTES',
  'UM_CHECKPOINT_MAX_CHUNKS_PER_RUN',
  'UM_CHECKPOINT_SUMMARIZE_TIMEOUT_MS',
  'UM_CHECKPOINT_AUTOSUPERSEDE_TIMEOUT_MS',
  'UM_CHECKPOINT_STATE_MERGE_TIMEOUT_MS',
];

function withChunkingEnv(overrides, fn) {
  const prev = {};
  for (const name of CHUNKING_ENV_NAMES) prev[name] = process.env[name];
  for (const name of CHUNKING_ENV_NAMES) delete process.env[name];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const name of CHUNKING_ENV_NAMES) {
      if (prev[name] === undefined) delete process.env[name];
      else process.env[name] = prev[name];
    }
  }
}

test('resolveChunkingConfig: all five defaults exact when nothing set', () => {
  withChunkingEnv({}, () => {
    const cfg = resolveChunkingConfig();
    assert.deepEqual(cfg, {
      chunkMaxBytes: 200_000,
      maxChunksPerRun: 3,
      summarizeTimeoutMs: 100_000,
      autosupersedeTimeoutMs: 30_000,
      stateMergeTimeoutMs: 60_000,
    });
  });
});

test('resolveChunkingConfig: UM_CHECKPOINT_CHUNK_MAX_BYTES override lands on chunkMaxBytes', () => {
  withChunkingEnv({ UM_CHECKPOINT_CHUNK_MAX_BYTES: '50000' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.chunkMaxBytes, 50000);
    assert.equal(cfg.maxChunksPerRun, 3);
  });
});

test('resolveChunkingConfig: UM_CHECKPOINT_MAX_CHUNKS_PER_RUN override lands on maxChunksPerRun', () => {
  withChunkingEnv({ UM_CHECKPOINT_MAX_CHUNKS_PER_RUN: '7' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.maxChunksPerRun, 7);
  });
});

test('resolveChunkingConfig: UM_CHECKPOINT_SUMMARIZE_TIMEOUT_MS override lands on summarizeTimeoutMs', () => {
  withChunkingEnv({ UM_CHECKPOINT_SUMMARIZE_TIMEOUT_MS: '12345' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.summarizeTimeoutMs, 12345);
  });
});

test('resolveChunkingConfig: UM_CHECKPOINT_AUTOSUPERSEDE_TIMEOUT_MS override lands on autosupersedeTimeoutMs', () => {
  withChunkingEnv({ UM_CHECKPOINT_AUTOSUPERSEDE_TIMEOUT_MS: '9999' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.autosupersedeTimeoutMs, 9999);
  });
});

test('resolveChunkingConfig: UM_CHECKPOINT_STATE_MERGE_TIMEOUT_MS override lands on stateMergeTimeoutMs', () => {
  withChunkingEnv({ UM_CHECKPOINT_STATE_MERGE_TIMEOUT_MS: '11111' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.stateMergeTimeoutMs, 11111);
  });
});

test('resolveChunkingConfig: config fields land on the right keys', () => {
  withChunkingEnv({}, () => {
    const cfg = resolveChunkingConfig({
      // chunk_max_bytes must clear its 1024 usability floor (round-1 review
      // IMPORTANT 2) — unlike the other four keys, `1` is not accepted here.
      chunk_max_bytes: 2000,
      max_chunks_per_run: 2,
      summarize_timeout_ms: 3,
      autosupersede_timeout_ms: 4,
      state_merge_timeout_ms: 5,
    });
    assert.deepEqual(cfg, {
      chunkMaxBytes: 2000,
      maxChunksPerRun: 2,
      summarizeTimeoutMs: 3,
      autosupersedeTimeoutMs: 4,
      stateMergeTimeoutMs: 5,
    });
  });
});

// --- resolveChunkingConfig: chunk_max_bytes's 1024 usability floor
// (round-1 review IMPORTANT 2) ---------------------------------------------

test('resolveChunkingConfig: UM_CHECKPOINT_CHUNK_MAX_BYTES below 1024 falls through to config, then default', () => {
  withChunkingEnv({ UM_CHECKPOINT_CHUNK_MAX_BYTES: '1' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.chunkMaxBytes, 200_000, 'below the 1024 floor -> shipped default, not 1');
  });
});

test('resolveChunkingConfig: UM_CHECKPOINT_CHUNK_MAX_BYTES=0.5 (fractional) falls through to default', () => {
  withChunkingEnv({ UM_CHECKPOINT_CHUNK_MAX_BYTES: '0.5' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.chunkMaxBytes, 200_000);
  });
});

test('resolveChunkingConfig: chunk_max_bytes config value 0.25 (fractional) falls through to default', () => {
  withChunkingEnv({}, () => {
    const cfg = resolveChunkingConfig({ chunk_max_bytes: 0.25 });
    assert.equal(cfg.chunkMaxBytes, 200_000);
  });
});

test('resolveChunkingConfig: UM_CHECKPOINT_CHUNK_MAX_BYTES=1024 (exactly the floor) is accepted', () => {
  withChunkingEnv({ UM_CHECKPOINT_CHUNK_MAX_BYTES: '1024' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.chunkMaxBytes, 1024);
  });
});

test('resolveChunkingConfig: blank UM_CHECKPOINT_MAX_CHUNKS_PER_RUN falls to default 3, NOT 0 (load-bearing regression — Number("")===0 hazard)', () => {
  withChunkingEnv({ UM_CHECKPOINT_MAX_CHUNKS_PER_RUN: '' }, () => {
    const cfg = resolveChunkingConfig();
    assert.equal(cfg.maxChunksPerRun, 3);
  });
});

// --- Constants -------------------------------------------------------------

test('DEFAULT_MIN_TRANSCRIPT_BYTES / DEFAULT_MIN_TRANSCRIPT_TURNS exact values', () => {
  assert.equal(DEFAULT_MIN_TRANSCRIPT_BYTES, 500);
  assert.equal(DEFAULT_MIN_TRANSCRIPT_TURNS, 2);
});

test('HEARTBEAT_INTERVAL_MS / RECOVERY_SLACK_MS exact values', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal(RECOVERY_SLACK_MS, 48 * 3600 * 1000);
});

// --- I6 pins (task-8-brief.md §3; spec §9 I6) -------------------------------
// Both by IMPORT — a future default bump on either side of either formula
// must fail these tests, not merely a fixture. This is the actual invariant
// review target §8/§9 name; Task 6 implemented the heartbeat BEHAVIOR
// (integration-tested in checkpoint-chunked.test.mjs) but explicitly left
// these numeric import-comparison pins for this task.

test('I6(a): HEARTBEAT_INTERVAL_MS < DEFAULT_LOW_DISK_STALE_MS (spec §9 I6(a), the primary takeover guard — a future default bump on either constant must fail this)', () => {
  assert.ok(
    HEARTBEAT_INTERVAL_MS < DEFAULT_LOW_DISK_STALE_MS,
    `heartbeat interval (${HEARTBEAT_INTERVAL_MS}ms) must stay strictly below the low-disk stale threshold `
    + `(${DEFAULT_LOW_DISK_STALE_MS}ms) — otherwise a live multi-chunk run's heartbeat can no longer `
    + 'guarantee takeover-proofness under low disk (lockdir.mjs\'s 120s low-disk regime).',
  );
});

test('I6(b): maxChunksPerRun x (summarizeTimeoutMs + stateMergeTimeoutMs + autosupersedeTimeoutMs) <= 0.7 x 900_000 (spec §5/§9 I6(b), the drain\'s curl --max-time 900 budget, >=30% margin)', () => {
  // Final-review MINOR 7: this pin's whole point is testing the SHIPPED
  // DEFAULTS — a bare resolveChunkingConfig() call reads ambient
  // UM_CHECKPOINT_* env vars if a runner happens to have any exported
  // (operator shell, a leaking prior test), silently skewing the formula
  // away from the defaults it claims to pin. withChunkingEnv({}, ...) —
  // the same seam every other test in this file already uses — clears the
  // five keys for the duration of the call.
  withChunkingEnv({}, () => {
    const cfg = resolveChunkingConfig(); // shipped defaults — env/config overrides are an operator choice, not this pin's concern
    const DRAIN_CURL_BUDGET_MS = 900_000; // spec §5: um-drain.sh's own `curl --max-time 900`
    const MARGIN_FRACTION = 0.7; // literal, per task-8-brief.md §3 — at most 70% of budget used, so >=30% margin remains
    const worstCaseMs = cfg.maxChunksPerRun * (cfg.summarizeTimeoutMs + cfg.stateMergeTimeoutMs + cfg.autosupersedeTimeoutMs);
    // The remaining margin absorbs what this formula does NOT represent: the
    // per-chunk cost-cap peek (step 1), raw-lock acquire waits (chunk-builder's
    // RAW_LOCK_TIMEOUT_MS per pending file), and general run/IO overhead —
    // none of which carry their own timeout constant (Task-6 review Minor 9).
    assert.ok(
      worstCaseMs <= MARGIN_FRACTION * DRAIN_CURL_BUDGET_MS,
      `worst-case run duration (${worstCaseMs}ms = ${cfg.maxChunksPerRun} x (${cfg.summarizeTimeoutMs}+${cfg.stateMergeTimeoutMs}+${cfg.autosupersedeTimeoutMs})) `
      + `must stay <= ${MARGIN_FRACTION} x the drain's 900s curl budget (${MARGIN_FRACTION * DRAIN_CURL_BUDGET_MS}ms)`,
    );
  });
});
