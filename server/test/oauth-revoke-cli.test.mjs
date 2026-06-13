// server/test/oauth-revoke-cli.test.mjs — Gap-3 OAuth PR-5 Task 5.1 operator
// CLI (server/bin/oauth-revoke.mjs). Spawned as a child process against a live
// stub server bound to an ephemeral loopback port (passed via --port), and once
// against a dead port. Asserts the documented contract:
//   --all / --client <id> → exit 0, prints the revoked counts.
//   connection refused / non-2xx → exit 1, stderr names the oauth-state.json
//     nuclear option.
//   no args / bad args → usage, exit 2.
//
// The CLI talks to the loopback-only POST /oauth/revoke route (spec §4.3): the
// running process owns the in-process cache, so a file-editing CLI would race
// the server's own atomic writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI = fileURLToPath(new URL('../bin/oauth-revoke.mjs', import.meta.url));

// Run the CLI, capturing exit code + stdout + stderr.
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A stub revoke server: echoes a canned response for the matching body and
// records the request bodies it saw. `port` returned once listening.
async function stubServer(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url, method: req.method, body });
      handler(req, res, body);
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return { port: srv.address().port, seen, close: () => { srv.close(); return once(srv, 'close'); } };
}

test('CLI --all against a live server → exit 0 + prints counts', async () => {
  const stub = await stubServer((req, res, body) => {
    assert.equal(req.url, '/oauth/revoke');
    assert.deepEqual(JSON.parse(body), { all: true });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ revoked: 'all', counts: { accessTokens: 3, refreshTokens: 2, codes: 1 } }));
  });
  try {
    const { code, stdout } = await runCli(['--all', '--port', String(stub.port)]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /access tokens/i);
    assert.match(stdout, /3/);
  } finally { await stub.close(); }
});

test('CLI --client <id> against a live server → exit 0 + sends client_id body', async () => {
  const stub = await stubServer((req, res, body) => {
    assert.deepEqual(JSON.parse(body), { client_id: 'umcl_abc' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ revoked: 'client', client_id: 'umcl_abc', counts: { accessTokens: 1, refreshTokens: 1, codes: 0 } }));
  });
  try {
    const { code, stdout } = await runCli(['--client', 'umcl_abc', '--port', String(stub.port)]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /umcl_abc/);
  } finally { await stub.close(); }
});

test('CLI: unknown client → server 404 → exit 1 + stderr mentions oauth-state.json', async () => {
  const stub = await stubServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  try {
    const { code, stderr } = await runCli(['--client', 'umcl_nope', '--port', String(stub.port)]);
    assert.equal(code, 1);
    assert.match(stderr, /oauth-state\.json/);
  } finally { await stub.close(); }
});

test('CLI against a dead port → exit 1 + stderr mentions the oauth-state.json nuclear option', async () => {
  // Bind+immediately-close a server to obtain a port nothing is listening on.
  const tmp = http.createServer();
  tmp.listen(0, '127.0.0.1');
  await once(tmp, 'listening');
  const deadPort = tmp.address().port;
  tmp.close();
  await once(tmp, 'close');

  const { code, stderr } = await runCli(['--all', '--port', String(deadPort)]);
  assert.equal(code, 1);
  assert.match(stderr, /oauth-state\.json/);
});

test('CLI with no args → usage on stderr, exit 2', async () => {
  const { code, stderr } = await runCli([]);
  assert.equal(code, 2);
  assert.match(stderr, /usage/i);
});

test('CLI with both --all and --client → usage, exit 2', async () => {
  const { code, stderr } = await runCli(['--all', '--client', 'x']);
  assert.equal(code, 2);
  assert.match(stderr, /usage/i);
});
