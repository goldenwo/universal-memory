/**
 * Tests for server/lib/vault.mjs
 *
 * Run with: node --test server/test/vault.test.mjs
 *
 * Uses tmp directories (fs.mkdtemp) so tests are self-contained and never
 * touch the real vault.  All tests pass on Windows (backslash paths).
 *
 * slugify unicode choice: NFD decomposition then strip non-ASCII, so
 *   "Naïve" → "naive"  (diacritic stripped, not hyphenated)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  vaultPath,
  readVaultFile,
  listVaultFiles,
  statVaultFile,
  slugify,
} from '../lib/vault.mjs';
import {
  writeVaultFile,
  findDocByIdInVault,
} from '../lib/vault-write.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory, write some fixture files, return the dir path. */
async function makeTmpVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'um-vault-test-'));
  return dir;
}

/** Write a file relative to a base dir, creating intermediate dirs as needed. */
async function writeFixture(base, relPath, content) {
  const abs = path.join(base, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

// ---------------------------------------------------------------------------
// 1. vaultPath()
// ---------------------------------------------------------------------------

test('vaultPath: returns UM_VAULT_DIR when set (normalized to OS-native separators)', () => {
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = '/custom/vault';
    // vaultPath() now runs path.resolve() so forward-slash input is
    // canonicalized to OS-native separators (e.g. C:\custom\vault on Windows).
    assert.equal(vaultPath(), path.resolve('/custom/vault'));
  } finally {
    if (original === undefined) {
      delete process.env.UM_VAULT_DIR;
    } else {
      process.env.UM_VAULT_DIR = original;
    }
  }
});

test('vaultPath: falls back to HOME/.um/vault when UM_VAULT_DIR is unset', () => {
  const savedVault = process.env.UM_VAULT_DIR;
  try {
    delete process.env.UM_VAULT_DIR;
    const result = vaultPath();
    // Should end with .um/vault (using OS-appropriate separator)
    assert.ok(
      result.endsWith(path.join('.um', 'vault')),
      `expected path ending in .um${path.sep}vault, got: ${result}`
    );
    // Should be absolute
    assert.ok(path.isAbsolute(result), 'fallback path should be absolute');
  } finally {
    if (savedVault === undefined) {
      delete process.env.UM_VAULT_DIR;
    } else {
      process.env.UM_VAULT_DIR = savedVault;
    }
  }
});

test('vaultPath: fallback uses USERPROFILE on Windows when HOME is absent', () => {
  const savedVault = process.env.UM_VAULT_DIR;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  try {
    delete process.env.UM_VAULT_DIR;
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\testuser';
    const result = vaultPath();
    assert.ok(path.isAbsolute(result), 'fallback path should be absolute');
    assert.ok(
      result.endsWith(path.join('.um', 'vault')),
      `expected .um/vault suffix, got: ${result}`
    );
  } finally {
    if (savedVault === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = savedVault;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }
});

// ---------------------------------------------------------------------------
// 2. readVaultFile()
// ---------------------------------------------------------------------------

test('readVaultFile: reads an existing file and returns UTF-8 content', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeFixture(vault, 'notes/hello.md', '# Hello\n\nWorld.\n');
    const content = await readVaultFile('notes/hello.md');
    assert.equal(content, '# Hello\n\nWorld.\n');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('readVaultFile: throws on missing file', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await assert.rejects(
      () => readVaultFile('does-not-exist.md'),
      (err) => err.code === 'ENOENT' || err.message.includes('ENOENT')
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('readVaultFile: throws on path traversal (../)', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await assert.rejects(
      () => readVaultFile('../etc/passwd'),
      (err) => /traversal|escape|outside/i.test(err.message)
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('readVaultFile: throws on absolute path that escapes vault', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    // An absolute path pointing somewhere outside the vault
    const outside = os.tmpdir();
    await assert.rejects(
      () => readVaultFile(outside),
      (err) => /traversal|escape|outside/i.test(err.message)
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('readVaultFile: deeply nested ../.. traversal is rejected', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeFixture(vault, 'a/b/note.md', 'text');
    await assert.rejects(
      () => readVaultFile('a/b/../../../../../../etc/passwd'),
      (err) => /traversal|escape|outside/i.test(err.message)
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

// ---------------------------------------------------------------------------
// 3. listVaultFiles()
// ---------------------------------------------------------------------------

test('listVaultFiles: returns only .md files under a subdir', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeFixture(vault, 'sessions/2026-04-17.md', '# session');
    await writeFixture(vault, 'sessions/2026-04-18.md', '# session2');
    await writeFixture(vault, 'sessions/notes.txt', 'not markdown');
    await writeFixture(vault, 'sessions/data.json', '{}');

    const files = await listVaultFiles('sessions');
    assert.equal(files.length, 2);
    for (const f of files) {
      assert.ok(f.endsWith('.md'), `expected .md extension: ${f}`);
    }
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('listVaultFiles: returns paths relative to vault root', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeFixture(vault, 'captures/raw.md', '# raw');

    const files = await listVaultFiles('captures');
    assert.equal(files.length, 1);
    // Must be relative to vault root, not absolute
    assert.ok(!path.isAbsolute(files[0]), `should be relative: ${files[0]}`);
    // Must start with the subdir name
    assert.ok(
      files[0].startsWith('captures'),
      `should start with "captures": ${files[0]}`
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('listVaultFiles: recurses into subdirectories', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeFixture(vault, 'notes/top.md', '# top');
    await writeFixture(vault, 'notes/sub/deep.md', '# deep');
    await writeFixture(vault, 'notes/sub/deeper/bottom.md', '# bottom');

    const files = await listVaultFiles('notes');
    assert.equal(files.length, 3);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('listVaultFiles: returns [] for a missing subdir (no throw)', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    const files = await listVaultFiles('nonexistent-subdir');
    assert.deepEqual(files, []);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('listVaultFiles: returns [] for a subdir with no .md files', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeFixture(vault, 'assets/image.png', '');
    await writeFixture(vault, 'assets/style.css', '');

    const files = await listVaultFiles('assets');
    assert.deepEqual(files, []);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

// ---------------------------------------------------------------------------
// 4. statVaultFile()
// ---------------------------------------------------------------------------

test('statVaultFile: returns mtime (Date) and size (number) for existing file', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeFixture(vault, 'state.md', 'content here');

    const stat = await statVaultFile('state.md');
    assert.ok(stat.mtime instanceof Date, 'mtime should be a Date');
    assert.ok(typeof stat.size === 'number', 'size should be a number');
    assert.ok(stat.size > 0, 'size should be > 0 for non-empty file');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('statVaultFile: throws on missing file', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await assert.rejects(
      () => statVaultFile('missing.md'),
      (err) => err.code === 'ENOENT' || err.message.includes('ENOENT')
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('statVaultFile: throws on path traversal', async () => {
  const vault = await makeTmpVault();
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await assert.rejects(
      () => statVaultFile('../outside.md'),
      (err) => /traversal|escape|outside/i.test(err.message)
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

// ---------------------------------------------------------------------------
// 5. slugify()
// ---------------------------------------------------------------------------

test('slugify: basic lowercase kebab-case', () => {
  assert.equal(slugify('My Great Note'), 'my-great-note');
});

test('slugify: strips punctuation except hyphens', () => {
  assert.equal(slugify('My Great Note!'), 'my-great-note');
  assert.equal(slugify('Hello, World.'), 'hello-world');
  assert.equal(slugify('What? Really!'), 'what-really');
});

test('slugify: collapses multiple hyphens', () => {
  assert.equal(slugify('One  Two   Three'), 'one-two-three');
  assert.equal(slugify('dash--double'), 'dash-double');
});

test('slugify: trims leading and trailing hyphens', () => {
  assert.equal(slugify('!leading'), 'leading');
  assert.equal(slugify('trailing!'), 'trailing');
  assert.equal(slugify('!both!'), 'both');
});

test('slugify: preserves existing hyphens', () => {
  assert.equal(slugify('already-kebab-case'), 'already-kebab-case');
});

test('slugify: empty string returns "untitled" (non-Latin fallback applies)', () => {
  // After I3: empty result → 'untitled' as safe default.
  assert.equal(slugify(''), 'untitled');
});

test('slugify: unicode diacritics are stripped via NFD normalization (Naïve → naive)', () => {
  // NFD decomposes ï into i + combining diaeresis; stripping non-ASCII leaves "i"
  assert.equal(slugify('Naïve'), 'naive');
});

test('slugify: mixed unicode and ASCII', () => {
  assert.equal(slugify('Café au Lait'), 'cafe-au-lait');
});

test('slugify: numbers are preserved', () => {
  assert.equal(slugify('Version 2.0 Release'), 'version-20-release');
});

test('slugify: all-punctuation returns "untitled" (non-Latin fallback)', () => {
  assert.equal(slugify('!!! ???'), 'untitled');
});

test('slugify: tabs and newlines treated as whitespace', () => {
  assert.equal(slugify('line\tone\ntwo'), 'line-one-two');
});

// I3: non-Latin / non-ASCII fallback to "untitled"
test('slugify: CJK characters return "untitled"', () => {
  assert.equal(slugify('東京'), 'untitled');
});

test('slugify: emoji returns "untitled"', () => {
  assert.equal(slugify('😀'), 'untitled');
});

test('slugify: Arabic text returns "untitled"', () => {
  assert.equal(slugify('مرحبا'), 'untitled');
});

test('slugify: only-hyphens edge case returns "untitled"', () => {
  assert.equal(slugify('---'), 'untitled');
});

// C1: forward-slash vault path is accepted (not rejected as traversal)
test('C1: forward-slash UM_VAULT_DIR works on all platforms', async () => {
  // Create a real temp vault so readVaultFile can succeed
  const nativeVault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-fwdslash-'));
  const original = process.env.UM_VAULT_DIR;
  try {
    await fs.mkdir(path.join(nativeVault, 'notes'), { recursive: true });
    await fs.writeFile(path.join(nativeVault, 'notes', 'test.md'), '# test', 'utf8');

    // Supply the vault path with forward slashes (as would come from .env or docker-compose)
    const forwardSlash = nativeVault.replace(/\\/g, '/');
    process.env.UM_VAULT_DIR = forwardSlash;

    // Before C1 this would throw "Path traversal detected" on Windows;
    // after the fix it resolves correctly.
    const content = await readVaultFile('notes/test.md');
    assert.equal(content, '# test');
  } finally {
    await fs.rm(nativeVault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

// C2: listVaultFiles rejects traversal via subdir argument
test('C2: listVaultFiles("../outside") throws traversal error', async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-traverse-'));
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await assert.rejects(
      () => listVaultFiles('../outside'),
      (err) => /traversal|escape|outside/i.test(err.message)
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

// ---------------------------------------------------------------------------
// 6. Symlink hardening — listVaultFiles / findDocByIdInVault / writeVaultFile
// ---------------------------------------------------------------------------

/**
 * Create a "symlink-like" entry at linkPath for symlink-refusal testing.
 *
 * On Linux/macOS (and Windows with Developer Mode / admin) we create a real
 * file symlink pointing at fileTarget. On plain Windows (no elevated privilege)
 * creating a file symlink fails with EPERM, so we fall back to a directory
 * JUNCTION pointing at dirTarget.
 *
 * Junctions are NTFS reparse points that do NOT require
 * SeCreateSymbolicLinkPrivilege to create. Critically, Node reports them as
 * symlinks via `fs.lstat().isSymbolicLink() === true` and
 * `Dirent.isSymbolicLink() === true` — which is exactly the predicate the
 * vault library uses to decide whether to skip / refuse. So junction-based
 * testing exercises the same symlink-refusal code path as file-symlink-based
 * testing (see server/lib/vault.mjs walkDir and server/lib/vault-write.mjs
 * writeVaultFile), just via a different reparse-point subtype.
 *
 * Returns true on success, false only if the fallback also fails (which
 * shouldn't happen on any supported platform — report it via t.skip with
 * details if it does).
 *
 * @param {string} fileTarget - Absolute path to a file (symlink target on POSIX / Dev-Mode Windows).
 * @param {string} dirTarget  - Absolute path to a directory (junction target on Windows fallback).
 * @param {string} linkPath   - Absolute path where the link will be created.
 */
async function trySymlink(fileTarget, dirTarget, linkPath) {
  try {
    await fs.symlink(fileTarget, linkPath, 'file');
    return true;
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'UNKNOWN' && err.code !== 'ENOSYS') {
      throw err;
    }
    // Windows without Developer Mode: fall back to a directory junction.
    // Junctions require absolute paths to an existing directory.
    try {
      await fs.symlink(path.resolve(dirTarget), linkPath, 'junction');
      return true;
    } catch (junctionErr) {
      // Junctions should work on any NTFS volume without elevation.
      // If this fails too, something is genuinely wrong with the platform.
      process.stderr.write(
        `[trySymlink] file-symlink failed (${err.code}); junction fallback also failed (${junctionErr.code}): ${junctionErr.message}\n`
      );
      return false;
    }
  }
}

test('security: listVaultFiles skips symlinks; findDocByIdInVault returns null for symlinked id', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-symlink-list-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'um-symlink-out-'));
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;

    // Target file outside the vault (e.g. stand-in for /etc/passwd).
    const outsideFile = path.join(outside, 'secret.md');
    await fs.writeFile(outsideFile, '# secret', 'utf8');

    // A real file inside the vault.
    await writeFixture(vault, 'authored/proj/real.md', '# real');

    // A symlink inside the vault pointing outside. On Windows without
    // Developer Mode, trySymlink falls back to a directory junction pointing
    // at `outside`; Node reports junctions as symlinks via lstat(), so the
    // same skip-symlink code path is exercised.
    await fs.mkdir(path.join(vault, 'authored', 'proj'), { recursive: true });
    const linkPath = path.join(vault, 'authored', 'proj', 'fake.md');
    const created = await trySymlink(outsideFile, outside, linkPath);
    if (!created) {
      t.skip('neither file-symlink nor directory-junction creation permitted on this platform');
      return;
    }

    const files = await listVaultFiles('authored');
    assert.ok(
      files.some((p) => p.endsWith('real.md')),
      `real.md should be present: ${JSON.stringify(files)}`
    );
    assert.ok(
      !files.some((p) => p.endsWith('fake.md')),
      `fake.md (symlink) should be skipped: ${JSON.stringify(files)}`
    );

    const found = await findDocByIdInVault('fake');
    assert.equal(found, null, `findDocByIdInVault('fake') should return null, got: ${found}`);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('security: writeVaultFile refuses to write when target is a symlink', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-symlink-write-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'um-symlink-write-out-'));
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;

    const outsideFile = path.join(outside, 'secret.md');
    await fs.writeFile(outsideFile, '# original', 'utf8');

    // Create parent dir, then plant a symlink (or Windows junction fallback)
    // at the target path. Junctions lstat() as symlinks on Windows, so the
    // writeVaultFile refuse-on-symlink path fires either way.
    await fs.mkdir(path.join(vault, 'authored', 'proj'), { recursive: true });
    const linkPath = path.join(vault, 'authored', 'proj', 'fake.md');
    const created = await trySymlink(outsideFile, outside, linkPath);
    if (!created) {
      t.skip('neither file-symlink nor directory-junction creation permitted on this platform');
      return;
    }

    await assert.rejects(
      () => writeVaultFile('authored/proj/fake.md', '# new content'),
      (err) => /symlink/i.test(err.message)
    );

    // Outside file must be untouched.
    const outsideContent = await fs.readFile(outsideFile, 'utf8');
    assert.equal(outsideContent, '# original');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});
