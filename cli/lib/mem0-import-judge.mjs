/**
 * cli/lib/mem0-import-judge.mjs — pure judge rubric for the mem0 → UM importer.
 *
 * Classifies each mem0 fact keep/drop via an injected LLM (the `invoke` seam), so
 * the parsing/validation logic is unit-testable with no network. Off-enum, missing,
 * or malformed results become category `unjudged` (NEVER a silent drop) so a judge
 * fault is a distinguishable, re-judgeable state. `keep` is DERIVED from the category
 * (a default written by the judge; it becomes an independent stored field in the
 * manifest — see cli/lib/mem0-import-manifest.mjs).
 *
 * Spec: docs/plans/2026-06-27-mem0-import-spec.md §4.2.
 */

export const KEEP_CATEGORIES = ['personal', 'dev'];
export const DROP_CATEGORIES = ['ephemeral', 'stale_ops', 'junk', 'ops_domain'];
export const ALL_CATEGORIES = [...KEEP_CATEGORIES, ...DROP_CATEGORIES];

export function deriveKeep(category) {
  return KEEP_CATEGORIES.includes(category);
}

// Validate one judged row; off-enum/missing → 'unjudged' (NOT a silent drop).
function normalizeRow(mem0_id, raw) {
  const category = ALL_CATEGORIES.includes(raw?.category) ? raw.category : 'unjudged';
  const reason = typeof raw?.reason === 'string' ? raw.reason : '';
  return { mem0_id, category, keep: deriveKeep(category), reason, decided_by: 'judge' };
}

// Parse one batch LLM response against the expected ids. Every id gets a row;
// malformed JSON or missing ids become 'unjudged' so nothing is silently lost.
export function parseJudgeResponse(content, expectedIds) {
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }
  const list = Array.isArray(parsed?.results) ? parsed.results : [];
  const byId = new Map(list.filter((r) => r?.mem0_id != null).map((r) => [String(r.mem0_id), r]));
  return expectedIds.map((id) => normalizeRow(id, byId.get(String(id))));
}

export function buildJudgeSystemPrompt() {
  return [
    "You curate an operator's memory facts for import into a work-context memory store.",
    'Classify EACH fact into exactly one category:',
    'KEEP categories:',
    '  personal — durable identity, preferences, working style, hard rules (e.g. "never read .env files", "uses EST").',
    '  dev — durable cross-project development/work-context (e.g. "edge-catcher repo is private").',
    'DROP categories:',
    '  ephemeral — bare timestamps, session/filename markers, point-in-time noise.',
    '  stale_ops — dead or since-changed operational state (cron flips, config tweaks).',
    '  junk — contentless or duplicate (e.g. "Current memory is empty").',
    '  ops_domain — durable but out-of-scope infrastructure/operational facts about other systems',
    "               (Discord bot, Pi host, trading services): true, but NOT this store's domain.",
    'Keep only durable, currently-true, in-scope (personal/dev) facts. When unsure, prefer a DROP category.',
    'Respond with JSON ONLY: {"results":[{"mem0_id":"<id>","category":"<one-category>","reason":"<short>"}]}',
    'Return one entry per fact id given, no extra commentary.',
  ].join('\n');
}

export function buildJudgeUserPrompt(facts) {
  const lines = facts.map((f) => `- id '${f.mem0_id}': ${JSON.stringify(f.text)}`);
  return `Classify these facts:\n${lines.join('\n')}`;
}

// Batch the facts, call the injected LLM `invoke(system, user) -> {content, usage}`,
// parse each batch. A throwing/transient invoke makes that batch's ids 'unjudged'
// (never lost). `alreadyJudged` (Set of mem0_id) is skipped (resume without re-spend).
export async function judgeFacts(facts, { invoke, batchSize = 25, alreadyJudged = new Set() } = {}) {
  const todo = facts.filter((f) => !alreadyJudged.has(f.mem0_id));
  const system = buildJudgeSystemPrompt();
  const out = [];
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const ids = batch.map((f) => f.mem0_id);
    try {
      const { content } = await invoke(system, buildJudgeUserPrompt(batch));
      out.push(...parseJudgeResponse(content, ids));
    } catch {
      out.push(
        ...ids.map((id) => ({ mem0_id: id, category: 'unjudged', keep: false, reason: 'judge_error', decided_by: 'judge' })),
      );
    }
  }
  return out;
}
