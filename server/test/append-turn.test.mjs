// server/test/append-turn.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { doAppendTurn } from '../lib/append-turn.mjs';
import { handleAppendTurnRequest } from '../mem0-mcp-http.mjs';

function mockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.jsonBody = obj; return this; },
  };
  return res;
}

async function makeTempVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'um-append-'));
  await fs.mkdir(path.join(dir, 'captures'), { recursive: true });
  return dir;
}

// ---------- core write ----------

test('doAppendTurn writes to captures/<project>/raw/<date>.md', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'test-proj',
    content: 'Hello from unit test',
    role: 'user',
  }, { vaultDir: vault, clock: () => new Date('2026-04-22T12:00:00Z') });

  assert.equal(result.ok, true);
  assert.match(result.path, /^captures\/test-proj\/raw\/2026-04-22\.md$/);
  assert.equal(result.appended, true);

  const on_disk = await fs.readFile(path.join(vault, result.path), 'utf8');
  assert.match(on_disk, /user/);
  assert.match(on_disk, /Hello from unit test/);
});

// ---------- validation ----------

test('doAppendTurn rejects invalid project slug', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: '../evil',
    content: 'payload',
    role: 'user',
  }, { vaultDir: vault });

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid project/i);
});

test('doAppendTurn requires role', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'p',
    content: 'c',
    // role omitted
  }, { vaultDir: vault });
  assert.equal(result.ok, false);
  assert.match(result.error, /role.*required/i);
});

test('doAppendTurn enforces 8192-char content cap', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'p',
    content: 'x'.repeat(8193),
    role: 'user',
  }, { vaultDir: vault });
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds/i);
});

// ---------- role enum ----------

test('doAppendTurn accepts role=assistant', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'p',
    content: 'assistant reply',
    role: 'assistant',
  }, { vaultDir: vault });
  assert.equal(result.ok, true);
  const on_disk = await fs.readFile(path.join(vault, result.path), 'utf8');
  assert.match(on_disk, /assistant/);
});

test('doAppendTurn accepts role=system', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'p',
    content: 'system prompt',
    role: 'system',
  }, { vaultDir: vault });
  assert.equal(result.ok, true);
  const on_disk = await fs.readFile(path.join(vault, result.path), 'utf8');
  assert.match(on_disk, /system/);
});

test('doAppendTurn rejects unknown role', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'p',
    content: 'c',
    role: 'bot',
  }, { vaultDir: vault });
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid role/i);
});

// ---------- timestamp + conversation_id ----------

test('doAppendTurn honors explicit timestamp arg', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'ts-proj',
    content: 'explicit ts',
    role: 'user',
    timestamp: '2025-01-15T08:30:00Z',
  }, { vaultDir: vault });
  assert.equal(result.ok, true);
  assert.match(result.path, /2025-01-15\.md$/);
  const on_disk = await fs.readFile(path.join(vault, result.path), 'utf8');
  assert.match(on_disk, /2025-01-15T08:30:00\.000Z/);
});

test('doAppendTurn stores conversation_id in turn header', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'cid-proj',
    content: 'with cid',
    role: 'user',
    conversation_id: 'conv-abc-123',
  }, { vaultDir: vault });
  assert.equal(result.ok, true);
  const on_disk = await fs.readFile(path.join(vault, result.path), 'utf8');
  assert.match(on_disk, /conversation_id: conv-abc-123/);
});

// ---------- bytes_written ----------

test('doAppendTurn returns correct bytes_written', async () => {
  const vault = await makeTempVault();
  const content = 'count my bytes';
  const ts = '2026-04-22T09:00:00.000Z';
  const result = await doAppendTurn({
    project: 'bytes-proj',
    content,
    role: 'user',
    timestamp: ts,
  }, { vaultDir: vault });
  assert.equal(result.ok, true);

  const on_disk = await fs.readFile(path.join(vault, result.path), 'utf8');
  // bytes_written should match what was appended (entire payload)
  const expected = Buffer.byteLength(`## ${ts} user\n${content}\n\n`, 'utf8');
  assert.equal(result.bytes_written, expected);
});

// ---------- filesystem-direct ----------

test('doAppendTurn writes only to the raw-capture file (no spurious files)', async () => {
  const vault = await makeTempVault();

  const result = await doAppendTurn({
    project: 'fsdirect',
    content: 'no mem0',
    role: 'user',
  }, { vaultDir: vault });

  assert.equal(result.ok, true);

  // Only the raw .md file (and its .lock sibling) should exist under the project dir
  const files = await fs.readdir(path.join(vault, 'captures/fsdirect/raw'));
  const nonLock = files.filter((f) => !f.endsWith('.lock'));
  assert.equal(nonLock.length, 1, 'exactly one non-lock file written');
  assert.ok(nonLock[0].endsWith('.md'), 'raw .md file present');
});

