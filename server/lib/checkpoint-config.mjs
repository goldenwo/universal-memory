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
 * Resolve a positive-INTEGER config value: env > config > shipped default.
 * Env wins only when set AND `Number(...)` is a **safe integer** AND `>=
 * min` — a blank env var (`Number('') === 0`), garbage (`Number('abc')`
 * NaN), or a fraction (`Number('200000.5')`) all fall through to config,
 * never silently accepted. Same fallthrough applies to `configValue`.
 *
 * `Number.isSafeInteger` (not `Number.isFinite`) is deliberate: these keys
 * are byte counts / chunk counts / millisecond timeouts, never fractional —
 * a fractional `chunk_max_bytes` would persist a non-integer cursor
 * `offset`, which checkpoint-cursor.mjs's §4.2 check 0
 * (`Number.isSafeInteger(offset)`) then rejects forever, a permanent
 * recovery-reinit loop.
 *
 * `min` (default 1, i.e. the original "> 0" behavior) exists because
 * "positive" alone doesn't guarantee USABLE: at very small values (e.g.
 * `chunk_max_bytes: 1`) the chunk builder can never make guaranteed
 * progress on realistic content (every hard split reduces to an empty
 * piece), so a caller with a real usability floor passes a higher `min` —
 * a value that clears "positive integer" but not that floor still falls
 * through, exactly like any other invalid value.
 *
 * @param {object} opts
 * @param {string} opts.envName - process.env key to check first.
 * @param {number} [opts.configValue] - value from checkpoint.json, if any.
 * @param {number} opts.fallback - shipped default.
 * @param {number} [opts.min] - minimum accepted value (default 1).
 * @returns {number}
 */
export function resolvePositiveInt({ envName, configValue, fallback, min = 1 }) {
  const raw = process.env[envName];
  if (raw !== undefined) {
    const envNum = Number(raw);
    if (Number.isSafeInteger(envNum) && envNum >= min) return envNum;
  }
  if (Number.isSafeInteger(configValue) && configValue >= min) {
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
      // Usability floor, not just "positive" (see resolvePositiveInt's doc
      // comment): far above any realistic single UTF-8 codepoint width, so
      // chunk-builder.mjs's guaranteed-progress hard split always has room
      // to advance, and far below the 200_000 default.
      min: 1024,
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

// Shared turn-header pattern (§4.4/Task 2 review parked finding): the single
// source of truth for "what does a raw append-turn header look like", so
// checkpoint-cursor.mjs and chunk-builder.mjs never carry their own
// slightly-drifted copies. Text aligns with checkpoint.mjs:105's
// TURN_HEADER_RE ('\S*' after the ISO's 'T', not '\S+' — a real ISO always
// has non-empty content there, so this is a no-op for valid data). Matches
// doAppendTurn's raw header at line start: `## <ISO> <role>` (an optional
// ` (conversation_id: …)` suffix, if present, falls outside the `\b`
// boundary and is simply not part of the match).
const TURN_HEADER_PATTERN = '^## \\d{4}-\\d{2}-\\d{2}T\\S* (user|assistant|system)\\b';

/**
 * Build a FRESH RegExp instance matching a raw turn header at line start.
 * Every call constructs a brand-new object — never a shared/module-level
 * instance — so no caller can ever observe another caller's mutated
 * `lastIndex` (the hazard a shared `/gm` instance carries the moment two
 * call sites use `exec`/`matchAll` against it instead of side-effect-free
 * `.match()`; this is precisely the "regex duplication" finding parked from
 * Task 2's review).
 *
 * @param {string} [flags] - RegExp flags. '' (default) for a plain
 *   single-shot `.test()` instance (e.g. "is the byte at this offset a
 *   header start?"); 'gm' for a multi-line global scan (`matchAll` over a
 *   whole file/chunk to enumerate every header).
 * @returns {RegExp}
 */
export function makeTurnHeaderRe(flags = '') {
  return new RegExp(TURN_HEADER_PATTERN, flags);
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
