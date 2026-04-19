/**
 * vault.mjs — read-only helpers for the universal-memory vault directory.
 *
 * Exports:
 *   vaultPath()                    → string (absolute path to vault root)
 *   readVaultFile(relPath)         → Promise<string>
 *   listVaultFiles(subdir)         → Promise<string[]>
 *   statVaultFile(relPath)         → Promise<{mtime: Date, size: number}>
 *   slugify(title)                 → string
 *
 * NO write functions — the server is strictly read-only against the vault.
 * NO in-memory caching — every call goes to disk to avoid serving stale data.
 *
 * Path traversal protection: every relPath is resolved against the vault root
 * and the resulting absolute path must start with (vault + path.sep).  Any
 * attempt to escape via "../", absolute paths, or similar is rejected with an
 * Error whose message contains "traversal".
 *
 * slugify unicode: NFD normalization is applied before stripping so that
 * characters like ï (U+00EF) decompose into i + combining diaeresis and the
 * combining mark is removed, leaving the ASCII base letter.  e.g.:
 *   "Naïve" → "naive"   "Café" → "cafe"
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// vaultPath
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the vault root.
 *
 * Resolution order:
 *  1. UM_VAULT_DIR environment variable
 *  2. HOME/.um/vault  (POSIX)
 *  3. USERPROFILE/.um/vault  (Windows, when HOME is absent)
 *
 * @returns {string}
 */
export function vaultPath() {
  if (process.env.UM_VAULT_DIR) {
    return path.resolve(process.env.UM_VAULT_DIR);
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  return path.resolve(path.join(home, '.um', 'vault'));
}

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

/**
 * Resolve relPath against the vault root and verify it doesn't escape.
 * Returns the safe absolute path, or throws if the path would escape.
 *
 * @param {string} vault - Absolute vault root (from vaultPath()).
 * @param {string} relPath - Caller-supplied relative path.
 * @returns {string} resolved absolute path inside the vault
 */
function safePath(vault, relPath) {
  const vaultNorm = path.resolve(vault);
  const resolved = path.resolve(vaultNorm, relPath);
  // The resolved path must be inside the vault directory.
  // We check for vault + sep to prevent a path like /vaultX/foo
  // falsely matching a vault at /vault.
  const vaultPrefix = vaultNorm.endsWith(path.sep) ? vaultNorm : vaultNorm + path.sep;
  if (resolved !== vaultNorm && !resolved.startsWith(vaultPrefix)) {
    throw new Error(
      `Path traversal detected: "${relPath}" resolves outside the vault root`
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// readVaultFile
// ---------------------------------------------------------------------------

/**
 * Read a file relative to the vault root and return its contents as a UTF-8
 * string.  Throws on missing file or path traversal.
 *
 * @param {string} relPath
 * @returns {Promise<string>}
 */
export async function readVaultFile(relPath) {
  const vault = vaultPath();
  const abs = safePath(vault, relPath);
  return fs.readFile(abs, 'utf8');
}

// ---------------------------------------------------------------------------
// listVaultFiles
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md files under <vault>/<subdir>.
 * Returns an array of paths relative to the vault root (using forward slashes
 * on all platforms for portability).
 * Returns [] if the subdir doesn't exist.
 *
 * @param {string} subdir
 * @returns {Promise<string[]>}
 */
export async function listVaultFiles(subdir) {
  const vault = vaultPath();
  const base = safePath(vault, subdir);

  // Check the subdir exists; return [] gracefully if not.
  try {
    await fs.access(base);
  } catch {
    return [];
  }

  const results = [];
  await walkDir(base, base, results);
  return results;

  /**
   * Recursively walk dir, collecting .md files relative to base.
   * @param {string} dir - Current directory being scanned.
   * @param {string} base - The root of this subdir scan (not the vault root).
   * @param {string[]} acc - Accumulator for results.
   */
  async function walkDir(dir, _base, acc) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      // Defense in depth: never follow symlinks inside the vault. Dirent.isFile()
      // already returns false for symlinks on most filesystems, but explicit
      // lstat guards against exotic filesystems and future refactors.
      const lst = await fs.lstat(abs);
      if (lst.isSymbolicLink()) {
        const rel = path.relative(vault, abs).replace(/\\/g, '/');
        process.stderr.write(`[vault] skipping symlink in vault: ${rel}\n`);
        continue;
      }
      if (entry.isDirectory()) {
        await walkDir(abs, _base, acc);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Return path relative to vault root, normalised to forward slashes.
        const rel = path.relative(vault, abs).replace(/\\/g, '/');
        acc.push(rel);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// statVaultFile
// ---------------------------------------------------------------------------

/**
 * Return an object with at least { mtime: Date, size: number } for a vault
 * file.  Throws on missing file or path traversal.
 *
 * @param {string} relPath
 * @returns {Promise<{mtime: Date, size: number}>}
 */
export async function statVaultFile(relPath) {
  const vault = vaultPath();
  const abs = safePath(vault, relPath);
  const stat = await fs.stat(abs);
  return { mtime: stat.mtime, size: stat.size };
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

/**
 * Convert a title string into a URL/filename-safe slug.
 *
 * Rules (applied in order):
 *  1. NFD normalize to decompose composed characters (ï → i + diaeresis).
 *  2. Strip non-ASCII characters (removes combining marks and high-codepoint chars).
 *  3. Lowercase.
 *  4. Replace whitespace runs with a single hyphen.
 *  5. Strip anything not [a-z0-9-].
 *  6. Collapse consecutive hyphens.
 *  7. Trim leading/trailing hyphens.
 *  8. If the result is empty (e.g. all non-Latin input like CJK or emoji),
 *     return "untitled" as a safe default.  Callers that require non-colliding
 *     slugs for such input should hash the original title themselves.
 *
 * Examples:
 *   "My Great Note!"  → "my-great-note"
 *   "Naïve"           → "naive"
 *   "Café au Lait"    → "cafe-au-lait"
 *   ""                → "untitled"
 *   "東京"            → "untitled"
 *   "😀"              → "untitled"
 *   "!!!"             → "untitled"
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const result = title
    .normalize('NFD')            // decompose combined chars (é → e + ́)
    .replace(/[^\x00-\x7F]/g, '') // strip non-ASCII (diacritics, emoji, etc.)
    .toLowerCase()
    .replace(/[\s]+/g, '-')      // whitespace → hyphen
    .replace(/[^a-z0-9-]/g, '')  // strip non-slug chars (punctuation, etc.)
    .replace(/-{2,}/g, '-')      // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '');    // trim leading/trailing hyphens
  if (result === '' || result === '-') return 'untitled';
  return result;
}
