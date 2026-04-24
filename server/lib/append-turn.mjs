// server/lib/append-turn.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_CONTENT_BYTES = 8192;
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

  const now = timestamp ? new Date(timestamp) : clock();
  if (Number.isNaN(now.getTime())) return { schema_version: 1, ok: false, error: 'invalid timestamp' };

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

  // Advisory lock via sibling `.lock` file. Note that within-node and within-bash
  // concurrency are each protected (node via proper-lockfile mkdir-based mutex,
  // bash via perl Fcntl::flock — see plugins/claude-code/universal-memory/hooks/stop.sh),
  // but cross-process bash↔node races are NOT coordinated in v0.5: proper-lockfile
  // uses a lock-directory (`<file>.lock.lock`) while bash's flock(2) is a kernel FD
  // lock — different mechanisms. Practical corruption risk is low because stop.sh
  // writes <10KB in <10ms and rarely overlaps with live MCP append-turn calls.
  // Cross-process coordination is a known v0.6 hardening item.
  const lockfilePath = absPath + '.lock';
  // Ensure the lockfile exists (proper-lockfile requires the target to exist)
  await fs.writeFile(lockfilePath, '', { flag: 'a' });

  let release;
  try {
    release = await lockAcquire(lockfilePath, ctx);
  } catch (err) {
    return { schema_version: 1, ok: false, error: `lock_acquire_failed: ${err.code ?? err.message}` };
  }
  try {
    await fs.appendFile(absPath, payload);
  } finally {
    await release();
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

// Locked sibling-file acquire with stale-lock recovery.
// `proper-lockfile` uses mtime-based stale detection, which handles crashed writers.
async function lockAcquire(lockfilePath, ctx = {}) {
  const lockfile = ctx.lockfile ?? (await import('proper-lockfile')).default;
  return await lockfile.lock(lockfilePath, {
    retries: { retries: 30, minTimeout: 20, maxTimeout: 150, factor: 1.2 },
    stale: 10000,  // 10s — matches stop.sh's trivial write window
    // TODO(v0.6): revisit stale-lock semantics when cross-device sync lands.
    // Syncthing-propagated files can have mtimes that appear to jump backward
    // on the receiving device, misfiring proper-lockfile's mtime-based stale
    // detection. Single-machine writer case (v0.5) is unaffected.
  });
}
