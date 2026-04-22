/**
 * schema-hygiene.test.mjs — Task B.3.1a
 *
 * Verifies that write tools are filtered from tools/list when
 * UM_MCP_WRITE_ENABLED is false (default), and all tools are visible when true.
 *
 * Imports WRITE_TOOL_NAMES and getVisibleTools from the server module.
 * These exports are added in B.3.1a (Step 3). Until that step is complete,
 * this test will fail with an ImportError — expected "Step 2: FAIL" behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, WRITE_TOOL_NAMES, getVisibleTools } from '../mem0-mcp-http.mjs';

// Sanity check: confirm the exported WRITE_TOOL_NAMES matches what we expect.
const EXPECTED_WRITE_TOOLS = new Set([
  'memory_add', 'memory_delete', 'memory_capture',
  'memory_checkpoint', 'memory_forget', 'memory_supersede',
]);
const EXPECTED_READ_TOOLS = ['memory_search', 'memory_list', 'memory_state', 'memory_recent'];

test('TOOLS array contains all 10 tools', () => {
  assert.strictEqual(TOOLS.length, 10, `expected 10 total tools, got ${TOOLS.length}`);
});

test('WRITE_TOOL_NAMES export matches expected write-tool set', () => {
  for (const name of EXPECTED_WRITE_TOOLS) {
    assert.ok(WRITE_TOOL_NAMES.has(name), `WRITE_TOOL_NAMES missing expected write tool: ${name}`);
  }
  assert.strictEqual(WRITE_TOOL_NAMES.size, EXPECTED_WRITE_TOOLS.size,
    `WRITE_TOOL_NAMES size mismatch: expected ${EXPECTED_WRITE_TOOLS.size}, got ${WRITE_TOOL_NAMES.size}`);
});

test('getVisibleTools(true) returns all 10 tools', () => {
  const visible = getVisibleTools(true);
  assert.strictEqual(visible.length, 10, `enabled mode should expose all 10 tools; got ${visible.length}`);
});

test('getVisibleTools(false) filters all write tools from list', () => {
  const visible = getVisibleTools(false);
  const names = visible.map(t => t.name);
  for (const writeTool of EXPECTED_WRITE_TOOLS) {
    assert.ok(!names.includes(writeTool), `write tool ${writeTool} must be filtered when writes disabled`);
  }
});

test('getVisibleTools(false) retains all read tools', () => {
  const visible = getVisibleTools(false);
  const names = visible.map(t => t.name);
  for (const readTool of EXPECTED_READ_TOOLS) {
    assert.ok(names.includes(readTool), `read tool ${readTool} must still be visible when writes disabled`);
  }
});

test('reads-only count is 4 after filtering 6 writes', () => {
  const visible = getVisibleTools(false);
  // NOTE: plan spec said "5 tools (reads only)" — actual code path yields 4:
  //   reads = { memory_search, memory_list, memory_state, memory_recent }
  //   writes = { memory_add, memory_delete, memory_capture, memory_checkpoint, memory_forget, memory_supersede }
  // 10 - 6 = 4. The plan numeric is superseded by the actual code path.
  assert.strictEqual(visible.length, 4,
    `expected 4 read tools after filtering 6 writes; got ${visible.length}`);
});

test('getVisibleTools with no arg defaults to env-var behavior', () => {
  // When called with no argument, getVisibleTools reads process.env.UM_MCP_WRITE_ENABLED.
  // This test verifies the env-var-reading default (write disabled when unset).
  const savedEnv = process.env.UM_MCP_WRITE_ENABLED;
  try {
    delete process.env.UM_MCP_WRITE_ENABLED;
    const visibleDefault = getVisibleTools();
    assert.strictEqual(visibleDefault.length, 4,
      `unset env var should behave as disabled (4 tools); got ${visibleDefault.length}`);

    process.env.UM_MCP_WRITE_ENABLED = 'true';
    const visibleEnabled = getVisibleTools();
    assert.strictEqual(visibleEnabled.length, 10,
      `UM_MCP_WRITE_ENABLED=true should expose all 10 tools; got ${visibleEnabled.length}`);

    process.env.UM_MCP_WRITE_ENABLED = '1';
    const visibleEnabled1 = getVisibleTools();
    assert.strictEqual(visibleEnabled1.length, 10,
      `UM_MCP_WRITE_ENABLED=1 should expose all 10 tools; got ${visibleEnabled1.length}`);

    process.env.UM_MCP_WRITE_ENABLED = 'false';
    const visibleFalse = getVisibleTools();
    assert.strictEqual(visibleFalse.length, 4,
      `UM_MCP_WRITE_ENABLED=false should filter writes (4 tools); got ${visibleFalse.length}`);
  } finally {
    if (savedEnv === undefined) {
      delete process.env.UM_MCP_WRITE_ENABLED;
    } else {
      process.env.UM_MCP_WRITE_ENABLED = savedEnv;
    }
  }
});