// ---------- schema_version ----------

test('doAppendTurn response includes schema_version=1', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'sv',
    content: 'schema check',
    role: 'user',
  }, { vaultDir: vault });
  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 1);
});

// ---------- concurrent writes (flock-safe) ----------

test('doAppendTurn is flock-safe under concurrent writes', async () => {
  const vault = await makeTempVault();
  const base = { project: 'p', role: 'user' };
  const ctx = { vaultDir: vault };

  const turns = Array.from({ length: 20 }, (_, i) => ({
    ...base,
    content: `concurrent-${i}-${'x'.repeat(500)}`,
  }));
  const results = await Promise.all(turns.map((args) => doAppendTurn(args, ctx)));
  assert.ok(results.every((r) => r.ok));

  const date = new Date().toISOString().slice(0, 10);
  const disk = await fs.readFile(path.join(vault, `captures/p/raw/${date}.md`), 'utf8');
  for (let i = 0; i < 20; i++) {
    assert.match(disk, new RegExp(`concurrent-${i}-xxx`), `turn-${i} survived`);
  }
  const matches = disk.match(/concurrent-\d+-/g) || [];
  assert.equal(matches.length, 20, `expected 20 turn markers, got ${matches.length}`);
});

// ---------- lock exhaustion (contract preservation) ----------

test('doAppendTurn returns ok=false when lock acquire fails (contract preserved, ctx.lockfile DI)', async () => {
  const vault = await makeTempVault();
  const fakeLockfile = {
    lock: async () => { const e = new Error('fake ELOCKED'); e.code = 'ELOCKED'; throw e; },
  };
  const result = await doAppendTurn(
    { project: 'p', content: 'c', role: 'user' },
    { vaultDir: vault, lockfile: fakeLockfile }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /lock_acquire_failed.*ELOCKED/);
});

// ---------- REST handler unit tests ----------

test('POST /api/append-turn writes a turn and returns compact shape', async () => {
  const vault = await makeTempVault();
  const req = { body: { project: 'rest-test', content: 'via REST', role: 'user' } };
  const res = mockRes();
  await handleAppendTurnRequest(req, res, { vaultDir: vault, writesEnabled: true });
  assert.equal(res.statusCode, 200);
  const body = res.jsonBody;
  assert.equal(body.ok, true);
  assert.equal(body.schema_version, 1);
  assert.match(body.path, /captures\/rest-test\/raw/);
});

test('POST /api/append-turn returns 403 when writes disabled', async () => {
  const req = { body: { project: 'p', content: 'c', role: 'user' } };
  const res = mockRes();
  await handleAppendTurnRequest(req, res, { writesEnabled: false });
  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.ok, false);
});

// Fix 3: role trim — 'user ' (trailing space) should be accepted
test('doAppendTurn trims whitespace from role', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'p',
    content: 'trimmed role test',
    role: 'user ',  // trailing space
  }, { vaultDir: vault });
  assert.equal(result.ok, true, 'role with trailing space should be accepted after trim');
});

// Fix 3: invalid role error lists accepted values
test('doAppendTurn invalid role error message lists accepted values', async () => {
  const vault = await makeTempVault();
  const result = await doAppendTurn({
    project: 'p',
    content: 'c',
    role: 'bot',
  }, { vaultDir: vault });
  assert.equal(result.ok, false);
  assert.match(result.error, /accepted values/i);
  assert.match(result.error, /user.*assistant.*system/i);
});

// Fix 4: schema_version:1 on all error returns
test('doAppendTurn error returns include schema_version:1', async () => {
  const vault = await makeTempVault();

  // invalid project
  const r1 = await doAppendTurn({ project: '../bad', content: 'c', role: 'user' }, { vaultDir: vault });
  assert.equal(r1.schema_version, 1, 'invalid project error should have schema_version:1');

  // missing content
  const r2 = await doAppendTurn({ project: 'p', content: '', role: 'user' }, { vaultDir: vault });
  assert.equal(r2.schema_version, 1, 'missing content error should have schema_version:1');

  // invalid role
  const r3 = await doAppendTurn({ project: 'p', content: 'c', role: 'bot' }, { vaultDir: vault });
  assert.equal(r3.schema_version, 1, 'invalid role error should have schema_version:1');

  // missing UM_VAULT_DIR
  const r4 = await doAppendTurn({ project: 'p', content: 'c', role: 'user' }, { vaultDir: undefined });
  assert.equal(r4.schema_version, 1, 'missing vaultDir error should have schema_version:1');
});
