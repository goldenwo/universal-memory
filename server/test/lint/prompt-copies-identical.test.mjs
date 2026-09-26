// server/test/lint/prompt-copies-identical.test.mjs — #326 T3.2
//
// The plugin ships copies of the server's prompts (`bin/um-preview` and the retired bash path
// render with them, so a preview must show what the server would write — spec §3 constraint 6).
// Nothing pinned the copies together before #326: the server's update-state.txt had not changed
// since 2026-04-24 and the copies were identical by luck. This lint makes the drift visible the
// day it happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER_PROMPTS = join(REPO_ROOT, 'server', 'config', 'prompts');
const PLUGIN_PROMPTS = join(REPO_ROOT, 'plugins', 'claude-code', 'universal-memory', 'hooks', 'lib', 'prompts');

for (const name of ['update-state.txt', 'summarize.txt']) {
  test(`prompt copy is byte-identical: ${name}`, () => {
    const server = readFileSync(join(SERVER_PROMPTS, name));
    const plugin = readFileSync(join(PLUGIN_PROMPTS, name));
    // assert.equal on two Buffers compares references and fails on identical copies;
    // Buffer#equals compares contents.
    assert.ok(server.equals(plugin), `${name}: server/config/prompts and the plugin copy differ (${server.length} vs ${plugin.length} bytes) — copy the server file to the plugin`);
  });
}
