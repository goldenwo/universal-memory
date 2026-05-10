// server/lib/append-turn.mjs
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { acquireLockdir, releaseLockdir } from './lockdir.mjs';
import { lockContentionsTotal } from './metrics.mjs';
import { obsFallback } from './obs-fallback.mjs';
import { applyDefaultProject } from './default-project.mjs';
import { getLogger } from './logger.mjs';
import { currentRequestId } from './request-context.mjs';

// R1 review A1, fix #1: lock-contention metric. Stable label only — never
// raw lockdir paths (per-day-file expansion would explode cardinality).
function emitLockContentionMetric(lockPath) {
  try {
    lockContentionsTotal.inc({ lock_path: lockPath });
  } catch (e) {
    obsFallback(e, `metrics:lock_contentions:${lockPath}`);
  }
}

// B.12 followup: O_NOFOLLOW — refuse to follow symlinks at the open() syscall level.
// Closes the lstat→open TOCTOU race: even if an attacker swaps the path for
// a symlink between our lstat() check and our open(), the kernel rejects
// the open() with ELOOP and the redirection fails atomically.
//
// CRITICAL Windows compatibility: fsConstants.O_NOFOLLOW is `undefined` on
// Windows (NTFS has a different threat model — symlink creation requires
// SeCreateSymbolicLinkPrivilege). ORing `undefined` into open flags yields
// NaN, which fs.open rejects with ERR_INVALID_ARG_TYPE — meaning every vault
// write would fail on Windows. Coercing to 0 via `?? 0` makes the flag a
// no-op on Windows, preserving cross-platform writes. Windows-specific
// TOCTOU exposure is documented as a v0.7 hardening item; the existing
// lstat-based refusal upstream covers the lstat-refusal layer cross-platform.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const MAX_CONTENT_BYTES = 8192;
const MAX_CONVERSATION_ID_BYTES = 256;
const CONVERSATION_ID_RE = /^[\x20-\x7E]{0,256}$/;  // printable ASCII only, max 256
// PROJECT_SLUG_RE moved to ./default-project.mjs (v1.1 F1) — applyDefaultProject()
// validates against the same /^[a-zA-Z0-9._-]+$/ pattern. Kept inline pre-F1.
const ROLES = new Set(['user', 'assistant', 'system']);

export async function doAppendTurn(args, ctx = {}) {
  const vaultDir = ctx.vaultDir ?? process.env.UM_VAULT_DIR;
  const clock = ctx.clock ?? (() => new Date());

  if (!vaultDir) return { schema_version: 1, ok: false, error: 'UM_VAULT_DIR not set' };

  const { project, content, timestamp, conversation_id } = args;
  // Trim whitespace from role before validation
  const role = typeof args.role === 'string' ? args.role.trim() : args.role;
  // v1.1 F1 unification: falsy `project` → soft-default to UM_DEFAULT_PROJECT
  // (caller omitted the project; previously this was a hard-fail — the worst
  // UX in the matrix per A1 audit finding F5). Wrong-type or regex-mismatch
  // values still hard-fail, since silently substituting an arbitrary user
  // value with the default would be both surprising and a data-routing risk.
  const effectiveProject = applyDefaultProject({
    project,
    tool: 'memory_append_turn',
    logger: ctx.logger ?? getLogger(),
    requestId: ctx.requestId ?? currentRequestId(),
  });
  if (effectiveProject === null) {
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

  // C.8 (§4.2): typeof-string guard — Date.parse() coerces numeric/boolean
  // inputs to ms-since-epoch which silently shifts the date prefix and breaks
  // since/until windowing across Node major releases. Hard-fail at the lib
  // boundary with stable code:'INPUT_INVALID' so the HTTP layer maps to 400
  // via the unified envelope (B.13).
  if (timestamp !== undefined && timestamp !== null && typeof timestamp !== 'string') {
    return {
      schema_version: 1,
      ok: false,
      error: `field 'timestamp' must be ISO 8601 string, got ${typeof timestamp}`,
      code: 'INPUT_INVALID',
    };
  }
  const now = timestamp ? new Date(timestamp) : clock();
  if (Number.isNaN(now.getTime())) return { schema_version: 1, ok: false, error: 'invalid timestamp', code: 'INPUT_INVALID' };
  // Fix 2: reject timestamps outside safe year range to prevent dash-prefixed filenames + broken since/until
  const year = now.getUTCFullYear();
  if (year < 1970 || year > 9999) {
    return { schema_version: 1, ok: false, error: `timestamp year ${year} out of range (1970-9999)`, code: 'INPUT_INVALID' };
  }

  const date = now.toISOString().slice(0, 10);
  const relPath = `captures/${effectiveProject}/raw/${date}.md`;
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
    // R1 review A1, fix #1: contention metric. Use stable label 'append-turn' —
    // raw lockdir path includes the date (one bucket per day), exploding cardinality.
    emitLockContentionMetric('append-turn');
    return { schema_version: 1, ok: false, error: `lock_acquire_failed: ${err.code ?? err.message}` };
  }
  if (!acquired) {
    emitLockContentionMetric('append-turn');
    return { schema_version: 1, ok: false, error: 'lock_acquire_failed: timeout' };
  }

  try {
    // B.12 followup: open with O_NOFOLLOW so a planted symlink at the target
    // path is rejected atomically by the kernel (ELOOP on POSIX) instead of
    // followed and appending to an attacker-chosen target. NOFOLLOW is a
    // no-op on Windows (constants.O_NOFOLLOW is undefined → coerced to 0).
    // O_APPEND (vs O_TRUNC in vault-write.mjs) preserves the per-day raw-file
    // append semantics — same content, just hardened open path.
    const fh = await fs.open(absPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | NOFOLLOW, 0o644);
    try { await fh.writeFile(payload, 'utf8'); } finally { await fh.close(); }
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
