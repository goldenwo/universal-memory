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

test('unset → the ephemeral /tmp default, not reported as a fallback', () => {
  const r = resolveHistoryDbPath({});
  assert.equal(r.path, EPHEMERAL_HISTORY_DB_PATH);
  assert.equal(r.fellBack, false);
});

test('a writable configured dir is used as is', () => {
  const dir = tmp();
  const want = path.join(dir, 'history.db');
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: want });
  assert.deepEqual([r.path, r.fellBack], [want, false]);
});

test('a missing but creatable dir is created and used', () => {
  const want = path.join(tmp(), 'nested', 'mem0', 'history.db');
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: want });
  assert.equal(r.path, want);
  assert.ok(fs.statSync(path.dirname(want)).isDirectory());
});

test('an uncreatable dir falls back to /tmp and says why', () => {
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: '/var/lib/mem0/history.db' }, denying('EACCES', 'mkdir'));
  assert.deepEqual([r.path, r.fellBack, r.reason, r.configured], [EPHEMERAL_HISTORY_DB_PATH, true, 'EACCES', '/var/lib/mem0/history.db']);
});

test('a dir the server cannot write (root-owned bind mount) falls back to /tmp', () => {
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: path.join(tmp(), 'history.db') }, denying('EACCES', 'access'));
  assert.deepEqual([r.path, r.fellBack, r.reason], [EPHEMERAL_HISTORY_DB_PATH, true, 'EACCES']);
});

test('an existing history file the server cannot write falls back to /tmp', () => {
  const r = resolveHistoryDbPath({ MEM0_HISTORY_DB_PATH: path.join(tmp(), 'history.db') }, denying('EACCES', 'file'));
  assert.deepEqual([r.path, r.fellBack], [EPHEMERAL_HISTORY_DB_PATH, true]);
});
