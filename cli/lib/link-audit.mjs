/**
 * cli/lib/link-audit.mjs — structural analysis of a wiki-linked markdown memory store.
 *
 * Answers the questions a graph *view* is genuinely good for, without being a
 * graph view. The research behind this choice is summarized in the #266 arc:
 * every credible defense of PKM graph views (Konik, the Zettelkasten.de forum,
 * Cognee's own docs) uses them for the same narrow purpose — orphan detection,
 * hub identification, broken-link discovery, component counting — and every one
 * concedes the global rendering is not what delivers it. Those are questions
 * with discrete answers, so this module computes the answers directly.
 *
 * Deliberately NOT a live force-directed canvas: force layouts are stochastic
 * (the picture changes between runs, so no mental map ever forms) and only
 * surface one kind of clustering, which can read as structure that is not
 * statistically there. For a store whose job is being trustworthy about what it
 * knows, a display that manufactures plausible structure over sparse data is a
 * liability, not a feature.
 *
 * Pure and I/O-free: callers supply `{name, text}` pairs. Zero dependencies.
 */

/** `[[target]]`, `[[target|alias]]`, `[[target#heading]]` — alias/heading discarded. */
const LINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

/** What a `name:` must look like to be a practical `[[link]]` target. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const stem = (filename) => String(filename).replace(/\.md$/i, '');

/**
 * Parse one note into `{key, links}`.
 *
 * `key` prefers the frontmatter `name:` slug, because that is what other notes
 * write inside `[[...]]`; the filename stem is the fallback and is also
 * registered as an alias by buildLinkGraph, since both spellings appear in real
 * stores.
 *
 * @param {string} name - Basename, e.g. `feedback_test_integrity.md`.
 * @param {string} text - Full file contents.
 * @returns {{key: string, file: string, links: string[]}}
 */
export function parseNote(name, text) {
  const body = String(text ?? '');
  const m = /^name:\s*(.+)$/m.exec(body);
  const key = (m ? m[1] : stem(name)).trim();

  const links = [];
  for (const match of body.matchAll(LINK_RE)) {
    const target = match[1].trim();
    if (target && !links.includes(target)) links.push(target);
  }
  return { key, file: name, links };
}

/** Spelling variants a link target may legitimately use for the same note. */
function aliasesFor(key, file) {
  return new Set([
    key.toLowerCase(),
    stem(file).toLowerCase(),
    key.replace(/-/g, '_').toLowerCase(),
    key.replace(/_/g, '-').toLowerCase(),
    stem(file).replace(/_/g, '-').toLowerCase(),
    stem(file).replace(/-/g, '_').toLowerCase(),
  ]);
}

/**
 * Analyze a whole store.
 *
 * Edges are UNDIRECTED and de-duplicated: the wiki-link convention routinely
 * asserts the same relation from both ends, and counting that twice would
 * inflate every density figure in the report.
 *
 * A link whose target does not resolve is recorded under `dangling` and is
 * NOT counted as an edge and does NOT create a node — a typo must read as a
 * defect, never as a phantom note.
 *
 * @param {Array<{name: string, text: string}>} files
 */
