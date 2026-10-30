// server/test/lint/checked-knobs-one-reader.test.mjs — every checked knob is read only
// through lib/checked-knobs.mjs.
//
// Boot refuses a malformed checked knob (validateNumericKnobs) by the table's parse. A module
// that reads the same variable with its own rule (parseInt, a different default) recreates
// the silent fallback the boot check exists to stop, so outside checked-knobs.mjs no server
// or CLI module may name a checked knob except as the first argument of checkedKnob( or
// requireCheckedKnob(. Eval harnesses and tests are out of scope.

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

const NAMES = Object.keys(CHECKED_KNOBS).join('|');
// env.NAME, env?.NAME, env['NAME'], env?.['NAME'] — on any object called env.
const DIRECT = new RegExp(
  `\\benv(?:\\??\\.(?:${NAMES})\\b|(?:\\?\\.)?\\[\\s*['"\`](?:${NAMES})['"\`]\\s*\\])`);
// const { NAME } = process.env / = env
const DESTRUCTURE = new RegExp(`\\{[^}]*\\b(?:${NAMES})\\b[^}]*\\}\\s*=\\s*(?:process\\.)?env\\b`);
// A quoted knob name anywhere (envInt('NAME', ...), { envName: 'NAME' }, process.env[k] with k
// assigned 'NAME', ...) unless it is the first argument of checkedKnob( / requireCheckedKnob(.
const QUOTED = new RegExp(`['"\`](?:${NAMES})['"\`]`, 'g');
const ALLOWED_CALL = /\b(?:checkedKnob|requireCheckedKnob)\(\s*$/;

/** The offending reads on one line of code (comment lines are skipped). */
function offendersIn(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return [];
  const hits = [];
  if (DIRECT.test(line)) hits.push('direct env read');
  if (DESTRUCTURE.test(line)) hits.push('destructured from env');
  for (const m of line.matchAll(QUOTED)) {
    if (!ALLOWED_CALL.test(line.slice(0, m.index))) hits.push(`quoted name ${m[0]}`);
  }
  return hits;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('no module reads a checked knob except through checked-knobs.mjs', () => {
  const offenders = [];
  for (const file of [...TOP, ...ROOTS.flatMap((d) => walk(d))]) {
    if (file === OWNER) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const why of offendersIn(line)) offenders.push(`${relative(REPO, file)}:${i + 1}: ${why}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'read these through checked-knobs.mjs: checkedKnob in the server (boot has validated them), '
    + 'requireCheckedKnob in code that runs without the boot check (a CLI)');
});

// The scan's own matcher must fire on the shapes a reader is likely to write, and stay quiet
// on the allowed calls and on comments.
test('the scan catches the likely direct reads (positive control)', () => {
  // Each shape with the rule that must catch it, so a rule that goes dead is noticed even
  // when another rule still flags the line.
  const caught = [
    ["const p = parseInt(process.env.QDRANT_PORT || '6333', 10);", 'direct env read'],
    ["const p = env['MEM0_MCP_PORT'];", 'direct env read'],
    ["const p = process.env['QDRANT_PORT'];", 'direct env read'],
    ['const p = env?.QDRANT_PORT;', 'direct env read'],
    ["const p = env?.['QDRANT_PORT'];", 'direct env read'],
    ["function retentionDays() { return envInt('UM_CAPTURE_LEDGER_RETENTION_DAYS', 30); }", 'quoted name'],
    ["resolvePositiveInt({ envName: 'UM_HTTP_MAX_REQUEST_BYTES', fallback: 1 });", 'quoted name'],
    ['const { QDRANT_PORT } = process.env;', 'destructured from env'],
  ];
  for (const [line, rule] of caught) {
    assert.ok(offendersIn(line).some((why) => why.startsWith(rule)), `${rule}: ${line}`);
  }
  const quiet = [
    "const port = checkedKnob('MEM0_MCP_PORT');",
    "port: requireCheckedKnob('QDRANT_PORT', env),",
    "// QDRANT_PORT (6333) is read by checkedKnob('QDRANT_PORT')",
  ];
  for (const line of quiet) assert.deepEqual(offendersIn(line), [], line);
});
