/**
 * cli/lib/adr-graph.mjs — derive the ADR relationship graph from decision FILES.
 *
 * Issue #266 asked for a knowledge graph over four relationship layers. Measured
 * against production on 2026-08-18, three of those four hold zero edges and the
 * fourth (ADR frontmatter) is the only one with real, operator-curated relations
 * — see the "Measured supply" section of ADR-0008 for the counts and method.
 *
 * This module derives that fourth layer from `docs/decisions/*.md` directly,
 * NOT from the qdrant index, for three reasons the index cannot overcome today:
 *
 *   1. Git is authoritative. The index is a lossy copy: `create-adr.sh` builds
 *      its registration payload from a hardcoded metadata set that omits
 *      `supersedes`/`superseded_by` entirely, so the relations never arrive.
 *   2. [CORRECTED 2026-08-19 — this reason was FALSE and is retained only so the
 *      claim is not silently reintroduced.] It previously read: "universal-memory
 *      carries a `.um-self-host` marker, and create-adr deliberately skips
 *      registration for self-host repos — this repo's own ADRs are absent from
 *      the index by design." The self-host check (`_detect_self_application`)
 *      is called from `cmd_create` ONLY, and only when `--commit` was not
 *      passed; `cmd_sync` never calls it. This repo's ADRs 0004 and 0008 are in
 *      fact registered, carrying `repo_path` of this repo. Reasons 1 and 3 are
 *      each independently sufficient, so deriving from files remains correct.
 *   3. Even a fixed registration path would land nothing on re-registration:
 *      a dedup hit routes through mergeSurface, whose payload patch touches
 *      only surfaces/projects/dedupCount/dedupLastSeenAt and drops caller
 *      metadata on the floor.
 *
 * Reading files sidesteps all three, and has no cache to invalidate. It also
 * sidesteps the cross-repo identity collision that would bite an index-based
 * walk: `adr_id` is a per-repo counter, so ADR-0001 exists in both
 * universal-memory and claude-harness-toolkit. A per-repo file walk is scoped
 * to one counter space by construction.
 *
 * Zero dependencies and zero schema changes, per ADR-0008's binding
 * constraints (no graph engine, no new store, no standalone viewer).
 */

/** Frontmatter keys this module reads. Everything else is ignored. */
const SCALAR_KEYS = new Set(['id', 'title', 'status', 'superseded_by']);

/** `0004-kuzu-for-graph-memory` and `0004` both normalize to `0004`. */
function toKey(slug) {
  const m = /^\s*"?'?(\d{4})/.exec(String(slug ?? ''));
  return m ? m[1] : null;
}

function unquote(raw) {
  const s = String(raw ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** `null` / `~` / empty all mean "no value" in this frontmatter dialect. */
function isNullish(v) {
  return v === '' || v === 'null' || v === '~';
}

/**
 * Parse one ADR's frontmatter into a node, or return null when the file has no
 * frontmatter block at all.
 *
 * The null case is not an error: 5 of universal-memory's 8 ADRs predate the
 * frontmatter convention and open directly at `# ADR-NNNN:`. Retro-editing
 * settled decision records to satisfy a viewer would invert the value order,
 * so the walk reports them as skipped and carries on.
 *
 * CRLF is tolerated deliberately. The bash parser in create-adr.sh compares
 * lines with `[ "$line" = "---" ]`, which a CRLF file fails — ADR-0004 hit
 * exactly that. Stripping `\r` here costs one character and removes a class of
 * platform-dependent failure.
 *
 * @param {string} name - Basename, used as the key fallback when `id` is absent.
 * @param {string} text - Full file contents.
 * @returns {{key: string, title: string, status: string, supersedes: string[], supersededBy: string|null}|null}
 */
export function parseAdrFile(name, text) {
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0]?.trim() !== '---') return null;

  const fm = {};
  const supersedes = [];
  let listKey = null;
  let closed = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') { closed = true; break; }

    // Block-list continuation: `  - "0004-slug"` under a `supersedes:` header.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey === 'supersedes') {
      supersedes.push(unquote(item[1]));
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rest] = kv;
    const value = rest.trim();
    listKey = null;

    if (key === 'supersedes') {
      if (value === '') { listKey = 'supersedes'; continue; }       // block list follows
      const flow = /^\[(.*)\]$/.exec(value);                        // inline flow list
      if (flow) {
        for (const part of flow[1].split(',')) {
          const v = unquote(part);
          if (v) supersedes.push(v);
        }
      } else if (!isNullish(value)) {
        supersedes.push(unquote(value));                            // bare scalar
      }
      continue;
    }
    if (SCALAR_KEYS.has(key)) fm[key] = unquote(value);
  }

  if (!closed) return null;

  const key = toKey(fm.id) ?? toKey(name);
  if (!key) return null;

  return {
    key,
    title: fm.title || '',
    status: fm.status || '',
    supersedes: supersedes.map(toKey).filter(Boolean),
    supersededBy: isNullish(fm.superseded_by ?? '') ? null : toKey(fm.superseded_by),
  };
}

