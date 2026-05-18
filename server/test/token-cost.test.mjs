/**
 * token-cost.test.mjs — Phase-0 scaffolding for the v0.4 HYBRID-REBALANCE
 * plan's token-cost measurement sweep.
 *
 * Task 0.1 — MCP tool schemas (per-tool counts + TOTAL row).
 * Task 0.3 — Full measurement sweep: 4 additional locations + baseline file.
 *
 * Tokenizer methodology (plan §2):
 *   - tiktoken o200k_base — primary for mixed/CLI-agnostic surfaces
 *     (MCP tool schemas, MCP response payloads, summarizer prompt).
 *   - @anthropic-ai/tokenizer — secondary reference; PRIMARY for
 *     CC-consumed surfaces (SessionStart injection).
 *
 * Test 3 is a DRIFT GATE: by default it asserts the committed
 * server/test/token-cost-baseline.txt matches freshly-generated output
 * byte-for-byte (so CI fails when a schema/tokenizer change lands without a
 * deliberate baseline refresh). Set UM_UPDATE_TOKEN_BASELINE=1 to rewrite the
 * file instead of asserting, then commit the diff.
 * Keep this file small — two measurement blocks + one gate, no framework.
 *
 * The import below works because mem0-mcp-http.mjs guards its bootstrap
 * (initMemory + server.listen) behind `if (IS_MAIN)` — see its comment at
 * the top of the file. Test imports do not start a server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { get_encoding } from 'tiktoken';
import { countTokens as countClaudeTokens } from '@anthropic-ai/tokenizer';

import { TOOLS } from '../mem0-mcp-http.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, 'fixtures');
const BASELINE_PATH = join(__dirname, 'token-cost-baseline.txt');
const SUMMARIZE_SH_PATH = join(
	__dirname,
	'../../plugins/claude-code/universal-memory/hooks/lib/summarize.sh'
);
const SUMMARIZE_PROMPT_PATH = join(
	__dirname,
	'../config/prompts/summarize.txt'
);

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

/**
 * Count tokens using tiktoken (o200k_base, GPT-4o / GPT-4.1 family).
 * Caller is responsible for calling encoder.free() after all uses.
 */
function countOpenAiTokens(encoder, text) {
	return encoder.encode(text).length;
}

/**
 * Fixed-width right-aligned number string (for diff-friendly column output).
 */
function rpad(n, width = 6) {
	return String(n).padStart(width, ' ');
}

// ---------------------------------------------------------------------------
// Module-level report accumulator.
// Both test blocks append to this array; a third top-level `test()` at the
// end flushes it to disk so the file is written after all measurements run.
// ---------------------------------------------------------------------------
const reportLines = [];
function emit(line = '') {
	reportLines.push(line);
	console.log(line);
}

// ---------------------------------------------------------------------------
// Test 1 (Task 0.1): per-tool token counts for MCP tool schemas.
// Data-driven — adding an 11th tool requires zero changes to this file.
// ---------------------------------------------------------------------------

test('token-cost: per-tool token counts (tiktoken + anthropic)', () => {
	assert.ok(Array.isArray(TOOLS), 'TOOLS must be an array');
	assert.ok(TOOLS.length > 0, 'TOOLS must not be empty');

	// OpenAI: o200k_base matches GPT-4o / GPT-4.1 family (the server's
	// default MEM0_LLM_MODEL is gpt-4.1-nano-2025-04-14).
	const openaiEncoder = get_encoding('o200k_base');

	try {
		emit('');
		emit('=== LOCATION 1: MCP tool schemas ===');
		emit('  tiktoken encoding: o200k_base (GPT-4o / GPT-4.1 family)');
		emit('  @anthropic-ai/tokenizer: approximation (per package README)');
		emit('  Surface consumed by: all model surfaces (mixed)');
		emit('');

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
			emit(`  ${padded}  tiktoken=${rpad(openai)}  anthropic=${rpad(claude)}`);

			assert.ok(openai > 0, `${tool.name}: tiktoken count must be > 0`);
			assert.ok(claude > 0, `${tool.name}: anthropic count must be > 0`);
		}

		emit('');
		emit(`  ${'TOTAL'.padEnd(nameWidth, ' ')}  tiktoken=${rpad(totalOpenAi)}  anthropic=${rpad(totalClaude)}`);
		emit(`  (${TOOLS.length} tools measured)`);
	} finally {
		// tiktoken encoders hold WASM resources — free them so the test
		// runner exits cleanly.
		openaiEncoder.free();
	}
});

