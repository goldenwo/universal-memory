// server/test/compose-contract.test.mjs — contract gate on docker-compose.yml.
//
// MEM0_MCP_PORT is read two different ways and the two readings conflict:
//   • docker-compose.yml `ports:` uses it as the HOST side of the mapping.
//   • memory-server also has `env_file: .env`, so the same value reaches the
//     container, where mem0-mcp-http.mjs does parseInt(MEM0_MCP_PORT) to pick
//     its LISTEN port.
//
// Left alone, MEM0_MCP_PORT=6337 published host 6337 -> target 6335 while the
// server listened on 6337 inside (nothing on 6335), and the documented binding
// form "127.0.0.1:6337" parseInt'd to 127 -> listen on a privileged port ->
// EACCES. This bit a real migration.
//
// The fix is a literal `environment:` entry, which compose resolves ahead of
// `env_file`, pinning the container's listen port to 6335 no matter what .env
// says. These tests pin that fix in place: they assert the invariant
// "the container side is always 6335" statically, so it holds without needing
// docker in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const SERVER_DIR = fileURLToPath(new URL('../', import.meta.url));
const COMPOSE_PATH = path.join(SERVER_DIR, 'docker-compose.yml');

const compose = YAML.parse(fs.readFileSync(COMPOSE_PATH, 'utf8'));
const memoryServer = compose?.services?.['memory-server'];

test('compose contract: memory-server exists and still inherits .env', () => {
  assert.ok(memoryServer, 'docker-compose.yml has no memory-server service');
  // The env_file is exactly why the pin below is required. If this ever goes
  // away the pin becomes optional — but until then it is load-bearing.
  assert.ok(memoryServer.env_file, 'memory-server no longer reads env_file — revisit the MEM0_MCP_PORT pin');
});

test('compose contract: container listen port is pinned to 6335 in environment', () => {
  const env = memoryServer.environment;
  assert.ok(env, 'memory-server has no environment block');
  // Support both compose env shapes (map or KEY=VALUE list).
  const value = Array.isArray(env)
    ? env.find((e) => String(e).startsWith('MEM0_MCP_PORT='))?.split('=').slice(1).join('=')
    : env.MEM0_MCP_PORT;
  assert.equal(
    String(value),
    '6335',
    'memory-server.environment.MEM0_MCP_PORT must pin the container listen port to 6335 '
      + '(a literal environment entry beats env_file, so .env cannot move the listen port)',
  );
});

test('compose contract: every published port targets container 6335', () => {
  const ports = memoryServer.ports ?? [];
  assert.ok(ports.length > 0, 'memory-server publishes no ports');
  for (const entry of ports) {
    // Long form: { target: 6335, published: ... }
    if (entry && typeof entry === 'object') {
      assert.equal(Number(entry.target), 6335, `port mapping targets ${entry.target}, not the pinned 6335`);
      continue;
    }
    // Short form: "<host-side>:<container-side>", where host-side may itself
    // be an interpolation carrying a host:port binding.
    const containerSide = String(entry).split(':').pop();
    assert.equal(
      containerSide,
      '6335',
      `port mapping "${entry}" targets container port ${containerSide}, but the server listens on 6335`,
    );
  }
});

test('compose contract: MEM0_MCP_PORT stays the host side of the mapping', () => {
  // The whole point of the pin is that MEM0_MCP_PORT still selects where the
  // service is PUBLISHED. If a refactor drops it from `ports:`, operators lose
  // the ability to move the host port at all.
  const ports = memoryServer.ports ?? [];
  const usesVar = ports.some((e) => (typeof e === 'object' ? JSON.stringify(e) : String(e)).includes('MEM0_MCP_PORT'));
  assert.ok(usesVar, 'MEM0_MCP_PORT no longer selects the published host port');
});
