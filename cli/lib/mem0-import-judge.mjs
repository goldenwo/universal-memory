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
