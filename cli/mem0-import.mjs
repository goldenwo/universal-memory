/**
 * cli/mem0-import.mjs — curated mem0 → UM fact importer (orchestrator).
 *
 * A kept, re-runnable migration + recovery tool (sibling to reindex.mjs). Four stages:
 *   --dump   read a hand-saved mem0 export (JSONL) → canonical {mem0_id, text}[] + completeness preflight
 *   --judge  LLM keep/drop classification → versioned manifest.jsonl + review.md (STOP for operator)
 *   --apply  fail-closed preflights → per-keeper skip/embed/lane-classify/delete-by-mem0_id-then-add
 *
 * Pure logic lives in cli/lib/mem0-import-judge.mjs + cli/lib/mem0-import-manifest.mjs.
 * Spec: docs/plans/2026-06-27-mem0-import-spec.md. Plan: docs/plans/2026-06-27-mem0-import-plan.md.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function md5(s) {
  return createHash('md5').update(s).digest('hex');
}

export function parseArgs(argv) {
  const out = { stage: null, workdir: null, manifest: null, source: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dump') out.stage = 'dump';
    else if (a === '--judge') out.stage = 'judge';
    else if (a === '--apply') out.stage = 'apply';
    else if (a === '--workdir') out.workdir = argv[++i];
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--source') out.source = argv[++i];
    else if (a === '--yes') out.yes = true;
  }
  return out;
}

// Source = a hand-saved JSONL export of mem0-pi facts (produced out-of-band via the
// mem0-pi memory_list MCP tool / getAll). Each line: {id, memory} (mem0's shape) OR
// {mem0_id, text}. Canonicalize to {mem0_id, text}; persist mem0-dump.jsonl. The COUNT
// is the corroboration boundary — the operator must confirm it equals mem0's total
// before any decommission (one-way migration).
export async function runDump({ source, workdir }) {
  const raw = await fs.readFile(source, 'utf8');
  const records = raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const o = JSON.parse(l);
      const mem0_id = o.mem0_id ?? o.id;
      const text = o.text ?? o.memory ?? '';
      if (!mem0_id || !text) throw new Error(`dump: row missing id/text: ${l.slice(0, 80)}`);
      return { mem0_id: String(mem0_id), text: String(text) };
    });
  await fs.mkdir(workdir, { recursive: true });
  await fs.writeFile(path.join(workdir, 'mem0-dump.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[dump] ${records.length} facts from ${source} -> ${path.join(workdir, 'mem0-dump.jsonl')}`);
  console.log(`[dump] COMPLETENESS: confirm ${records.length} == mem0-pi's total (memory_list) before decommissioning mem0.`);
  return { records, count: records.length };
}
