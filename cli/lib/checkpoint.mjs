/**
 * cli/lib/checkpoint.mjs — Reindex CLI resumable state (state.json) read/write.
 *
 * The reindex CLI writes a single state.json next to the vault that records
 * progress through the multi-phase reindex pipeline (snapshot → estimate →
 * embed-new → swap → cleanup). A crash between phases is recoverable: on
 * restart the CLI reads state.json, replays from `phase_completed + 1`, and
 * skips facts already listed in `processed_ids` (set semantics during phase 3).
 *
 * Spec ref: §6.4 (reindex state schema, schema_version=1).
 *
 * Note: distinct from `server/lib/checkpoint.mjs` (session-end summary checkpoint);
 * this module is for the v0.7 reindex CLI's resumable state.json only.
 *
 * Design notes:
 *   • Atomic writes: write to <path>.tmp, then rename. Prevents torn writes
 *     on crash; rename is atomic on POSIX and best-effort on NTFS.
 *   • Set semantics in-memory: addProcessedId() upgrades state.processed_ids
 *     to a Set on first call so duplicates collapse cheaply. The persistent
 *     representation is always Array — writeCheckpoint serializes Set→Array
 *     transparently so callers may pass either shape.
 *   • Schema-version mismatch is fatal-by-throw: the CLI surfaces the error
 *     with operator-actionable guidance ("delete or downgrade"). Forward-
 *     compat is opt-in by future schema_version=2 callers.
 *
 * NOTE: After `addProcessedId(state, id)`, `state.processed_ids` becomes a Set
 * (upgraded for O(1) dedup). Use `.size` and spread (`[...state.processed_ids]`)
 * — not `.length` — until the state is round-tripped through writeCheckpoint+readCheckpoint.
 *
 * Public API (6 named exports):
 *   - readCheckpoint(path)             → state | null
 *       Returns null on ENOENT (fresh reindex). Throws on schema mismatch
 *       or malformed JSON.
 *   - writeCheckpoint(path, state)     → void
 *       Atomic write via tmp + rename. Set→Array conversion for
 *       processed_ids if needed.
 *   - addProcessedId(state, id)        → void
 *       Mutates state.processed_ids in-place; upgrades to Set on first call
 *       so repeated ids collapse. Idempotent.
 *   - recordPhase(state, n)            → void
 *       Sets state.phase_completed = n. Caller persists via writeCheckpoint.
 *   - clearError(state)                → void
 *       Sets state.last_error = null. Used after successful resume of a phase.
 *   - createCheckpointClient(path)     → { read, write, addProcessedId, recordPhase, clearError }
 *       DI-friendly factory: binds path once so DE9-DE12 inject a single
 *       `checkpoint` dependency rather than re-passing path. Pure state
 *       mutators (addProcessedId, recordPhase, clearError) keep their
 *       (state, ...) signature so callers may still treat them as pure.
 */

import { writeFile, readFile, rename } from 'node:fs/promises';

const SCHEMA_VERSION = 1;

export async function readCheckpoint(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const state = JSON.parse(raw);
  if (state.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `checkpoint schema version ${state.schema_version}; expected ${SCHEMA_VERSION}; delete or downgrade`,
    );
  }
  return state;
}

export async function writeCheckpoint(path, state) {
  // Convert Set → Array for persistence. Callers may keep processed_ids as
  // a Set in memory while accumulating in phase 3; serialization always
  // emits an Array so the on-disk shape stays JSON-clean.
  const persisted = state.processed_ids instanceof Set
    ? { ...state, processed_ids: [...state.processed_ids] }
    : state;
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(persisted, null, 2));
  await rename(tmpPath, path);
}

export function addProcessedId(state, id) {
  // Upgrade to Set on first call so duplicates collapse without an O(n) scan.
  // Round-trip tests that never call addProcessedId keep the Array shape.
  if (!(state.processed_ids instanceof Set)) {
    state.processed_ids = new Set(state.processed_ids ?? []);
  }
  state.processed_ids.add(id);
}

export function recordPhase(state, n) {
  state.phase_completed = n;
}

export function clearError(state) {
  state.last_error = null;
}

export function createCheckpointClient(path) {
  return {
    read: () => readCheckpoint(path),
    write: (state) => writeCheckpoint(path, state),
    addProcessedId: (state, id) => addProcessedId(state, id),
    recordPhase: (state, n) => recordPhase(state, n),
    clearError: (state) => clearError(state),
  };
}
