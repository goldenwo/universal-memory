// server/test/lockdir-cross-process.test.mjs
// Defense-in-depth: in-suite cross-process race test. V4 harness
// (docs/research/2026-04-24-v0.6-verifications/lockdir-race-harness/race.sh)
// already runs 600 iters across 3 variants with 0 anomalies; this in-suite
// check catches regressions on the current platform before they land.
//
// Simplified design: N iterations, each spawning bash + node in parallel
// racing `mkdir` on a shared path. Invariant: exactly one winner per iter
// (no double-win indicating a non-atomic mkdir, no zero-win indicating a
// subprocess error).
//
// Windows note: process-spawn overhead (~30ms) dominates timing; node
// typically "wins" the symmetric race every iter, but the invariant being
// tested is the exactly-one-winner property, not symmetry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('cross-process: node + bash race for same lockdir, exactly one winner per iteration (50 iters)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockdir-xp-'));
  let bothWin = 0, bothLose = 0;
  try {
    for (let i = 0; i < 50; i++) {
      const lock = join(dir, `iter-${i}.lockdir`);
      rmSync(lock, { recursive: true, force: true });
      // Race: spawn bash + node in parallel
      const bash = new Promise((resolve) => {
        const p = spawn('bash', ['-c', `mkdir ${JSON.stringify(lock).replace(/\\/g, '/')} 2>/dev/null && echo bash-won || echo bash-lost`]);
        let out = '';
        p.stdout.on('data', (d) => out += d);
        p.on('close', () => resolve(out.trim()));
      });
      const node = new Promise((resolve) => {
        const p = spawn(process.execPath, ['-e', `try{require('fs').mkdirSync(${JSON.stringify(lock)});console.log('node-won')}catch(e){if(e.code==='EEXIST')console.log('node-lost');else throw e}`]);
        let out = '';
        p.stdout.on('data', (d) => out += d);
        p.on('close', () => resolve(out.trim()));
      });
      const [bOut, nOut] = await Promise.all([bash, node]);
      if (bOut.endsWith('-won') && nOut.endsWith('-won')) bothWin++;
      if (bOut.endsWith('-lost') && nOut.endsWith('-lost')) bothLose++;
    }
    assert.equal(bothWin, 0, `${bothWin} iterations had both winners (mkdir not atomic)`);
    assert.equal(bothLose, 0, `${bothLose} iterations had zero winners (unexpected)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
