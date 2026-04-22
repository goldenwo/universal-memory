#!/usr/bin/env node
/**
 * OpenAI Assistants API example — using universal-memory as a memory tool.
 *
 * Demonstrates an Assistant equipped with two function tools (`memory_search`,
 * `memory_state`) backed by universal-memory's HTTP endpoints. The run loop
 * handles the `requires_action` state by dispatching tool calls to the UM
 * server and submitting the outputs back to OpenAI.
 *
 * Environment:
 *   OPENAI_API_KEY  — required
 *   UM_ENDPOINT     — optional, default http://localhost:6335
 *
 * Usage:
 *   npm install openai
 *   OPENAI_API_KEY=sk-... node assistants-memory-tool.mjs
 *
 * Exit codes:
 *   0  — run completed, assistant response printed
 *   1  — UM unreachable / OpenAI error / malformed tool call
 */

import OpenAI from 'openai';

const UM_ENDPOINT = process.env.UM_ENDPOINT || 'http://localhost:6335';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
	console.error('ERROR: OPENAI_API_KEY not set in environment.');
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Tool definitions — schemas given to the Assistant
// ---------------------------------------------------------------------------
const TOOLS = [
	{
		type: 'function',
		function: {
			name: 'memory_search',
			description:
				'Semantic search over the universal-memory vault. Returns up to `limit` documents ranked by relevance to `query`. Use this to recall past decisions, session summaries, or authored knowledge. ' +
				'Default response is compact: each result has `id`, `title`, `score`, and `snippet` (first ~240 chars of body). ' +
				'The snippet is usually enough to answer the question — only use `?full=1` (append to the URL) when you need the complete document body.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Natural-language search query.' },
					limit: { type: 'integer', description: 'Max results (1-20). Default 5.', minimum: 1, maximum: 20 },
					project: { type: 'string', description: 'Optional project slug filter (e.g. "demo").' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'memory_state',
			description:
				'Load the current state.md for a project. Returns the frontmatter and body. state.md is the LLM-merged snapshot of the project — current focus, in-flight work, recent decisions, next actions.',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: 'Project slug (^[a-zA-Z0-9._-]+$).' },
				},
				required: ['project'],
			},
		},
	},
];

// ---------------------------------------------------------------------------
// Tool handlers — call UM HTTP surface, return raw JSON for the Assistant
// ---------------------------------------------------------------------------
async function handleMemorySearch({ query, limit = 5, project }) {
	const body = { query, limit };
	if (project) body.filters = { project };
	const res = await fetch(`${UM_ENDPOINT}/api/search`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`UM /api/search ${res.status}: ${await res.text()}`);
	return await res.json();
}

async function handleMemoryState({ project }) {
	const res = await fetch(`${UM_ENDPOINT}/api/state/${encodeURIComponent(project)}`);
	if (!res.ok) throw new Error(`UM /api/state ${res.status}: ${await res.text()}`);
	return await res.json();
}

const HANDLERS = {
	memory_search: handleMemorySearch,
	memory_state: handleMemoryState,
};

async function dispatchToolCall(toolCall) {
	const { name, arguments: argJson } = toolCall.function;
	const handler = HANDLERS[name];
	if (!handler) {
		return { error: `unknown tool: ${name}` };
	}
	let args;
	try {
		args = JSON.parse(argJson || '{}');
	} catch (err) {
		return { error: `invalid tool arguments: ${err.message}` };
	}
	try {
		return await handler(args);
	} catch (err) {
		return { error: err.message };
	}
}

// ---------------------------------------------------------------------------
// Preflight — fail fast if UM is down, so the user doesn't hang on OpenAI
// ---------------------------------------------------------------------------
async function preflightUM() {
	try {
		const res = await fetch(`${UM_ENDPOINT}/health`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) throw new Error(`health check returned ${res.status}`);
		const body = await res.json();
		if (!body.ok) throw new Error(`health check body.ok=false: ${JSON.stringify(body)}`);
	} catch (err) {
		console.error(`ERROR: universal-memory unreachable at ${UM_ENDPOINT}: ${err.message}`);
		console.error('Start it with: cd server && docker compose up -d');
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------
async function main() {
	await preflightUM();

	const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

	console.log(`[um] using endpoint ${UM_ENDPOINT}`);
	console.log('[openai] creating assistant...');

	const assistant = await openai.beta.assistants.create({
		name: 'UM Memory Assistant (example)',
		instructions:
			'You are a helpful assistant with access to a personal memory store (universal-memory). ' +
			'When the user asks about past work, project state, or prior decisions, call the appropriate ' +
			'memory tool before answering. Cite the document title / id from the tool output so the user ' +
			'can trace your claims. If a tool returns no results, say so honestly.',
		model: 'gpt-4o-mini',
		tools: TOOLS,
	});

	const thread = await openai.beta.threads.create({
		messages: [
			{
				role: 'user',
				content:
					'What do we know about the project "demo"? Check its state.md and also search for ' +
					'any recent session summaries or decisions mentioning it. Summarize what you find.',
			},
		],
	});

	console.log(`[openai] thread ${thread.id} / assistant ${assistant.id}`);
	console.log('[openai] starting run (createAndPoll)...');

	// SDK helper: creates run, polls until terminal state or requires_action.
	// openai-node v6 signatures — see https://github.com/openai/openai-node.
	// Note: Assistants API is marked deprecated in the SDK in favor of the
	// Responses API, but it still works end-to-end. A Responses-API version of
	// this example is tracked for v0.4.
	let run = await openai.beta.threads.runs.createAndPoll(thread.id, {
		assistant_id: assistant.id,
	});

	// Handle one or more rounds of tool calls. Each iteration resolves the current
	// requires_action state and polls again until we hit a terminal status.
	while (run.status === 'requires_action') {
		const toolCalls = run.required_action?.submit_tool_outputs?.tool_calls || [];
		console.log(`[run] requires_action — ${toolCalls.length} tool call(s)`);

		const toolOutputs = [];
		for (const call of toolCalls) {
			const output = await dispatchToolCall(call);
			console.log(`  -> ${call.function.name}(${call.function.arguments}) => ${JSON.stringify(output).slice(0, 120)}...`);
			toolOutputs.push({
				tool_call_id: call.id,
				output: JSON.stringify(output),
			});
		}

		// v6 takes (runId, params) — thread_id goes inside params, not as a path arg.
		run = await openai.beta.threads.runs.submitToolOutputsAndPoll(run.id, {
			thread_id: thread.id,
			tool_outputs: toolOutputs,
		});
	}

	if (run.status !== 'completed') {
		console.error(`[run] terminated with status=${run.status}`);
		if (run.last_error) console.error(`  error: ${JSON.stringify(run.last_error)}`);
		// Best-effort cleanup (assistants are per-account resources)
		await openai.beta.assistants.delete(assistant.id).catch(() => {});
		process.exit(1);
	}

	const messages = await openai.beta.threads.messages.list(thread.id, { order: 'desc', limit: 10 });
	const reply = messages.data.find((m) => m.role === 'assistant');
	const replyText = reply?.content
		?.filter((c) => c.type === 'text')
		.map((c) => c.text.value)
		.join('\n\n');

	console.log('\n=============================================');
	console.log('Assistant reply:');
	console.log('=============================================');
	console.log(replyText || '(no text content)');
	console.log('=============================================\n');

	// Cleanup — don't leak one assistant per run into the account
	await openai.beta.assistants.delete(assistant.id).catch(() => {});
}

main().catch((err) => {
	console.error(`FATAL: ${err.message}`);
	if (err.stack) console.error(err.stack);
	process.exit(1);
});
