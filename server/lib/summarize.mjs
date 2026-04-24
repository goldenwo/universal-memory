// server/lib/summarize.mjs — extensible summarizer backend registry
//
// EXTENDING: to add a new summarizer backend (v0.7 will add anthropic + google):
//   1. Write an invoke function with signature:
//      async function myBackendInvoke(transcript, ctx = {}) { ... return { summary, costUsd, tokensIn, tokensOut }; }
//   2. Add it to BACKENDS below: { myBackend: { invoke: myBackendInvoke, requires: ['MY_API_KEY'] } }
//   3. Add a test case to summarize.test.mjs — the test loops over Object.keys(BACKENDS) so
//      registering a new backend automatically adds it to the test matrix.
//   4. Optionally add a fallback relationship (e.g. { 'claude-agent-sdk': { invoke: null, fallback: 'openai' } }).
// No changes to update-state.mjs, checkpoint.mjs, or hooks/lib/summarize.sh required.

export const BACKENDS = {
  openai:             { invoke: openaiInvoke,  requires: ['UM_OPENAI_API_KEY', 'OPENAI_API_KEY'] },
  ollama:             { invoke: ollamaInvoke,  requires: [] /* host-bind enough */ },
  'claude-agent-sdk': { invoke: null, fallback: 'openai', reason: 'Docker cannot spawn host CC' },
};

/**
 * Summarize a transcript using the configured backend.
 *
 * @param {string} transcript - Text to summarize
 * @param {object} ctx - Options / DI overrides
 * @param {string}  [ctx.backend]        - Backend name (default: UM_SUMMARIZER env var or 'openai')
 * @param {object}  [ctx.openaiClient]   - Pre-made OpenAI client (for test stubbing)
 * @param {Function}[ctx.ollamaFetch]    - fetch replacement for ollama (for test stubbing)
 * @param {string}  [ctx.model]          - Model override
 * @param {string}  [ctx.systemPrompt]   - System prompt prepended to transcript
 * @param {number}  [ctx.temperature]    - Temperature override
 * @param {string}  [ctx.ollamaHost]     - Ollama host override
 * @returns {Promise<{summary: string, costUsd: number, tokensIn: number, tokensOut: number}>}
 */
export async function summarize(transcript, ctx = {}) {
  const name = ctx.backend ?? process.env.UM_SUMMARIZER ?? 'openai';
  const b = BACKENDS[name];
  if (!b || !b.invoke) {
    const fallback = b?.fallback ?? process.env.UM_SUMMARIZER_FALLBACK ?? 'openai';
    console.warn(`[summarize] backend='${name}' ${b?.reason ?? 'unknown/unavailable'} — falling back to ${fallback}`);
    return BACKENDS[fallback].invoke(transcript, ctx);
  }
  return b.invoke(transcript, ctx);
}

// DI for tests: per-backend invoke functions accept ctx.openaiClient / ctx.ollamaFetch for stubbing.

async function openaiInvoke(transcript, ctx) {
  // Friendly error if no API key is configured (avoids SDK's cryptic stack trace)
  if (!ctx.openaiClient && !process.env.UM_OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error('summarize backend=openai requires UM_OPENAI_API_KEY or OPENAI_API_KEY env var');
  }
  // Lazy-import openai SDK; in ctx, accept a pre-made client for test stubbing
  const client = ctx.openaiClient ?? new (await import('openai')).default({
    apiKey: process.env.UM_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  });
  const model = ctx.model ?? process.env.UM_SUMMARIZE_MODEL ?? 'gpt-4o-mini';
  const systemPrompt = ctx.systemPrompt ?? '';
  const response = await client.chat.completions.create({
    model,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      { role: 'user', content: transcript },
    ],
    temperature: ctx.temperature ?? 0.2,
  });
  const summary = response.choices[0].message.content;
  const tokensIn = response.usage?.prompt_tokens ?? 0;
  const tokensOut = response.usage?.completion_tokens ?? 0;
  // Rough cost for gpt-4o-mini as of 2026: $0.15/1M input, $0.60/1M output
  const costUsd = (tokensIn / 1e6) * 0.15 + (tokensOut / 1e6) * 0.60;
  return { summary, costUsd, tokensIn, tokensOut };
}

async function ollamaInvoke(transcript, ctx) {
  const fetchFn = ctx.ollamaFetch ?? globalThis.fetch;
  const host = ctx.ollamaHost ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const model = ctx.model ?? process.env.UM_SUMMARIZE_MODEL ?? 'llama3';
  const systemPrompt = ctx.systemPrompt ?? '';
  const prompt = systemPrompt ? `${systemPrompt}\n\n${transcript}` : transcript;
  const res = await fetchFn(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`ollama invoke failed: ${res.status}`);
  const data = await res.json();
  return {
    summary: data.response,
    costUsd: 0,  // ollama is local
    tokensIn: data.prompt_eval_count ?? 0,
    tokensOut: data.eval_count ?? 0,
  };
}