// ---------------------------------------------------------------------------
// Test 2 (Task 0.3): measurement sweep — 4 additional locations.
//
// Sections:
//   L2 — MCP response payload sizes (memory_search + memory_list)
//   L3 — SessionStart injection size (state.md only)
//   L4 — Summarizer prompt size (sourced from summarize.sh)
// ---------------------------------------------------------------------------

test('token-cost: measurement sweep — 4 additional locations', () => {
	const openaiEncoder = get_encoding('o200k_base');

	try {
		// -----------------------------------------------------------------------
		// L2: MCP response payloads
		// Fixture: server/test/fixtures/response-samples.json
		// Shape:
		//   memory_search → { results: [...] }  (REST POST /api/search response)
		//   memory_list   → [...]               (REST GET /api/list response)
		// Both shapes are also what the MCP tool returns (JSON.stringify'd).
		// -----------------------------------------------------------------------
		emit('');
		emit('=== LOCATION 2: MCP response payloads ===');
		emit('  Fixture: server/test/fixtures/response-samples.json');
		emit('  Represents: realistic production responses (5 search results, 10 list entries)');
		emit('  Surface consumed by: all model surfaces (mixed) — primary: tiktoken');
		emit('');

		const responseSamples = JSON.parse(
			readFileSync(join(FIXTURES_DIR, 'response-samples.json'), 'utf8')
		);

		assert.ok(responseSamples.memory_search, 'fixture must have memory_search key');
		assert.ok(Array.isArray(responseSamples.memory_list), 'fixture must have memory_list array');

		const searchText = JSON.stringify(responseSamples.memory_search);
		const listText = JSON.stringify(responseSamples.memory_list);

		const searchOpenAi = countOpenAiTokens(openaiEncoder, searchText);
		const searchClaude = countClaudeTokens(searchText);
		const listOpenAi = countOpenAiTokens(openaiEncoder, listText);
		const listClaude = countClaudeTokens(listText);
		const responseTotal = searchOpenAi + listOpenAi;
		const responseClaudeTotal = searchClaude + listClaude;

		const searchCount = responseSamples.memory_search.results.length;
		const listCount = responseSamples.memory_list.length;

		emit(`  memory_search (${searchCount} results)  tiktoken=${rpad(searchOpenAi)}  anthropic=${rpad(searchClaude)}`);
		emit(`  memory_list   (${listCount} entries)  tiktoken=${rpad(listOpenAi)}  anthropic=${rpad(listClaude)}`);
		emit('');
		emit(`  TOTAL (both payloads)       tiktoken=${rpad(responseTotal)}  anthropic=${rpad(responseClaudeTotal)}`);
		emit(`  per-result avg (search):    tiktoken=${rpad(Math.round(searchOpenAi / searchCount))}  anthropic=${rpad(Math.round(searchClaude / searchCount))}`);
		emit(`  per-entry  avg (list):      tiktoken=${rpad(Math.round(listOpenAi / listCount))}  anthropic=${rpad(Math.round(listClaude / listCount))}`);

		assert.ok(searchOpenAi > 0, 'memory_search payload: tiktoken count must be > 0');
		assert.ok(listOpenAi > 0, 'memory_list payload: tiktoken count must be > 0');

		// -----------------------------------------------------------------------
		// L3: SessionStart injection size (state.md only)
		// Fixture: server/test/fixtures/state-sample.md
		// The session-start.sh hook fetches GET /api/state/:project, which
		// returns { ok, project, state: { frontmatter, body }, valid_from }.
		// The Python block extracts body and injects it as additionalContext.
		// We measure the full body text as injected (what CC receives).
		// -----------------------------------------------------------------------
		emit('');
		emit('=== LOCATION 3: SessionStart injection (state.md body) ===');
		emit('  Fixture: server/test/fixtures/state-sample.md');
		emit('  Represents: realistic state.md for an active v0.4 project');
		emit('  Surface consumed by: Claude Code plugin — PRIMARY: anthropic');
		emit('  Note: this is the body text injected into additionalContext,');
		emit('        NOT the full /api/state response JSON (which also has frontmatter).');
		emit('');

		const stateRaw = readFileSync(join(FIXTURES_DIR, 'state-sample.md'), 'utf8');

		// Mirror what session-start.sh does: extract the body after frontmatter.
		// The server's parseFrontmatter splits on the second '---\n' boundary.
		// For measurement purposes we strip the YAML front matter block.
		const frontmatterEnd = stateRaw.indexOf('\n---\n', 3);
		const stateBody = frontmatterEnd >= 0
			? stateRaw.slice(frontmatterEnd + 5).trimStart()
			: stateRaw;

		const stateOpenAi = countOpenAiTokens(openaiEncoder, stateBody);
		const stateClaude = countClaudeTokens(stateBody);
		const stateChars = stateBody.length;

		emit(`  state.md body     tiktoken=${rpad(stateOpenAi)}  anthropic=${rpad(stateClaude)}  chars=${stateChars}`);
		emit(`  (EMPHASIS: anthropic=${stateClaude} — this is the CC-consumed budget)`);

		// Also measure the full /api/state JSON envelope for completeness
		// (useful if a future task measures full response overhead)
		const stateEnvelope = JSON.stringify({
			ok: true,
			project: 'universal-memory',
			state: { frontmatter: {}, body: stateBody },
			valid_from: '2026-04-21T10:30:00Z',
		});
		const envelopeOpenAi = countOpenAiTokens(openaiEncoder, stateEnvelope);
		const envelopeClaude = countClaudeTokens(stateEnvelope);
		emit(`  /api/state envelope tiktoken=${rpad(envelopeOpenAi)}  anthropic=${rpad(envelopeClaude)}  (body+JSON overhead)`);

		assert.ok(stateOpenAi > 0, 'state.md body: tiktoken count must be > 0');
		assert.ok(stateClaude > 0, 'state.md body: anthropic count must be > 0');

		// -----------------------------------------------------------------------
		// L4: Summarizer prompt size
		// Source: plugins/claude-code/universal-memory/hooks/lib/summarize.sh
		// Extract the system prompt from the _UM_SYSTEM_PROMPT assignment.
		// The template uses no runtime placeholders in the system prompt;
		// the user message adds the transcript at runtime.
		// We measure:
		//   (a) system prompt alone (template-only, no transcript fill)
		//   (b) system + user prompt with a realistic transcript placeholder
		// -----------------------------------------------------------------------
		emit('');
		emit('=== LOCATION 4: Summarizer prompt ===');
		emit('  Source: plugins/claude-code/universal-memory/hooks/lib/summarize.sh');
		emit('  Surface consumed by: OpenAI gpt-4o-mini (default) or Claude (UM_SUMMARIZER=claude-agent-sdk)');
		emit('  Note: system prompt has NO runtime placeholders (measured as-is);');
		emit('        user message includes the transcript (variable; see per-char estimate below).');
		emit('');

		const summarizeSrc = readFileSync(SUMMARIZE_SH_PATH, 'utf8');

		// Read the system prompt from its canonical location. As of v0.5 the
		// prompt is extracted to server/config/prompts/summarize.txt; summarize.sh
		// loads it at runtime via $UM_PROMPT_DIR (Task 2.1).
		const systemPrompt = readFileSync(SUMMARIZE_PROMPT_PATH, 'utf8');
		assert.ok(
			systemPrompt.length > 0,
			`Summary prompt file empty or missing at ${SUMMARIZE_PROMPT_PATH}`
		);

		// Extract the user prompt template (everything between the two lines that
		// bracket _UM_USER_PROMPT). The template has a ${transcript} placeholder.
		const userPromptMatch = summarizeSrc.match(
			/export _UM_USER_PROMPT="([\s\S]*?)"\s*\n/
		);
		assert.ok(
			userPromptMatch,
			'Could not extract _UM_USER_PROMPT from summarize.sh — grep the file for the pattern'
		);
		// The user prompt template contains ${transcript} — replace with a
		// representative placeholder to show template-only cost (no transcript).
		const userPromptTemplate = userPromptMatch[1].replace('${transcript}', '[TRANSCRIPT PLACEHOLDER]');

		// Measure system prompt alone
		const sysOpenAi = countOpenAiTokens(openaiEncoder, systemPrompt);
		const sysClaude = countClaudeTokens(systemPrompt);

		// Measure user prompt template (no transcript fill)
		const userOpenAi = countOpenAiTokens(openaiEncoder, userPromptTemplate);
		const userClaude = countClaudeTokens(userPromptTemplate);

		// Measure combined (system + user template, no transcript)
		const combinedText = systemPrompt + '\n' + userPromptTemplate;
		const combinedOpenAi = countOpenAiTokens(openaiEncoder, combinedText);
		const combinedClaude = countClaudeTokens(combinedText);

		// Per-char cost for transcript portion (helps estimate cost at different transcript lengths)
		// Use a 1000-char sample to get tokens/char ratio
		const sampleTranscript = 'A'.repeat(1000);
		const sampleOpenAi = countOpenAiTokens(openaiEncoder, sampleTranscript);
		const sampleClaude = countClaudeTokens(sampleTranscript);
		const tokPerCharOpenAi = sampleOpenAi / 1000;
		const tokPerCharClaude = sampleClaude / 1000;

		emit(`  system prompt (template-only):  tiktoken=${rpad(sysOpenAi)}  anthropic=${rpad(sysClaude)}`);
		emit(`  user prompt (no transcript):    tiktoken=${rpad(userOpenAi)}  anthropic=${rpad(userClaude)}`);
		emit(`  combined (no transcript fill):  tiktoken=${rpad(combinedOpenAi)}  anthropic=${rpad(combinedClaude)}`);
		emit('');
		emit(`  transcript tokens/char (approx): tiktoken=${tokPerCharOpenAi.toFixed(3)}  anthropic=${tokPerCharClaude.toFixed(3)}`);
		emit(`  at UM_SUMMARY_MAX_CHARS=24000 chars, transcript adds ~tiktoken=${Math.round(24000 * tokPerCharOpenAi)}  anthropic=${Math.round(24000 * tokPerCharClaude)}`);
		emit(`  TOTAL prompt at max transcript:  tiktoken=~${Math.round(combinedOpenAi + 24000 * tokPerCharOpenAi)}  anthropic=~${Math.round(combinedClaude + 24000 * tokPerCharClaude)}`);
		emit('  (prod choice depends on UM_SUMMARIZER: openai→tiktoken matters; claude-agent-sdk→anthropic matters)');

		assert.ok(sysOpenAi > 0, 'summarizer system prompt: tiktoken count must be > 0');
		assert.ok(sysClaude > 0, 'summarizer system prompt: anthropic count must be > 0');
	} finally {
		openaiEncoder.free();
	}
});

