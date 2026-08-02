// server/test/lint/no-raw-mkdtemp.test.mjs
// Temp-dir leak invariant: `server/test/helpers/tmpdir.mjs` is the SOLE place a
// test may create a temp dir. A bare mkdtemp arranges no cleanup, and that is
// exactly how ~82,000 abandoned `um-*` dirs accumulated on a dev box between
// April and August 2026 (90% of everything in TMPDIR).
//
// The runtime half of this guarantee — that the helper cleans up even when a
// test fails — lives in test/tmpdir-no-leak.test.mjs. This file covers the
// other half: that nothing bypasses the helper in the first place. A new
// leaking call site is otherwise invisible until the temp dir is next measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN = [join(REPO_ROOT, 'server', 'test'), join(REPO_ROOT, 'cli', 'test')];

const ALLOWED = new Set([
  // The one legitimate mkdtemp in test code — it registers the cleanup.
  'server/test/helpers/tmpdir.mjs',
  // Negative control: leaks on purpose so the no-leak test can prove it detects leaks.
  'server/test/fixtures/tmpdir-leak-modes.fixture.mjs',
  // This file names the symbol it bans.
  'server/test/lint/no-raw-mkdtemp.test.mjs',
]);

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') yield* walk(p); }
    else if (p.endsWith('.mjs')) yield p;
  }
}

// Prose in a header comment is not a call site; strip comments before matching
// so documentation can still name the thing it is telling you not to use.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('no test file creates a temp dir without going through helpers/tmpdir.mjs', () => {
  const offenders = [];
  for (const root of SCAN) {
    for (const f of walk(root)) {
      const rel = f.replace(/\\/g, '/').slice(REPO_ROOT.replace(/\\/g, '/').length + 1);
      if (ALLOWED.has(rel)) continue;
      if (/\bmkdtemp(Sync)?\b/.test(stripComments(readFileSync(f, 'utf8')))) offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `raw mkdtemp found in: ${offenders.join(', ')}\n` +
    "Use `import { tempDir } from './helpers/tmpdir.mjs'` — it registers cleanup that survives test failure.",
  );
});
