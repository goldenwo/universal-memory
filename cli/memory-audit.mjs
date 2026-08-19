/**
 * cli/memory-audit.mjs — audit the link structure of a markdown memory store.
 *
 * Answers the questions a knowledge-graph view is actually good for — what is
 * broken, what is orphaned, what is central, whether the store is one web or
 * several — and prints them as a report you run, read, act on, and close.
 *
 * Works on any directory of markdown notes using `[[wiki-link]]` syntax:
 * a universal-memory vault, or a Claude Code auto-memory directory
 * (`~/.claude/projects/<project>/memory/`), which is where hand-curated links
 * typically live.
 *
 * Usage:
 *   node cli/memory-audit.mjs --dir ~/.claude/projects/<project>/memory
 *   node cli/memory-audit.mjs --dir <path> --svg neighbourhood.svg
 *   node cli/memory-audit.mjs --dir <path> --svg out.svg --center some-note
 *
 * With no `--dir`, falls back to $UM_VAULT_DIR. The optional `--svg` writes a
 * labelled 2D diagram of one note's neighbourhood (the most-referenced note by
 * default) — deterministic, so the same store always yields the same picture.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLinkGraph, densestEgo } from './lib/link-audit.mjs';
import { renderReport, renderEgoSvg } from './lib/link-audit-report.mjs';

const USAGE = [
  'usage: memory-audit [--dir <path>] [--svg <file.svg>] [--center <note>]',
  '',
  '  --dir     directory of markdown notes (default: $UM_VAULT_DIR)',
  '  --svg     also write a neighbourhood diagram to this path',
  '  --center  note to centre the diagram on (default: most-referenced)',
].join('\n');

/** The store's own index file is a table of contents, not a note. */
const SKIP = new Set(['memory.md', 'readme.md', 'index.md']);

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--svg') out.svg = argv[++i];
    else if (a === '--center' || a === '--centre') out.center = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  return out;
}

/** Read every markdown note in `dir`, sorted, excluding index files. */
export async function readNotes(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no such memory directory: '${dir}' (pass --dir to point elsewhere)`);
    throw e;
  }
  const names = entries.filter((n) => n.endsWith('.md') && !SKIP.has(n.toLowerCase())).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    text: await fs.readFile(path.join(dir, name), 'utf8'),
  })));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return; }

  const dir = args.dir || env.UM_VAULT_DIR;
  if (!dir) throw new Error(`no directory given and UM_VAULT_DIR is unset\n${USAGE}`);

  const graph = buildLinkGraph(await readNotes(dir));
  console.log(renderReport(graph, { dir }));

  if (args.svg) {
    const center = args.center || densestEgo(graph);
    const svg = center ? renderEgoSvg(graph, center) : null;
    if (!svg) {
      console.error(`no neighbourhood to draw${center ? ` for '${center}'` : ''} — skipped ${args.svg}`);
    } else {
      await fs.writeFile(args.svg, svg, 'utf8');
      console.error(`wrote ${args.svg} (neighbourhood of ${center})`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
