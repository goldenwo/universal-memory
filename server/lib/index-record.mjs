// server/lib/index-record.mjs — #362: the record a vault doc is indexed as.
//
// One rule for reindexDoc, POST /api/reindex and the model-migration CLI (cli/reindex.mjs):
// what is admitted, which text is embedded and which metadata is stored. Before #362 the CLI
// kept its own copy, admitted every .md (raw captures, state.md) and embedded the body without
// the title. Pure, no IO.

const REQUIRED_FIELDS = Object.freeze(['type', 'id', 'title']);

/**
 * @param {{ frontmatter: object, body: string }} parsed  parseFrontmatter() output
 * @returns {{ ok: true, id: string, text: string, metadata: object }
 *   | { ok: false, reason: 'missing_fields', missing: string[] }
 *   | { ok: false, reason: 'state' }}
 *   `missing_fields`: not a vault doc (a raw capture carries no frontmatter at all).
 *   `state`: state.md is served by /api/state and never indexed (C2).
 */
export function indexRecord({ frontmatter: fm, body }) {
  const missing = REQUIRED_FIELDS.filter((k) => !fm[k]);
  if (missing.length > 0) return { ok: false, reason: 'missing_fields', missing };
  if (fm.type === 'state') return { ok: false, reason: 'state' };
  return {
    ok: true,
    id: fm.id,
    text: `${fm.title}\n\n${body.trim()}`,
    metadata: { schema_version: 1, ...fm },
  };
}
