// server/test/logger-transport-exit.test.mjs
//
// The production logger writes through a worker-thread transport. A process
// that logs while that worker is still starting must still be able to end on
// its own afterwards: the transport has to reach "ready" and unref its worker.
//
// thread-stream 4.2.0 (pulled in by pino 10) could miss that under a busy main
// thread and hold the process open forever (pinojs/thread-stream#250, fixed in
// 4.2.1). That is what hung the unit-test step in CI on the first pino 10
// attempt (#369). The fixture replays the interleaving in a fixed order; see
// its header for the steps.
//
// One thing this test cannot see: the replay needs the child's main thread to
// reach its blocking read before the worker thread has finished starting
// (about 10 ms against a thread start plus module load). If the worker ever
// won, the steps would run in the harmless order and the test would pass
// without exercising the race. It can only miss a broken transport that way,
// never fail a healthy one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'logger-ready-race.fixture.mjs');

// The first log line has to be larger than everything that can sit between the
// worker and a parent that is not reading (socket buffers plus the parent's
// stream buffer, well under 1 MB by default), and smaller than the transport's
// 4 MB shared buffer.
const PAD_BYTES = 2 * 1024 * 1024;

// A stuck transport never recovers, so these only separate "slow" from "never".
const ARM_DEADLINE_MS = 30_000;
const EXIT_DEADLINE_MS = 20_000;

function runFixture() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, UM_READY_RACE_PAD_BYTES: String(PAD_BYTES), UM_LOG_LEVEL: 'info' };
    // Either of these selects the synchronous test logger, which has no worker.
    delete env.UM_LOG_TEST;
    delete env.NODE_ENV;

    const child = spawn(process.execPath, [FIXTURE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const result = { armed: false, timedOut: null, stdoutBytes: 0, stdoutTail: '', stderr: '' };

    let timer = setTimeout(() => {
      result.timedOut = 'before-armed';
      child.kill('SIGKILL');
    }, ARM_DEADLINE_MS);

    let released = false;
    child.stdout.on('data', (chunk) => {
      result.stdoutBytes += chunk.length;
      result.stdoutTail = (result.stdoutTail + chunk.toString('latin1')).slice(-512);
      if (!released) {
        // First bytes: the worker has read the buffer and is writing. Stop
        // reading so it stalls there, then let the child's main thread go on.
        released = true;
        child.stdout.pause();
        child.stdin.end('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      result.stderr += chunk;
      if (!result.armed && result.stderr.includes('armed\n')) {
        result.armed = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          result.timedOut = 'after-armed';
          child.kill('SIGKILL');
        }, EXIT_DEADLINE_MS);
        child.stdout.resume();
      }
    });

    child.stdin.on('error', () => {}); // child gone before the release byte; 'close' reports it
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ...result, code, signal });
    });
  });
}

test('a process that logged while the transport worker was starting still exits on its own', async () => {
  const r = await runFixture();
  const seen = `stdout ${r.stdoutBytes} bytes, stderr: ${JSON.stringify(r.stderr.slice(0, 400))}`;

  assert.equal(r.armed, true, `the fixture never finished its steps (exit ${r.code}, signal ${r.signal}); ${seen}`);
  assert.equal(
    r.timedOut,
    null,
    `the child wrote its last log line and was still alive ${EXIT_DEADLINE_MS} ms later: `
      + `the transport worker never became ready, so it was never unref'd; ${seen}`,
  );
  assert.equal(r.code, 0, `child exit code; ${seen}`);
  assert.ok(r.stdoutBytes > PAD_BYTES, `the big first line should have been delivered; ${seen}`);
  assert.match(r.stdoutTail, /"msg":"ready-race third"/, 'the last log line should have been delivered before exit');
});
