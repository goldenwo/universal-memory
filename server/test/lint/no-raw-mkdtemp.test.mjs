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

// Two rules, two allowlists, deliberately not merged. A file that legitimately
// builds a never-created path in the temp root should NOT thereby get a blanket
// exemption from the mkdtemp rule as well — the coarse per-file exemption is
// how a lint quietly stops covering the file it is named after.
const MKDTEMP_ALLOWED = new Set([
  // The one legitimate mkdtemp in test code — it registers the cleanup.
  'server/test/helpers/tmpdir.mjs',
  // Negative control: leaks on purpose so the no-leak test can prove it detects leaks.
  'server/test/fixtures/tmpdir-leak-modes.fixture.mjs',
  // This file names the symbol it bans.
  'server/test/lint/no-raw-mkdtemp.test.mjs',
]);

// Reaching for the temp ROOT is banned too, because banning `mkdtemp` alone bans
// a spelling rather than the behaviour: `writeFile(join(tmpdir(), x))` creates
// real litter that the CI sweep counts (it counts FILES, not just dirs) while
// this lint stays green — which pointed the operator at helpers/tmpdir.mjs for a
// file the helper never created. Four eval call sites did exactly that until
// 2026-08-02.
//
// These are exempt because they build a path that is never created — each is a
// "this must NOT exist" seam, verified by the CI sweep staying clean.
const TMPDIR_ALLOWED = new Set([
  ...MKDTEMP_ALLOWED,
  // readCursor() on a deliberately absent cursor file.
  'server/test/bridge-contract.test.mjs',
  // UM_COUNTERS_DB_PATH pointed at a path the no-DB path must not create.
  'server/test/control-routes.test.mjs',
  'server/test/control-routes-security.test.mjs',
  // Named "…-does-not-exist.db" — the missing-DB seam.
  'server/test/stats-payload.test.mjs',
  // The temp root itself, as an "outside the vault" path for an escape test.
  'server/test/vault.test.mjs',
]);

// Call shape, not bare token. Prose can then name `mkdtemp` freely (it never has
// the open paren), which is why no comment-stripping is needed — and stripping
// was itself a hazard: a lexer-free /\*…\*/ regex lets a `/*` inside a string
// literal open a phantom comment that swallows a real call further down.
const RULES = [
  { re: /\bmkdtemp(Sync)?\s*\(/, allowed: MKDTEMP_ALLOWED, what: 'raw mkdtemp' },
  { re: /\btmpdir\s*\(\s*\)/, allowed: TMPDIR_ALLOWED, what: 'raw os.tmpdir()' },
];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') yield* walk(p); }
    else if (p.endsWith('.mjs')) yield p;
  }
}

test('no test file creates a temp dir without going through helpers/tmpdir.mjs', () => {
  const offenders = [];
  let scanned = 0;
  for (const root of SCAN) {
    for (const f of walk(root)) {
      const rel = f.replace(/\\/g, '/').slice(REPO_ROOT.replace(/\\/g, '/').length + 1);
      scanned += 1;
      const src = readFileSync(f, 'utf8');
      for (const { re, allowed, what } of RULES) {
        if (allowed.has(rel)) continue;
        if (re.test(src)) offenders.push(`${rel} (${what})`);
      }
    }
  }
  // A broken SCAN root or walk() would yield zero files, zero offenders, and a
  // green test that checked nothing — the same vacuity that let this file sit
  // unexecuted in CI for its whole life.
  assert.ok(scanned >= 100, `lint scanned only ${scanned} files — SCAN roots or walk() are broken`);
  assert.deepEqual(
    offenders,
    [],
    `temp-root access outside the helper found in: ${offenders.join(', ')}\n` +
    "Use `import { tempDir } from './helpers/tmpdir.mjs'` — it registers cleanup that survives test failure.\n" +
    'If the path is deliberately never created, add the file to TMPDIR_ALLOWED with the reason.',
  );
});
