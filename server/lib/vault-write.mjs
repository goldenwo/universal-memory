/**
 * vault-write.mjs — write helpers for the universal-memory vault directory.
 *
 * This module is intentionally separate from vault.mjs (which is read-only by
 * invariant) to make the asymmetry explicit. Only the MCP server uses these
 * helpers, acting as the write path for MCP clients (Claude.ai, Claude Desktop,
 * etc.) that cannot write to the host filesystem directly.
 *
 * Exports:
 *   writeVaultFile(relPath, content)  → Promise<string> (abs path written)
 *   findDocByIdInVault(id)            → Promise<string|null> (rel path or null)
 *
 * Path traversal protection: relPath is resolved against the vault root and the
 * resulting absolute path must start with (vault + path.sep). Any attempt to
 * escape is rejected. Inherited pattern from vault.mjs safePath().
 *
 * Atomic writes: we write to a .tmp sibling, then fs.rename() to the target.
 * On POSIX this is atomic (rename is POSIX-atomic for same-fs). On Windows it
 * falls back to a non-atomic overwrite (rename over existing file requires
 * unlinkSync first on older Node). Either way, partial writes don't corrupt
 * the target.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { vaultPath, listVaultFiles } from './vault.mjs';

// B.12: O_NOFOLLOW — refuse to follow symlinks at the open() syscall level.
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
// lstat-based refusal in this function (and the junction-aware tests in
// vault.test.mjs) cover the lstat-refusal layer cross-platform.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

// ---------------------------------------------------------------------------
// safePath (write edition — same logic as vault.mjs)
// ---------------------------------------------------------------------------

function safePath(vault, relPath) {
  const vaultNorm = path.resolve(vault);
  const resolved = path.resolve(vaultNorm, relPath);
  const vaultPrefix = vaultNorm.endsWith(path.sep) ? vaultNorm : vaultNorm + path.sep;
  if (resolved !== vaultNorm && !resolved.startsWith(vaultPrefix)) {
    throw new Error(
      `Path traversal detected: "${relPath}" resolves outside the vault root`
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// writeVaultFile
// ---------------------------------------------------------------------------

/**
 * Atomically write content to <vault>/<relPath>.
 * Creates parent directories as needed.
 * Returns the absolute path of the file written.
 *
 * @param {string} relPath  - Path relative to vault root (e.g. "authored/myproject/my-doc.md")
 * @param {string} content  - UTF-8 string content to write
 * @returns {Promise<string>} Absolute path of the written file
 */
export async function writeVaultFile(relPath, content) {
  const vault = vaultPath();
  const abs = safePath(vault, relPath);
  const dir = path.dirname(abs);
  const tmp = abs + '.tmp';

  // Refuse to write when the target path is already a symlink. The atomic
  // rename would replace the symlink, but a clear refusal is safer than
  // implicit overwrite and defends against TOCTOU races where a symlink
  // appears between listVaultFiles and writeVaultFile.
  let existing = null;
  try {
    existing = await fs.lstat(abs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing && existing.isSymbolicLink()) {
    throw new Error('Refusing to write through symlink: ' + relPath);
  }

  await fs.mkdir(dir, { recursive: true });

  // B.12: open the .tmp path with O_NOFOLLOW so a planted symlink at that
  // location is rejected atomically by the kernel (ELOOP), instead of
  // followed and overwriting an attacker-chosen target. The flags below
  // mirror what fs.writeFile would use under the hood (O_WRONLY|O_CREAT|
  // O_TRUNC) plus our O_NOFOLLOW (no-op on Windows, see NOFOLLOW const).
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW;
  let fh;
  try {
    fh = await fs.open(tmp, flags, 0o644);
  } catch (err) {
    // ELOOP (POSIX O_NOFOLLOW rejection) — surface a clear message so callers
    // and audit logs can recognize the symlink-swap defense firing. Other
    // errors (EACCES, ENOSPC, etc.) propagate unchanged.
    if (err.code === 'ELOOP') {
      const wrapped = new Error(`Refusing to write through symlink at .tmp path: ${path.relative(vault, tmp)}`);
      wrapped.code = 'ELOOP';
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }

  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    // Windows: rename over an existing file may fail — fall back to
    // unlink + rename (small non-atomic window acceptable here)
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      await fs.unlink(abs).catch(() => {});
      await fs.rename(tmp, abs);
    } else {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }
  return abs;
}

// ---------------------------------------------------------------------------
// findDocByIdInVault
// ---------------------------------------------------------------------------

/**
 * Scan the entire vault for a file whose filename stem equals `id`.
 * Returns the vault-relative path of the first match, or null if not found.
 * Warns to stderr if multiple matches are found (shouldn't happen by convention).
 *
 * @param {string} id - The document ID (filename stem without .md)
 * @returns {Promise<string|null>}
 */
export async function findDocByIdInVault(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('findDocByIdInVault: id must be a non-empty string');
  }
  // listVaultFiles('') would list from vault root but the subdir arg is required
  // to not be empty (it calls safePath). We pass the root subdir as '.' which
  // resolves to vault root.
  const allFiles = await listVaultFiles('.');
  const matches = allFiles.filter((p) => path.basename(p, '.md') === id);

  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    process.stderr.write(
      `[vault-write] findDocByIdInVault: multiple files match id "${id}": ${matches.join(', ')} — using first\n`
    );
  }
  return matches[0];
}
