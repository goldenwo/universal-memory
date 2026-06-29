/**
 * cli/lib/mem0-import-manifest.mjs — pure manifest layer for the mem0 → UM importer.
 *
 * The manifest is the durable, re-importable source of truth for the curated corpus
 * (text + provenance + keep/drop decision). It carries a schema_version so a future
 * importer can reject/migrate an old manifest rather than silently misread it. `keep`
 * is an INDEPENDENT stored field once the manifest exists — --apply gates SOLELY on it
 * and never re-derives from category, so operator override-keep/drop is honored exactly.
 *
 * Spec: docs/plans/2026-06-27-mem0-import-spec.md §4.3, §5, §6.
 */

export const MANIFEST_SCHEMA_VERSION = 1;
const ROW_KEYS = ['mem0_id', 'text', 'category', 'keep', 'reason', 'decided_by'];

export function serializeManifest(rows) {
  const header = JSON.stringify({ schema_version: MANIFEST_SCHEMA_VERSION });
  const body = rows.map((r) => JSON.stringify(Object.fromEntries(ROW_KEYS.map((k) => [k, r[k]]))));
  return [header, ...body].join('\n') + '\n';
}

export function parseManifest(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('manifest: empty');
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error('manifest: malformed header line (expected {"schema_version":N})');
  }
  if (header.schema_version !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `manifest: unsupported schema_version ${header.schema_version} (expected ${MANIFEST_SCHEMA_VERSION})`,
    );
  }
  const rows = lines.slice(1).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`manifest: malformed JSON on data line ${i + 1}`);
    }
  });
  return { version: header.schema_version, rows };
}

// FAIL CLOSED: throw on any malformed row, naming the offending data line (1-based).
export function validateManifest(rows) {
  const seen = new Set();
  rows.forEach((r, i) => {
    const line = i + 1;
    for (const k of ['mem0_id', 'text', 'category', 'reason']) {
      if (typeof r?.[k] !== 'string' || r[k] === '') throw new Error(`manifest line ${line}: missing/empty ${k}`);
    }
    if (typeof r.keep !== 'boolean') throw new Error(`manifest line ${line}: keep must be a boolean, got ${typeof r.keep}`);
    if (seen.has(r.mem0_id)) throw new Error(`manifest line ${line}: duplicate mem0_id ${r.mem0_id}`);
    seen.add(r.mem0_id);
  });
  return rows;
}

// Merge a fresh judge pass over an existing manifest: a row whose decided_by==='user'
// in `existing` wins (operator edits are never clobbered by a re-judge).
export function mergeUserEdits(judged, existing) {
  const userById = new Map(existing.filter((r) => r.decided_by === 'user').map((r) => [r.mem0_id, r]));
  return judged.map((r) => userById.get(r.mem0_id) ?? r);
}

// Provenance metadata written onto each imported qdrant point (flattened by
// buildPayload). NONE of these keys may collide with the server's reserved-field
// set (guarded by a unit test) or a future re-import would throw.
export const IMPORT_METADATA_KEYS = ['mem0_id', 'category', 'imported_at'];

export function buildImportMetadata({ mem0_id, category, importedAt }) {
  return { mem0_id, category, imported_at: importedAt };
}

export function countKeepers(rows) {
  return rows.filter((r) => r.keep === true).length;
}

// Human-readable review surface — grouped by keep then category, with an explicit
// `unjudged` section the operator must resolve before --apply.
export function renderReviewMd(rows) {
  const kept = rows.filter((r) => r.keep === true);
  const dropped = rows.filter((r) => r.keep === false && r.category !== 'unjudged');
  const unjudged = rows.filter((r) => r.category === 'unjudged');
  const group = (list) => {
    const byCat = {};
    for (const r of list) (byCat[r.category] ||= []).push(r);
    return (
      Object.entries(byCat)
        .map(([cat, rs]) => `### ${cat} (${rs.length})\n` + rs.map((r) => `- \`${r.mem0_id}\` — ${r.text}  _(${r.reason})_`).join('\n'))
        .join('\n\n') || '_(none)_'
    );
  };
  return [
    `# mem0 → UM import review`,
    `kept ${kept.length} / dropped ${dropped.length} / unjudged ${unjudged.length}`,
    ``,
    `## KEEP`,
    group(kept),
    ``,
    `## DROP`,
    group(dropped),
    ``,
    `## UNJUDGED — resolve before --apply`,
    group(unjudged),
    ``,
  ].join('\n');
}