// ---------------------------------------------------------------------------
// Test 3: drift gate for server/test/token-cost-baseline.txt.
//
// Runs after both measurement tests so reportLines is fully populated.
// DEFAULT: assert the committed baseline equals freshly-generated output
//          byte-for-byte — CI fails on undeclared schema/tokenizer drift.
// OPT-IN:  UM_UPDATE_TOKEN_BASELINE=1 rewrites the file instead of asserting
//          (deliberate refresh; commit the resulting diff with the change).
// Mirrors the byte-for-byte golden pattern in custom-gpt-actions.test.mjs.
// ---------------------------------------------------------------------------

test('token-cost: baseline matches committed file byte-for-byte (drift gate)', () => {
	const header = [
		'universal-memory v0.4 — token-cost baseline',
		'Phase 0 measurement sweep (Task 0.3)',
		'',
		'Generated by: node --test server/test/token-cost.test.mjs',
		'Tokenizers:   tiktoken o200k_base (primary, GPT-4o/4.1 family)',
		'              @anthropic-ai/tokenizer (secondary, approximation)',
		'',
		'Locations measured:',
		'  1. MCP tool schemas          (all tools, per-tool + TOTAL)',
		'  2. MCP response payloads     (memory_search×5 + memory_list×10)',
		'  3. SessionStart injection    (state.md body, CC-consumed)',
		'  4. Summarizer prompt         (system+user template, +per-char estimate)',
		'',
		'Note: numbers are stable across runs (fixture-driven, no timestamps).',
		'      Diffs in this file indicate schema changes or tokenizer upgrades.',
		'',
		'---',
	];

	const footer = [
		'',
		'---',
		'END OF BASELINE',
	];

	const content = [...header, ...reportLines, ...footer].join('\n') + '\n';

	// Opt-in regeneration: accept `1` or `true` (case-insensitive) so a
	// deliberate refresh isn't a confusing footgun. Default is assert-only.
	const updateMode = ['1', 'true'].includes(
		(process.env.UM_UPDATE_TOKEN_BASELINE || '').toLowerCase()
	);

	if (updateMode) {
		writeFileSync(BASELINE_PATH, content, 'utf8');
		const lineCount = content.split('\n').length;
		console.log('');
		console.log(`Baseline REGENERATED (UM_UPDATE_TOKEN_BASELINE set): ${BASELINE_PATH}`);
		console.log(`  ${lineCount} lines — commit this file alongside the schema change.`);
		assert.ok(lineCount > 0, 'regenerated baseline must have content');
		return;
	}

	// Default: pure drift gate. Never writes — so a bare `node --test` run
	// cannot churn the file, and CI fails loudly on undeclared drift.
	const checkedIn = readFileSync(BASELINE_PATH, 'utf8');
	assert.strictEqual(
		checkedIn,
		content,
		'token-cost-baseline.txt drift — a tool schema or tokenizer changed ' +
		'without refreshing the baseline. Regenerate with: ' +
		'UM_UPDATE_TOKEN_BASELINE=1 node --test server/test/token-cost.test.mjs ' +
		'(then commit the updated server/test/token-cost-baseline.txt).'
	);
});
