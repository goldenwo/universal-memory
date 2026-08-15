// server/lib/checkpoint-config.mjs — single home for checkpoint chunking
// config resolution (spec §4.4, docs/plans/2026-08-15-checkpoint-chunked-
// summarization-spec.md).
//
// Two distinct resolver semantics coexist here, deliberately:
//   - resolvePositiveInt: for the five NEW chunking keys. 0/blank/negative/
//     NaN are FATAL misconfigurations, not "disable" — a set-but-blank env
//     var must not silently zero out a byte/timeout ceiling. Mirrors the
//     guard the repo already shipped for UM_FRESHNESS_MAX_AGE_HOURS
//     (server/lib/stats-payload.mjs:48-59).
//   - resolveFloor: the pre-existing #185 thin-transcript floors
//     (server/lib/checkpoint.mjs:111-115). 0 is a valid, deliberate value
//     there ("disable this floor"). This module becomes its home verbatim —
//     semantics are copied byte-for-byte, not changed.
//
// checkpoint.mjs and the §6 layers code both import from here so the five
// chunking keys and the #185 floors are never duplicated or module-private.

/**
 * Resolve a positive-integer config value: env > config > shipped default.
 * Env wins only when set AND `Number(...)` is finite AND > 0 — a blank env
 * var (`Number('') === 0`) or garbage (`Number('abc')` NaN) falls through
 * to config, never silently becomes 0. Same fallthrough applies to
 * `configValue`: only a finite number > 0 is accepted.
 *
 * @param {object} opts
 * @param {string} opts.envName - process.env key to check first.
 * @param {number} [opts.configValue] - value from checkpoint.json, if any.
 * @param {number} opts.fallback - shipped default.
 * @returns {number}
 */
export function resolvePositiveInt({ envName, configValue, fallback }) {
  const raw = process.env[envName];
  if (raw !== undefined) {
    const envNum = Number(raw);
    if (Number.isFinite(envNum) && envNum > 0) return envNum;
  }
  if (typeof configValue === 'number' && Number.isFinite(configValue) && configValue > 0) {
    return configValue;
  }
  return fallback;
}

/**
 * Resolve a #185 thin-transcript floor: env > config > shipped default.
 * EXACT semantics of the private copy this replaces (server/lib/
 * checkpoint.mjs:111-115) — copied byte-for-byte, never changed. Unlike
 * resolvePositiveInt, env `0` YIELDS 0 here: 0 is the deliberate "disable
 * this floor" value for the #185 gate, not a misconfiguration.
 *
 * @param {string} envName
 * @param {number} [configValue]
 * @param {number} fallback
 * @returns {number}
 */
export function resolveFloor(envName, configValue, fallback) {
  const envNum = Number(process.env[envName]);
  if (process.env[envName] !== undefined && Number.isFinite(envNum)) return envNum;
  return configValue ?? fallback;
}

// #185 thin-transcript floor defaults — same values as checkpoint.mjs:99-100.
export const DEFAULT_MIN_TRANSCRIPT_BYTES = 500;
export const DEFAULT_MIN_TRANSCRIPT_TURNS = 2;

/**
 * Resolve the five §4.4 chunking config keys: env > config > shipped
 * default, each via resolvePositiveInt (0/blank/negative/NaN are fatal
 * misconfigurations for these keys, not "disable" — see module header).
 *
 * @param {object} [config] - server/config/checkpoint.json shape; absent
 *   fields simply fall to their shipped defaults.
 * @returns {{chunkMaxBytes: number, maxChunksPerRun: number,
 *   summarizeTimeoutMs: number, autosupersedeTimeoutMs: number,
 *   stateMergeTimeoutMs: number}}
 */
export function resolveChunkingConfig(config = {}) {
  return {
    chunkMaxBytes: resolvePositiveInt({
      envName: 'UM_CHECKPOINT_CHUNK_MAX_BYTES',
      configValue: config.chunk_max_bytes,
      fallback: 200_000,
    }),
    maxChunksPerRun: resolvePositiveInt({
      envName: 'UM_CHECKPOINT_MAX_CHUNKS_PER_RUN',
      configValue: config.max_chunks_per_run,
      fallback: 3,
    }),
    summarizeTimeoutMs: resolvePositiveInt({
      envName: 'UM_CHECKPOINT_SUMMARIZE_TIMEOUT_MS',
      configValue: config.summarize_timeout_ms,
      fallback: 100_000,
    }),
    autosupersedeTimeoutMs: resolvePositiveInt({
      envName: 'UM_CHECKPOINT_AUTOSUPERSEDE_TIMEOUT_MS',
      configValue: config.autosupersede_timeout_ms,
      fallback: 30_000,
    }),
    stateMergeTimeoutMs: resolvePositiveInt({
      envName: 'UM_CHECKPOINT_STATE_MERGE_TIMEOUT_MS',
      configValue: config.state_merge_timeout_ms,
      fallback: 60_000,
    }),
  };
}

// Whole-run lockdir heartbeat interval (§4.5): refreshed on this cadence so
// a live multi-chunk run's mtime never crosses the 120s low-disk stale
// threshold (lockdir.mjs DEFAULT_LOW_DISK_STALE_MS) and loses the lock to a
// stale-recovery takeover.
export const HEARTBEAT_INTERVAL_MS = 30_000;

// §4.2 recovery re-init slack: turn ISOs are client-supplied and
// non-monotonic within a file, so the recovery watermark scan (max
// covers_until) backs off by this much before its first-match scan —
// otherwise a turn backdated below the watermark would be skipped.
export const RECOVERY_SLACK_MS = 48 * 3600 * 1000;
