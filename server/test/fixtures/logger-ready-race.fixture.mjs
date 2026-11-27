// Fixture driven by server/test/logger-transport-exit.test.mjs — NOT a suite member.
// Named `.fixture.mjs` so the `test/**/*.test.mjs` discovery glob skips it.
//
// It logs through the PRODUCTION logger path (the async pino/file worker
// transport) and then simply stops: nothing here calls process.exit(). A
// healthy transport lets the process end on its own.
//
// The steps below replay, in a fixed order, the interleaving that used to
// happen by chance when the main thread was busy while the transport worker
// started (pinojs/thread-stream#250). Only stdio and event-loop ordering are
// used; no pino or thread-stream internals are touched.
//
//   F0   flush the big first line into the shared buffer.
//   ---  main thread blocks on stdin. The worker starts, announces READY,
//        takes its first read of the buffer (it sees F0 only) and stalls
//        writing it, because the parent is not reading our stdout yet. The
//        parent releases stdin once the first stdout bytes arrive.
//   Fa   flush 'second'  — after the worker's read, before READY is handled.
//   ---  READY is handled: "ready" now waits for the worker to reach Fa.
//   Fb   flush 'third'   — before the worker reads again.
//   ---  'armed' on stderr; the parent drains stdout; the worker's next read
//        goes straight from F0 to Fb.
//
// A transport that waits for the worker to land exactly on Fa never becomes
// ready, never unrefs its worker, and this process never exits.
import { readSync, writeSync } from 'node:fs';
import { getLogger } from '../../lib/logger.mjs';

const PAD_BYTES = Number(process.env.UM_READY_RACE_PAD_BYTES);
if (!Number.isInteger(PAD_BYTES) || PAD_BYTES <= 0) {
  throw new Error('UM_READY_RACE_PAD_BYTES must be a positive integer');
}

// Blocks the main thread (no event-loop turns) until the parent writes to, or
// closes, our stdin.
function blockUntilReleased() {
  const byte = Buffer.alloc(1);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      readSync(0, byte, 0, 1, null);
      return;
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err;
      Atomics.wait(nap, 0, 0, 5);
    }
  }
}

// Built before the logger exists so the main thread reaches the block well
// before the worker thread has finished starting.
const pad = 'x'.repeat(PAD_BYTES);

const log = getLogger();
// Message-only on purpose: the censor walks fields, not the message string, so
// this line costs about 10 ms of main-thread time instead of about 25.
log.info(pad); // queues F0

setImmediate(() => {
  // F0 has just run. Queue the block first and log 'second' after it, so the
  // next turn runs [block, Fa] back to back with no message handling between.
  setImmediate(() => {
    blockUntilReleased();
    // READY is handled on the next turn. One spare turn, then 'third'.
    setImmediate(() => {
      setImmediate(() => {
        log.info('ready-race third'); // queues Fb
        setImmediate(() => {
          writeSync(2, 'armed\n');
        });
      });
    });
  });
  log.info('ready-race second'); // queues Fa behind the block
});
