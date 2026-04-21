/**
 * token-cost.test.mjs — Phase-0 scaffolding for the v0.4 HYBRID-REBALANCE
 * plan's token-cost measurement sweep (Task 0.3 extends this harness).
 *
 * Purpose: print a per-tool token count for every MCP tool the server
 * advertises, using two tokenizers:
 *   - tiktoken (OpenAI, encoding o200k_base) — used by GPT-4o / GPT-4.1.
 *     This is an exact count for OpenAI models.
 *   - @anthropic-ai/tokenizer — Claude approximation. The package itself
 *     is labeled as an approximation; noted in the output.
 *
 * "Cost" here = tokens consumed by the tool's name + description +
 * JSON-serialized inputSchema — i.e. the schema surface that gets shipped
 * to the model on every request.
 *
 * This is the Task 0.1 stub. Task 0.3 will extend it with a full
 * measurement sweep (totals, baseline comparisons, regression gates).
 * Keep this file small — one test that prints a report, no framework.
 *
 * The import below works because mem0-mcp-http.mjs guards its bootstrap
 * (initMemory + server.listen) behind `if (IS_MAIN)` — see its comment at
 * the top of the file. Test imports do not start a server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { get_encoding } from 'tiktoken';
import { countTokens as countClaudeTokens } from '@anthropic-ai/tokenizer';

import { TOOLS } from '../mem0-mcp-http.mjs';

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a tool definition into the text that actually gets sent to the
 * model. Order matches the MCP tools/list response shape: name, description,
 * then JSON-stringified inputSchema. This is the "schema surface" whose
 * token cost we care about.
 */
function serializeTool(tool) {
	return [
		tool.name || '',
		tool.description || '',
		JSON.stringify(tool.inputSchema || {}),
	].join('\n');
}

function countOpenAiTokens(encoder, text) {
	return encoder.encode(text).length;
}

// ---------------------------------------------------------------------------
// Test: report per-tool token counts for every tool in TOOLS.
// Data-driven — adding an 11th tool requires zero changes to this file.
// ---------------------------------------------------------------------------

test('token-cost: per-tool token counts (tiktoken + anthropic)', () => {
	assert.ok(Array.isArray(TOOLS), 'TOOLS must be an array');
	assert.ok(TOOLS.length > 0, 'TOOLS must not be empty');

	// OpenAI: o200k_base matches GPT-4o / GPT-4.1 family (the server's
	// default MEM0_LLM_MODEL is gpt-4.1-nano-2025-04-14).
	const openaiEncoder = get_encoding('o200k_base');

	try {
		console.log('');
		console.log('Per-tool token cost report');
		console.log('  tiktoken encoding: o200k_base (GPT-4o / GPT-4.1 family)');
		console.log('  @anthropic-ai/tokenizer: approximation (per package README)');
		console.log('');

		const nameWidth = Math.max(...TOOLS.map((t) => t.name.length));
		let totalOpenAi = 0;
		let totalClaude = 0;

		for (const tool of TOOLS) {
			const text = serializeTool(tool);
			const openai = countOpenAiTokens(openaiEncoder, text);
			const claude = countClaudeTokens(text);
			totalOpenAi += openai;
			totalClaude += claude;

			const padded = tool.name.padEnd(nameWidth, ' ');
			console.log(`  ${padded}  tiktoken=${openai}  anthropic=${claude}`);

			assert.ok(openai > 0, `${tool.name}: tiktoken count must be > 0`);
			assert.ok(claude > 0, `${tool.name}: anthropic count must be > 0`);
		}

		console.log('');
		console.log(`  ${'TOTAL'.padEnd(nameWidth, ' ')}  tiktoken=${totalOpenAi}  anthropic=${totalClaude}`);
		console.log(`  (${TOOLS.length} tools measured)`);
		console.log('');
	} finally {
		// tiktoken encoders hold WASM resources — free them so the test
		// runner exits cleanly.
		openaiEncoder.free();
	}
});
