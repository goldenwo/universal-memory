/**
 * vault-nofollow.test.mjs — kernel-level O_NOFOLLOW symlink-swap defense (B.12)
 *
 * The pre-existing tests in vault.test.mjs cover the lstat-based refusal layer
 * (which also passes on Windows via NTFS junctions). Those tests verify that a
 * symlink already at the target is detected and rejected before any write
 * happens.
 *
 * This file adds the kernel-level layer: even if an attacker wins the
 * lstat→open race (replaces the path with a symlink between the lstat check
 * and the open() syscall), O_NOFOLLOW makes open() refuse to follow the
 * symlink — the syscall returns ELOOP and the attacker's redirection fails.
 *
 * Windows note: constants.O_NOFOLLOW is undefined on Windows (NTFS has a
 * different threat model — symlink creation requires
 * SeCreateSymbolicLinkPrivilege). vault-write.mjs coerces NOFOLLOW to 0 on
 * Windows, so writes still work. The Windows-specific TOCTOU window is a
 * v0.7 hardening item; the existing junction-based tests in vault.test.mjs
 * already cover the lstat-refusal layer cross-platform.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeVaultFile } from '../lib/vault-write.mjs';

test('writeVaultFile with O_NOFOLLOW rejects symlink at the .tmp path', { skip: process.platform === 'win32' }, async () => {
  // POSIX-only: file symlink creation requires admin/Developer Mode on Windows,
  // and constants.O_NOFOLLOW is undefined on Windows (coerced to 0; no-op).
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-nofollow-vault-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'um-nofollow-out-'));
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;

    // Pre-existing file outside the vault — the attacker's redirection target.
    const outsideTarget = path.join(outside, 'outside.txt');
    await fs.writeFile(outsideTarget, 'pre-existing-outside-data', 'utf8');

    // Plant a symlink at the .tmp path that writeVaultFile will write to.
    // writeVaultFile uses '<abs>.tmp' as its scratch path; if that's a symlink
    // to outside.txt, an unprotected open(O_WRONLY|O_CREAT|O_TRUNC) would
    // follow it and overwrite outside.txt. With O_NOFOLLOW the open() syscall
    // refuses with ELOOP.
    const subdir = path.join(vault, 'authored', 'proj');
    await fs.mkdir(subdir, { recursive: true });
    const tmpLinkPath = path.join(subdir, 'target.md.tmp');
    await fs.symlink(outsideTarget, tmpLinkPath, 'file');

    let err;
    try {
      await writeVaultFile('authored/proj/target.md', '---\nid: test\n---\nbody');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'writeVaultFile must throw when the .tmp path is a symlink');
    assert.ok(
      err.code === 'ELOOP' || /symlink|ELOOP/i.test(err.message),
      `expected ELOOP or symlink-related error, got: code=${err.code} msg=${err.message}`
    );

    // Verify the outside target was NOT modified — O_NOFOLLOW prevented the
    // write from following the symlink to the attacker-chosen path.
    const outsideContent = readFileSync(outsideTarget, 'utf8');
    assert.equal(
      outsideContent,
      'pre-existing-outside-data',
      'outside file must remain unchanged — O_NOFOLLOW prevented the write'
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('writeVaultFile to a non-symlink path succeeds normally (cross-platform)', async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-nofollow-ok-'));
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeVaultFile('authored/proj/normal.md', '---\nid: ok\n---\nbody');
    const content = readFileSync(path.join(vault, 'authored', 'proj', 'normal.md'), 'utf8');
    assert.match(content, /id: ok/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});

test('writeVaultFile overwriting an existing regular file succeeds (no symlink)', async () => {
  // Sanity check: O_NOFOLLOW must not break the legitimate "rewrite an
  // existing file" path. Only symlink-typed entries should be refused.
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'um-nofollow-rewrite-'));
  const original = process.env.UM_VAULT_DIR;
  try {
    process.env.UM_VAULT_DIR = vault;
    await writeVaultFile('authored/proj/note.md', 'first');
    await writeVaultFile('authored/proj/note.md', 'second');
    const content = readFileSync(path.join(vault, 'authored', 'proj', 'note.md'), 'utf8');
    assert.equal(content, 'second');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    if (original === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = original;
  }
});