export function buildLinkGraph(files) {
  const notes = (files ?? []).map((f) => parseNote(f.name, f.text));
  notes.sort((a, b) => a.key.localeCompare(b.key));

  const resolve = new Map();
  for (const n of notes) {
    for (const a of aliasesFor(n.key, n.file)) {
      if (!resolve.has(a)) resolve.set(a, n.key);
    }
  }

  const inbound = new Map(notes.map((n) => [n.key, new Set()]));
  const outbound = new Map(notes.map((n) => [n.key, new Set()]));
  const edgeSet = new Set();
  const dangling = [];

  for (const n of notes) {
    for (const raw of n.links) {
      const target = resolve.get(raw.toLowerCase())
        ?? resolve.get(raw.replace(/-/g, '_').toLowerCase())
        ?? resolve.get(raw.replace(/_/g, '-').toLowerCase());
      if (!target) { dangling.push({ from: n.key, to: raw }); continue; }
      if (target === n.key) continue;
      outbound.get(n.key).add(target);
      inbound.get(target).add(n.key);
      // JSON, not a delimiter join: note keys legitimately contain spaces and
      // punctuation, so any single-character separator is either ambiguous or
      // a control byte that makes this source file read as binary.
      edgeSet.add(JSON.stringify([n.key, target].sort()));
    }
  }

  const nodes = notes.map((n) => ({
    key: n.key,
    file: n.file,
    inbound: inbound.get(n.key).size,
    outbound: outbound.get(n.key).size,
    degree: inbound.get(n.key).size + outbound.get(n.key).size,
  }));

  const edges = [...edgeSet].sort().map((e) => {
    const [a, b] = JSON.parse(e);
    return { a, b };
  });

  // Ranking ties break on key so repeated runs print the same order.
  const ranking = [...nodes].sort((x, y) => y.inbound - x.inbound || y.degree - x.degree || x.key.localeCompare(y.key));
  const orphans = nodes.filter((n) => n.degree === 0).map((n) => n.key);

  // A note whose `name:` is a sentence rather than a slug cannot be the target
  // of a `[[link]]` anyone would plausibly type — it is unlinkable by
  // construction, which is a different defect from merely being unlinked, and
  // explains a share of any orphan list.
  const unlinkable = nodes.filter((n) => !SLUG_RE.test(n.key)).map((n) => ({ key: n.key, file: n.file }));

  // Connected components over the undirected graph.
  const adj = new Map(notes.map((n) => [n.key, new Set([...outbound.get(n.key), ...inbound.get(n.key)])]));
  const seen = new Set();
  const components = [];
  for (const n of notes) {
    if (seen.has(n.key)) continue;
    const stack = [n.key];
    const comp = [];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      comp.push(cur);
      for (const next of adj.get(cur)) if (!seen.has(next)) stack.push(next);
    }
    comp.sort();
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

  dangling.sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));

  const n = nodes.length;
  return {
    nodes,
    edges,
    ranking,
    orphans,
    unlinkable,
    dangling,
    components,
    stats: {
      nodes: n,
      edges: edges.length,
      link_instances: notes.reduce((a, x) => a + x.links.length, 0),
      unlinkable: unlinkable.length,
      avg_degree: n ? Number(((2 * edges.length) / n).toFixed(2)) : 0,
      // A tree over N nodes has N-1 edges. Near zero means the store is barely
      // more than a hierarchy — which is worth knowing before drawing anything.
      excess_edges: edges.length - n,
      orphans: orphans.length,
      dangling: dangling.length,
      components: components.length,
      largest_component: components.length ? components[0].length : 0,
    },
  };
}

/**
 * Pick the most interesting node to centre a diagram on: the one whose
 * neighbours are most linked *to each other*.
 *
 * Deliberately not "most referenced". The most-referenced note in a memory
 * store is typically a bookkeeping hub (a session pointer, an index) whose
 * neighbourhood is a pure star — every spoke connected to the centre and to
 * nothing else. That picture shows filing convention, not knowledge. Ranking by
 * inter-neighbour links surfaces an actual cluster of related ideas instead.
 *
 * Returns null when nothing has a neighbourhood worth drawing.
 */
export function densestEgo(graph) {
  let best = null;
  for (const n of graph.nodes) {
    const ego = egoNetwork(graph, n.key);
    if (!ego) continue;
    const interlinks = ego.edges.length - ego.ring.length; // edges beyond the spokes
    const cand = { key: n.key, interlinks, ring: ego.ring.length };
    if (!best
      || cand.interlinks > best.interlinks
      || (cand.interlinks === best.interlinks && cand.ring > best.ring)
      || (cand.interlinks === best.interlinks && cand.ring === best.ring && cand.key.localeCompare(best.key) < 0)) {
      best = cand;
    }
  }
  return best ? best.key : null;
}

/** Neighbourhood of one node: the node, its neighbours, and every edge among them. */
export function egoNetwork(graph, key) {
  const neighbours = new Set();
  for (const e of graph.edges) {
    if (e.a === key) neighbours.add(e.b);
    else if (e.b === key) neighbours.add(e.a);
  }
  if (neighbours.size === 0) return null;

  const members = new Set([key, ...neighbours]);
  const edges = graph.edges.filter((e) => members.has(e.a) && members.has(e.b));
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  // Highest-degree neighbours first, ties on key — placement must not depend on
  // input order, or the picture moves between runs.
  const ring = [...neighbours].sort((x, y) => (byKey.get(y)?.degree ?? 0) - (byKey.get(x)?.degree ?? 0) || x.localeCompare(y));
  return { center: key, ring, edges };
}
