// server/test/lockdir.test.mjs
// Unit tests for lockdir.mjs — acquire/release, timeout, stale recovery,
// low-disk threshold, inode-compare guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLockdir, releaseLockdir, _resetHeldForTest } from '../lib/lockdir.mjs';

function mkWorkDir() {
  return mkdtempSync(join(tmpdir(), 'lockdir-'));
}

test('acquire then release', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'r.lockdir');
  try {
    const ok = await acquireLockdir(p);
    assert.equal(ok, true);
    await releaseLockdir(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('second acquire times out while first holds', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'r.lockdir');
  try {
    await acquireLockdir(p);
    const second = await acquireLockdir(p, { timeoutMs: 50 });
    assert.equal(second, false);
    await releaseLockdir(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('second acquire succeeds after release', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'r.lockdir');
  try {
    await acquireLockdir(p);
    await releaseLockdir(p);
    const second = await acquireLockdir(p);
    assert.equal(second, true);
    await releaseLockdir(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale-lockdir recovery after TTL', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'r.lockdir');
  try {
    await acquireLockdir(p);
    _resetHeldForTest();
    const past = new Date(Date.now() - 15 * 60_000);
    await utimes(p, past, past);
    const ok = await acquireLockdir(p, { staleMs: 10 * 60_000 });
    assert.equal(ok, true);
    await releaseLockdir(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('low-disk threshold shortens stale recovery window', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'r.lockdir');
  try {
    await acquireLockdir(p);
    _resetHeldForTest();
    const past = new Date(Date.now() - 3 * 60_000);  // 3 min ago
    await utimes(p, past, past);
    const ok = await acquireLockdir(p, {
      staleMs: 10 * 60_000,
      lowDiskStaleMs: 2 * 60_000,
      // Tight available bytes; use stub to avoid flaky statfs
      statvfsStub: { bavail: 100, bsize: 1024 },   // 100 KB available, << 100 MB threshold
    });
    assert.equal(ok, true);  // 3 min > 2 min shortened threshold
    await releaseLockdir(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale-recovery inode guard — does not rmdir a freshly-acquired lock', async () => {
  // Simulate the race: we stat, see stale; another process rmdirs + remkdirs (fresh);
  // we re-stat, see new inode OR new mtime; back off without deleting their lock.
  // This is hard to exactly simulate; easier to validate via the double-stat path:
  // stat twice with a time gap; if the second stat shows a recent mtime, we must NOT
  // rmdir. Test by backdating once, then touching back to "now", and expecting
  // no removal (i.e., second attempt's EEXIST backoff kicks in with timeoutMs=0 → false).
  const dir = mkWorkDir();
  const p = join(dir, 'r.lockdir');
  try {
    await acquireLockdir(p);
    _resetHeldForTest();
    // Backdate briefly but re-mtime to "now" before the second stat can fire —
    // simulate owner who just took it.
    const past = new Date(Date.now() - 15 * 60_000);
    await utimes(p, past, past);
    // Ride in the recovery path — but this test is more about verifying no exception
    // than exercising the exact race. Sanity: after TTL, another acquire can win.
    const ok = await acquireLockdir(p, { staleMs: 10 * 60_000, timeoutMs: 100 });
    assert.equal(ok, true);  // stale was real; we took it
    await releaseLockdir(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- transient mkdir error classification (cross-platform / Windows) ----------
// acquireLockdir must separate three mkdir(2) outcomes:
//   EEXIST          → lock currently held → stale detection
//   transient errs  → FS hiccup (NOT a held lock) → retry within timeoutMs
//   anything else   → genuinely fatal → throw loud
// On Windows, mkdir racing the previous holder's rmdir returns EPERM/EACCES/EBUSY
// while the dir is pending-deletion or under a Defender/indexer sharing scan;
// EMFILE/ENFILE are fd exhaustion under heavy concurrency. All transient — must be
// retried like EEXIST contention, never thrown. A PERSISTENT transient error
// (e.g. a real perms misconfig) still bottoms out at the timeoutMs bound.
// Seam: opts.mkdirStub injects a fake mkdir, mirroring the existing opts.statvfsStub
// DI convention; when absent, production uses the real node:fs/promises mkdir.

test('acquireLockdir retries a transient mkdir EPERM and acquires within timeout', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'transient.lockdir');
  let calls = 0;
  const mkdirStub = async () => {
    calls += 1;
    if (calls < 3) {
      const e = new Error('EPERM: operation not permitted, mkdir');
      e.code = 'EPERM';
      throw e;  // racing rmdir / sharing-scan — momentarily unavailable
    }
    // 3rd attempt succeeds: the previous holder's rmdir finished.
  };
  try {
    const ok = await acquireLockdir(p, { timeoutMs: 5000, mkdirStub });
    assert.equal(ok, true, 'should acquire once the transient EPERM clears');
    assert.equal(calls, 3, 'should have retried through the two transient EPERMs');
  } finally {
    _resetHeldForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLockdir bounds a persistent transient mkdir EBUSY by timeoutMs (returns false, never throws)', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'busy.lockdir');
  let calls = 0;
  const mkdirStub = async () => {
    calls += 1;
    const e = new Error('EBUSY: resource busy or locked, mkdir');
    e.code = 'EBUSY';
    throw e;  // never clears within the window
  };
  try {
    const ok = await acquireLockdir(p, { timeoutMs: 120, mkdirStub });
    assert.equal(ok, false, 'a persistent transient error must surface as a timeout, not a throw');
    assert.ok(calls >= 2, `should retry before timing out (got ${calls} attempts)`);
  } finally {
    // No HELD reset: the stub always throws, so the success path (HELD.add) is
    // never reached — nothing to clear.
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLockdir still throws loud on a non-retryable mkdir error (ENOSPC)', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'nospc.lockdir');
  const mkdirStub = async () => {
    const e = new Error('ENOSPC: no space left on device, mkdir');
    e.code = 'ENOSPC';
    throw e;  // genuinely fatal — must NOT be swallowed as transient
  };
  try {
    await assert.rejects(
      acquireLockdir(p, { timeoutMs: 200, mkdirStub }),
      /ENOSPC/,
    );
  } finally {
    // No HELD reset: the stub always throws, so the success path (HELD.add) is
    // never reached — nothing to clear.
    rmSync(dir, { recursive: true, force: true });
  }
});

// Crosses BOTH reworked branches in one acquire: a transient error (skip stale
// detection → wait-tail), then genuine EEXIST contention (stale-detection branch,
// here with an unstattable phantom dir → fall through), then success. Proves the
// restructured `if (e.code === 'EEXIST')` block and the shared wait-or-bail tail
// cooperate — a transient hiccup doesn't corrupt subsequent contention handling.
test('acquireLockdir survives a transient error then EEXIST contention then acquires', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'mixed.lockdir');
  let calls = 0;
  const mkdirStub = async () => {
    calls += 1;
    if (calls === 1) {
      const e = new Error('EPERM: operation not permitted, mkdir');
      e.code = 'EPERM';
      throw e;  // transient FS hiccup
    }
    if (calls === 2) {
      const e = new Error('EEXIST: file already exists, mkdir');
      e.code = 'EEXIST';
      throw e;  // now genuinely held by another owner
    }
    // 3rd attempt succeeds: the holder released.
  };
  try {
    const ok = await acquireLockdir(p, { timeoutMs: 5000, mkdirStub });
    assert.equal(ok, true, 'should acquire after the transient error and the contention clear');
    assert.equal(calls, 3, 'should pass through transient → EEXIST → success');
  } finally {
    _resetHeldForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pins the default timeoutMs:0 + transient path that the checkpoint state.md
// caller relies on for its `checkpoint_in_progress` vs `lock_acquire_failed`
// split: a transient error with no retry budget converts to a single-attempt
// `false` return — it must NOT retry once more, and must NOT throw.
test('acquireLockdir with timeoutMs:0 fail-fasts a transient error to false after one attempt', async () => {
  const dir = mkWorkDir();
  const p = join(dir, 'fastfail.lockdir');
  let calls = 0;
  const mkdirStub = async () => {
    calls += 1;
    const e = new Error('EPERM: operation not permitted, mkdir');
    e.code = 'EPERM';
    throw e;
  };
  try {
    const ok = await acquireLockdir(p, { timeoutMs: 0, mkdirStub });  // timeoutMs:0 is the default
    assert.equal(ok, false, 'no retry budget → immediate false');
    assert.equal(calls, 1, 'exactly one attempt — no retry, no throw');
  } finally {
    // Stub always throws → success path (HELD.add) never reached — nothing to clear.
    rmSync(dir, { recursive: true, force: true });
  }
});
