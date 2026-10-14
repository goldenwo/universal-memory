// Where mem0's history DB lives — and with it um-counters.db, which
// capture-events.mjs places next to it (capture counters, reaction ledger).
//
// The shipped compose mounts a host dir at /var/lib/mem0 and points
// MEM0_HISTORY_DB_PATH there, so both files survive a restart. That mount can
// be unwritable: Docker creates a missing host path as root, and the server
// runs as `node` or the host user. Failing to boot over it would turn a lost
// counter into an outage, so the server falls back to /tmp — the old default,
// which works but forgets on restart — and says so in the log.
import fs from 'node:fs';
import path from 'node:path';

export const EPHEMERAL_HISTORY_DB_PATH = '/tmp/mem0-history.db';

/**
 * @param {object} [env]   - process.env-like; reads MEM0_HISTORY_DB_PATH
 * @param {object} [fsImpl] - { mkdirSync, accessSync, existsSync } (tests inject)
 * @returns {{ path: string, fellBack: boolean, configured?: string, reason?: string }}
 */
export function resolveHistoryDbPath(env = process.env, fsImpl = fs) {
  const configured = env.MEM0_HISTORY_DB_PATH;
  if (!configured) return { path: EPHEMERAL_HISTORY_DB_PATH, fellBack: false };
  const dir = path.dirname(configured);
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.accessSync(dir, fs.constants.W_OK);
    if (fsImpl.existsSync(configured)) fsImpl.accessSync(configured, fs.constants.W_OK);
    return { path: configured, fellBack: false };
  } catch (err) {
    return { path: EPHEMERAL_HISTORY_DB_PATH, fellBack: true, configured, reason: err.code || err.message };
  }
}
