// server/test/lint/checked-knobs-one-reader.test.mjs — every checked knob is read only
// through lib/checked-knobs.mjs.
//
// Boot refuses a malformed checked knob (validateNumericKnobs) by the table's parse. A module
// that reads the same variable with its own rule (parseInt, a different default) recreates
// the silent fallback the boot check exists to stop, so no server or CLI module may read a
// checked knob from the environment directly. Eval harnesses and tests are out of scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKED_KNOBS } from '../../lib/checked-knobs.mjs';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const REPO = join(SERVER, '..');
const ROOTS = [join(SERVER, 'lib'), join(SERVER, 'bin'), join(REPO, 'cli')];
const TOP = readdirSync(SERVER).filter((f) => f.endsWith('.mjs')).map((f) => join(SERVER, f));
const OWNER = join(SERVER, 'lib', 'checked-knobs.mjs');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('no module reads a checked knob from the environment except checked-knobs.mjs', () => {
  const names = Object.keys(CHECKED_KNOBS).join('|');
  const direct = new RegExp(`\\benv(?:\\.(?:${names})\\b|\\[\\s*['"\`](?:${names})['"\`]\\s*\\])`);
  const offenders = [];
  for (const file of [...TOP, ...ROOTS.flatMap((d) => walk(d))]) {
    if (file === OWNER) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (direct.test(line)) offenders.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'read these through checked-knobs.mjs: checkedKnob in the server (boot has validated them), '
    + 'requireCheckedKnob in code that runs without the boot check (a CLI)');
});

// The scan must be able to fire: a line that reads a knob directly is caught.
test('the scan catches a direct read (positive control)', () => {
  const names = Object.keys(CHECKED_KNOBS).join('|');
  const direct = new RegExp(`\\benv(?:\\.(?:${names})\\b|\\[\\s*['"\`](?:${names})['"\`]\\s*\\])`);
  assert.ok(direct.test("const p = parseInt(process.env.QDRANT_PORT || '6333', 10);"));
  assert.ok(direct.test("const p = env['MEM0_MCP_PORT'];"));
  assert.ok(!direct.test('// QDRANT_PORT (6333) is read by checkedKnob'));
});
