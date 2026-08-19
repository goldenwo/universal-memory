/**
 * cli/adr-graph.mjs — print the ADR relationship graph as Mermaid or DOT.
 *
 * The display half of issue #266, scoped to the one relationship layer that
 * carries real edges. ADR-0008 pre-authorized exactly this shape: "if the want
 * is display rather than query, no database is required at any foreseeable
 * scale — edges are derivable from ADR frontmatter and [[links]] and render as
 * Mermaid/DOT on demand."
 *
 * Derivation lives in cli/lib/adr-graph.mjs and reads decision FILES; see that
 * module's header for why the qdrant index is not a usable source today.
 *
 * Usage:
 *   node cli/adr-graph.mjs                        # mermaid, from docs/decisions
 *   node cli/adr-graph.mjs --format dot           # graphviz
 *   node cli/adr-graph.mjs --dir path/to/adrs
 *   node cli/adr-graph.mjs --format dot | dot -Tsvg -o adrs.svg
 *
 * Diagnostics (files skipped for missing frontmatter, dangling references) go
 * to stderr so stdout stays a clean, pipeable diagram.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAdrGraph, toMermaid, toDot } from './lib/adr-graph.mjs';

const USAGE = 'usage: adr-graph [--format mermaid|dot] [--dir <path>]  (default: --format mermaid --dir docs/decisions)';

export function parseArgs(argv) {
  const out = { format: 'mermaid', dir: 'docs/decisions' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') out.format = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (!['mermaid', 'dot'].includes(out.format)) {
    throw new Error(`unknown format: ${out.format} (expected mermaid or dot)`);
  }
  return out;
}

/** Read every `*.md` in `dir` as `{name, text}`, sorted for deterministic output. */
export async function readDecisionFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no decisions directory at '${dir}' (pass --dir to point elsewhere)`);
    throw e;
  }
  const names = entries.filter((n) => n.endsWith('.md')).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    text: await fs.readFile(path.join(dir, name), 'utf8'),
  })));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return; }

  const graph = buildAdrGraph(await readDecisionFiles(args.dir));
  console.log(args.format === 'dot' ? toDot(graph) : toMermaid(graph));

  // Honest reporting: an empty or thin graph should say so rather than let the
  // operator read "no edges drawn" as "no relations exist".
  console.error(`\n${graph.nodes.length} ADR(s), ${graph.edges.length} relation edge(s).`);
  if (graph.skipped.length) {
    console.error(`skipped (no frontmatter): ${graph.skipped.join(', ')}`);
  }
  for (const d of graph.dangling) {
    console.error(`dangling reference: ${d.from} -> ${d.to} (no such ADR in ${args.dir})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
