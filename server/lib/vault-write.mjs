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
import path from 'node:path';
import { vaultPath, listVaultFiles } from './vault.mjs';

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
  await fs.writeFile(tmp, content, 'utf8');
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
