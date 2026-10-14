// Where mem0's history DB lives — and with it um-counters.db, which
// capture-events.mjs places next to it (capture counters, reaction ledger).
//
// The shipped compose mounts a host dir at /var/lib/mem0. With
// MEM0_HISTORY_DB_PATH unset, the server uses that mount when it is there and
// writable, so both files survive a restart; a stack without the mount keeps
// the old /tmp default. The compose file deliberately does NOT set
// MEM0_HISTORY_DB_PATH itself: an older image would then open a file on a
// mount it may not be able to write (Docker creates a missing host path as
// root) and crash-loop, which was measured on 1.27.0 in the 2026-10-14 clean
// room. Choosing the path here keeps the compose change inert for older images.
//
// When the chosen place is not writable the server falls back to /tmp and says
// so: failing to boot would turn a lost counter into an outage.
import fs from 'node:fs';
import path from 'node:path';

export const EPHEMERAL_HISTORY_DB_PATH = '/tmp/mem0-history.db';
export const DURABLE_HISTORY_DIR = '/var/lib/mem0';

function usable(file, fsImpl) {
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.accessSync(dir, fs.constants.W_OK);
  if (fsImpl.existsSync(file)) fsImpl.accessSync(file, fs.constants.W_OK);
}

/**
 * @param {object} [env]        - process.env-like; reads MEM0_HISTORY_DB_PATH
 * @param {object} [fsImpl]     - { mkdirSync, accessSync, existsSync } (tests inject)
 * @param {string} [durableDir] - the compose mount point (tests pass a temp dir)
 * @returns {{ path: string, fellBack: boolean, configured?: string, reason?: string }}
 *   `configured` is the path that was wanted; `fellBack` means it was not writable.
 */
export function resolveHistoryDbPath(env = process.env, fsImpl = fs, durableDir = DURABLE_HISTORY_DIR) {
  let wanted = env.MEM0_HISTORY_DB_PATH;
  if (!wanted) {
    // No mount → the old default, silently (that is the stack's own choice).
    if (!fsImpl.existsSync(durableDir)) return { path: EPHEMERAL_HISTORY_DB_PATH, fellBack: false };
    wanted = path.join(durableDir, 'history.db');
  }
  try {
    usable(wanted, fsImpl);
    return { path: wanted, fellBack: false };
  } catch (err) {
    return { path: EPHEMERAL_HISTORY_DB_PATH, fellBack: true, configured: wanted, reason: err.code || err.message };
  }
}
