// server/lib/append-turn.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireLockdir, releaseLockdir } from './lockdir.mjs';

const MAX_CONTENT_BYTES = 8192;
const MAX_CONVERSATION_ID_BYTES = 256;
const CONVERSATION_ID_RE = /^[\x20-\x7E]{0,256}$/;  // printable ASCII only, max 256
const PROJECT_SLUG_RE = /^[a-zA-Z0-9._-]+$/;
const ROLES = new Set(['user', 'assistant', 'system']);

export async function doAppendTurn(args, ctx = {}) {
  const vaultDir = ctx.vaultDir ?? process.env.UM_VAULT_DIR;
  const clock = ctx.clock ?? (() => new Date());

  if (!vaultDir) return { schema_version: 1, ok: false, error: 'UM_VAULT_DIR not set' };

  const { project, content, timestamp, conversation_id } = args;
  // Trim whitespace from role before validation
  const role = typeof args.role === 'string' ? args.role.trim() : args.role;
  if (!project || typeof project !== 'string' || !PROJECT_SLUG_RE.test(project)) {
    return { schema_version: 1, ok: false, error: `invalid project slug: ${JSON.stringify(String(project).slice(0, 64))}` };
  }
  if (!content || typeof content !== 'string') {
    return { schema_version: 1, ok: false, error: 'content is required and must be a string' };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return { schema_version: 1, ok: false, error: `content exceeds ${MAX_CONTENT_BYTES} bytes` };
  }
  if (!role) return { schema_version: 1, ok: false, error: 'role is required' };
  if (!ROLES.has(role)) return { schema_version: 1, ok: false, error: 'invalid role: ' + JSON.stringify(role) + '; accepted values: user, assistant, system' };

  // Fix 1: validate conversation_id to prevent header-line injection
  if (conversation_id !== undefined && conversation_id !== null) {
    if (typeof conversation_id !== 'string') {
      return { schema_version: 1, ok: false, error: 'conversation_id must be a string' };
    }
    if (Buffer.byteLength(conversation_id, 'utf8') > MAX_CONVERSATION_ID_BYTES) {
      return { schema_version: 1, ok: false, error: `conversation_id exceeds ${MAX_CONVERSATION_ID_BYTES} bytes` };
    }
    if (!CONVERSATION_ID_RE.test(conversation_id)) {
      return { schema_version: 1, ok: false, error: 'conversation_id must be printable ASCII (no newlines/CR/control chars)' };
    }
  }

  const now = timestamp ? new Date(timestamp) : clock();
  if (Number.isNaN(now.getTime())) return { schema_version: 1, ok: false, error: 'invalid timestamp' };
  // Fix 2: reject timestamps outside safe year range to prevent dash-prefixed filenames + broken since/until
  const year = now.getUTCFullYear();
  if (year < 1970 || year > 9999) {
    return { schema_version: 1, ok: false, error: `timestamp year ${year} out of range (1970-9999)` };
  }

  const date = now.toISOString().slice(0, 10);
  const relPath = `captures/${project}/raw/${date}.md`;
  const absPath = path.join(vaultDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });

  // Format (v0.5 extended header — role required, conversation_id optional):
  // ## <ISO timestamp> <role>[ (conversation_id: <cid>)]
  // <content>
  // <blank line>
  const header = conversation_id
    ? `## ${now.toISOString()} ${role} (conversation_id: ${conversation_id})`
    : `## ${now.toISOString()} ${role}`;
  const payload = `${header}\n${content}\n\n`;

  // Cross-process advisory lock via sibling `.lockdir` (atomic mkdir).
  // B.9 (v0.6): migrated from proper-lockfile to lockdir.mjs. The lockdir primitive
  // uses atomic mkdir(2) + EEXIST contention detection, verified cross-process-safe
  // on Windows NTFS / Linux / macOS (see docs/research/2026-04-24-v0.6-verifications/
  // V4-lockdir-race.md). This coordinates with bash stop.sh once B.11 migrates the
  // bash side from perl Fcntl::flock to the same `.lockdir` path — until then, the
  // cross-process race is the same as v0.5 (documented, low risk in practice).
  const lockdirPath = absPath + '.lockdir';

  // Fix 3: symlink guard — refuse to write if target exists and is a symlink
  const targetStat = await fs.lstat(absPath).catch(() => null);
  if (targetStat && targetStat.isSymbolicLink()) {
    return { schema_version: 1, ok: false, error: 'target is a symlink; refusing to write' };
  }

  // Acquire lockdir. DI: ctx._acquireLockdir lets tests inject failure semantics
  // (returns false → lock_acquire_failed envelope). Real callers use the module binding.
  const acquireFn = ctx._acquireLockdir ?? acquireLockdir;
  const releaseFn = ctx._releaseLockdir ?? releaseLockdir;
  let acquired;
  try {
    acquired = await acquireFn(lockdirPath, { timeoutMs: 10_000 });
  } catch (err) {
    return { schema_version: 1, ok: false, error: `lock_acquire_failed: ${err.code ?? err.message}` };
  }
  if (!acquired) {
    return { schema_version: 1, ok: false, error: 'lock_acquire_failed: timeout' };
  }

  try {
    await fs.appendFile(absPath, payload);
  } finally {
    await releaseFn(lockdirPath);
  }

  return {
    schema_version: 1,  // v0.4 "Version your contracts" — additive fields in later
                        // schema_version=1 variants stay backward-compatible; breaking changes bump.
    ok: true,
    path: relPath,
    appended: true,
    bytes_written: Buffer.byteLength(payload, 'utf8'),
  };
}