/**
 * Build the graph from a list of `{name, text}` decision files.
 *
 * Edge de-duplication is the load-bearing detail. The convention records each
 * relation from BOTH ends — the newer ADR carries `supersedes: [old]` and the
 * older carries `superseded_by: new` — so a naive walk double-counts every
 * edge. universal-memory's single real relation (0008 → 0004) is asserted
 * twice in exactly this way; it is one edge.
 *
 * A reference to an ADR that does not exist in the directory is reported under
 * `dangling` rather than silently materializing a node, so a typo in
 * frontmatter surfaces as a diagnostic instead of a phantom decision.
 *
 * @param {Array<{name: string, text: string}>} files
 * @returns {{nodes: Array, edges: Array<{from: string, to: string}>, skipped: string[], dangling: Array<{from: string, to: string}>}}
 */
export function buildAdrGraph(files) {
  const nodes = [];
  const skipped = [];

  for (const f of files ?? []) {
    const adr = parseAdrFile(f.name, f.text);
    if (adr) nodes.push(adr);
    else skipped.push(f.name);
  }
  nodes.sort((a, b) => a.key.localeCompare(b.key));

  const known = new Set(nodes.map((n) => n.key));
  const seen = new Set();
  const edges = [];
  const dangling = [];

  const add = (from, to) => {
    if (!from || !to || from === to) return;
    const id = `${from}>${to}`;
    if (seen.has(id)) return;
    seen.add(id);
    (known.has(from) && known.has(to) ? edges : dangling).push({ from, to });
  };

  for (const n of nodes) {
    for (const target of n.supersedes) add(n.key, target);   // newer -> older
    if (n.supersededBy) add(n.supersededBy, n.key);          // same direction, other end
  }

  return { nodes, edges, skipped, dangling };
}

/** Mermaid reserves `"` inside node labels; `#quot;` is its documented escape. */
function mermaidLabel(s) {
  return String(s).replace(/"/g, '#quot;');
}

/**
 * Render as a Mermaid `graph LR`. Output is deterministic (nodes are sorted in
 * buildAdrGraph, edges follow node order) so it can be committed or diffed.
 */
export function toMermaid(graph) {
  const out = ['graph LR'];
  for (const n of graph.nodes) {
    out.push(`  ${n.key}["${n.key}: ${mermaidLabel(n.title || '(untitled)')}"]`);
  }
  for (const e of graph.edges) {
    out.push(`  ${e.from} -->|supersedes| ${e.to}`);
  }
  out.push('  classDef superseded stroke-dasharray: 4 3,opacity:0.65');
  for (const n of graph.nodes) {
    if (/^superseded$/i.test(n.status)) out.push(`  class ${n.key} superseded`);
  }
  return out.join('\n');
}

/** Render as Graphviz DOT — same graph, for `dot -Tsvg`. */
export function toDot(graph) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const out = ['digraph adrs {', '  rankdir=LR;', '  node [shape=box, fontname="monospace"];'];
  for (const n of graph.nodes) {
    const style = /^superseded$/i.test(n.status) ? ', style=dashed' : '';
    out.push(`  "${n.key}" [label="${esc(n.key)}: ${esc(n.title || '(untitled)')}"${style}];`);
  }
  for (const e of graph.edges) {
    out.push(`  "${e.from}" -> "${e.to}" [label="supersedes"];`);
  }
  out.push('}');
  return out.join('\n');
}
