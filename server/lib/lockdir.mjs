// server/lib/lockdir.mjs
// Cross-process lock primitive using atomic mkdir.
// V4 verification (commit 3ae36ef) confirmed mkdir is atomic across bash + node
// on Windows NTFS, Linux, macOS. Safe for concurrent lockdir acquisition.
//
// Stale recovery with inode-compare guard (round-1 review):
//   stat → detect stale → re-stat before rmdir → if inode changed OR mtime
//   no longer stale, back off. This prevents rmdir'ing a freshly-acquired
//   lock that appeared in the race window.
//
// Low-disk threshold (spec §4.2.2 compound-failure):
//   below UM_LOCK_LOW_DISK_THRESHOLD available bytes, shorten stale-recovery
//   window from 10 min → 2 min so disk-pressure writes unstick faster.
//
// Process-exit cleanup:
//   SIGINT/SIGTERM/uncaughtException/exit handlers rmdir all HELD locks.
//   Without this, OOM-killed mid-handler leaves stale locks for 10 min.

import { mkdir, rmdir, stat } from 'node:fs/promises';
import { rmdirSync, statSync, statfsSync } from 'node:fs';

const HELD = new Set();
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_LOW_DISK_STALE_MS = 2 * 60_000;
const DEFAULT_LOW_DISK_BYTES = 100 * 1024 * 1024;

// Transient, RETRYABLE mkdir(2) failures (distinct from EEXIST = lock currently
// held). On Windows, mkdir racing the previous holder's rmdir returns
// EPERM/EACCES/EBUSY while the directory is pending-deletion or under a sharing
// scan (Defender/indexer) — the lockdir is momentarily unavailable, NOT fatally
// so. EMFILE/ENFILE = fd exhaustion under heavy concurrency — also transient
// (other processes release fds). Treating these as fatal (the old unconditional
// `throw e`) made acquireLockdir spuriously fail under concurrent churn — i.e.
// NOT flock-safe, which is exactly what append-turn.test.mjs "flock-safe under
// concurrent writes" guards. They are retried within timeoutMs like EEXIST
// contention — callers passing timeoutMs>0 (append-turn, bridge, raw checkpoint)
// ride out the hiccup. With the default timeoutMs:0, a single failure converts
// straight to a `false` return (the same fail-fast contract EEXIST contention
// already had), and a PERSISTENT one (real perms misconfig) likewise surfaces as
// `false`/timeout — no longer the old throw. Behavioral note: a caller that
// distinguished thrown-vs-`false` (checkpoint state.md, timeoutMs:0) now maps a
// transient FS hiccup to retryable contention (`checkpoint_in_progress`) instead
// of `lock_acquire_failed` — the correct signal for a momentary race; a truly
// persistent perms fault is caught earlier by the parent-dir mkdir. Any code NOT
// in this set and not EEXIST (ENOENT/ENOSPC/ENAMETOOLONG/EROFS…) is a real fault
// and still throws loud.
const RETRYABLE_MKDIR_ERRS = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']);

function availableBytes(path, statvfsStub) {
  if (statvfsStub) return Number(statvfsStub.bavail) * Number(statvfsStub.bsize);
  try {
    const st = statfsSync(path);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Infinity;  // couldn't query → treat as plenty
  }
}

export async function acquireLockdir(path, opts = {}) {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 0;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const lowDiskStaleMs = opts.lowDiskStaleMs ?? DEFAULT_LOW_DISK_STALE_MS;
  const lowDiskThresholdBytes = opts.lowDiskThresholdBytes ?? DEFAULT_LOW_DISK_BYTES;
  const doMkdir = opts.mkdirStub ?? mkdir;  // DI seam for transient-error tests (cf. statvfsStub)

  while (true) {
    try {
      await doMkdir(path);
      HELD.add(path);
      return true;
    } catch (e) {
      // EEXIST = lock currently held → stale-detection below. Transient
      // retryable mkdir errors (see RETRYABLE_MKDIR_ERRS) → skip stale
      // detection (the failure is an FS hiccup, not a held lock) and fall
      // straight to the bounded wait-or-bail tail. Anything else is fatal.
      if (e.code !== 'EEXIST' && !RETRYABLE_MKDIR_ERRS.has(e.code)) throw e;
      if (e.code === 'EEXIST') {
        // Detect stale with adaptive threshold
        const avail = availableBytes(path, opts.statvfsStub);
        const effectiveStaleMs = avail < lowDiskThresholdBytes ? lowDiskStaleMs : staleMs;
        try {
          const st = await stat(path);
          if (Date.now() - st.mtimeMs > effectiveStaleMs) {
            // Stale — recover with inode-compare guard
            try {
              const stPre = await stat(path);
              if (stPre.ino !== st.ino) continue;              // another owner took it
              if (Date.now() - stPre.mtimeMs <= effectiveStaleMs) continue;  // no longer stale
              await rmdir(path);
            } catch {}
            continue;
          }
        } catch {}
      }
      // Held-and-fresh (EEXIST) OR transient-retryable mkdir error — wait or
      // bail. Bounded by timeoutMs so a PERSISTENT EPERM/EACCES (real perms
      // misconfig) still surfaces as a timeout rather than hanging.
      if (Date.now() - start >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

export async function releaseLockdir(path) {
  try { await rmdir(path); } catch {}
  HELD.delete(path);
}

export function _resetHeldForTest() { HELD.clear(); }

// Process-exit cleanup — rmdir all HELD lockdirs on exit.
const cleanup = () => {
  for (const p of HELD) {
    try { statSync(p); rmdirSync(p); } catch {}
  }
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1); });
process.on('exit', cleanup);
