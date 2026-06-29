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
  const header = JSON.parse(lines[0]);
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
