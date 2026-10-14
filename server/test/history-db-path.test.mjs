// Where mem0's history DB (and um-counters.db next to it) lives, and what the
// server does when that place is not writable. Found by the 2026-10-14
// clean-room install: a default install kept both files in /tmp, so the
// capture counters and reaction ledger reset on every restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHistoryDbPath, EPHEMERAL_HISTORY_DB_PATH } from '../lib/history-db-path.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

const tmp = () => tempDir('um-history-');
const denying = (code, which) => ({
  mkdirSync: (...a) => { if (which === 'mkdir') throw Object.assign(new Error(code), { code }); return fs.mkdirSync(...a); },
  accessSync: (p, m) => { if (which === 'access' || (which === 'file' && p.endsWith('.db'))) throw Object.assign(new Error(code), { code }); return fs.accessSync(p, m); },
  existsSync: (p) => (which === 'file' && p.endsWith('.db')) || fs.existsSync(p),
});
const noMount = () => path.join(tmp(), 'not-mounted');

test('unset, no /var/lib/mem0 mount → the old /tmp default, not reported as a fallback', () => {
  const r = resolveHistoryDbPath({}, fs, noMount());
  assert.deepEqual([r.path, r.fellBack], [EPHEMERAL_HISTORY_DB_PATH, false]);
});

test('unset, a writable mount → history.db on the mount', () => {
  const mount = tmp();
  const r = resolveHistoryDbPath({}, fs, mount);
  assert.deepEqual([r.path, r.fellBack], [path.join(mount, 'history.db'), false]);
});

test('unset, a mount the server cannot write (Docker-created, root-owned) → /tmp, reported', () => {
  const mount = tmp();
  const r = resolveHistoryDbPath({}, denying('EACCES', 'access'), mount);
  assert.deepEqual([r.path, r.fellBack, r.reason, r.configured], [EPHEMERAL_HISTORY_DB_PATH, true, 'EACCES', path.join(mount, 'history.db')]);
});

test('a writable configured path is used as is, mount or not', () => {
  const want = path.join(tmp(), 'history.db');
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: want }, fs, tmp());
  assert.deepEqual([r.path, r.fellBack], [want, false]);
});

test('a configured path in a missing but creatable dir is created and used', () => {
  const want = path.join(tmp(), 'nested', 'mem0', 'history.db');
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: want }, fs, noMount());
  assert.equal(r.path, want);
  assert.ok(fs.statSync(path.dirname(want)).isDirectory());
});

test('a configured path in an uncreatable dir falls back to /tmp and says why', () => {
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: '/var/lib/mem0/history.db' }, denying('EACCES', 'mkdir'), noMount());
  assert.deepEqual([r.path, r.fellBack, r.reason, r.configured], [EPHEMERAL_HISTORY_DB_PATH, true, 'EACCES', '/var/lib/mem0/history.db']);
});

test('an existing history file the server cannot write falls back to /tmp', () => {
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: path.join(tmp(), 'history.db') }, denying('EACCES', 'file'), noMount());
  assert.deepEqual([r.path, r.fellBack], [EPHEMERAL_HISTORY_DB_PATH, true]);
});
