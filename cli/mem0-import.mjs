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
import { pathToFileURL } from 'node:url';
import { judgeFacts } from './lib/mem0-import-judge.mjs';
import {
  serializeManifest,
  parseManifest,
  mergeUserEdits,
  validateManifest,
  renderReviewMd,
  countKeepers,
  buildImportMetadata,
} from './lib/mem0-import-manifest.mjs';
import { umAdd } from '../server/lib/add.mjs';
import { embed } from '../server/lib/embed.mjs';
import { classifyLane } from '../server/lib/lane-classifier.mjs';

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

async function readExistingManifest(p) {
  try {
    return parseManifest(await fs.readFile(p, 'utf8')).rows;
  } catch {
    return [];
  }
}

// Build the prod LLM invoke (cheapest model). Injected as a seam in tests.
export function makeJudgeInvoke(env) {
  return async (system, user) => {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const model = env.UM_IMPORT_JUDGE_MODEL || env.UM_FACTS_MODEL || 'gpt-4.1-nano';
    const resp = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return {
      content: resp.choices?.[0]?.message?.content ?? '',
      usage: { tokensIn: resp.usage?.prompt_tokens ?? 0, tokensOut: resp.usage?.completion_tokens ?? 0 },
    };
  };
}

// Stage 2: judge keep/drop, merge over any existing (operator-edited) manifest, write
// the versioned manifest + review.md, then STOP. A cost-gate guards the LLM spend.
// Resume: a record already decided (decided_by==='user' OR a non-`unjudged` judge call)
// is carried forward verbatim, never re-judged (no re-spend). `unjudged` rows ARE
// re-judged. The judge returns no `text`, so it is joined back to each record's text.
export async function runJudge({ records, workdir, invoke, yes = false }) {
  await fs.mkdir(workdir, { recursive: true });
  const manifestPath = path.join(workdir, 'manifest.jsonl');
  const existing = await readExistingManifest(manifestPath);
  const existingById = new Map(existing.map((r) => [r.mem0_id, r]));
  const decidedIds = new Set(
    existing.filter((r) => r.decided_by === 'user' || r.category !== 'unjudged').map((r) => r.mem0_id),
  );

  if (!yes) {
    const todo = records.filter((r) => !decidedIds.has(r.mem0_id)).length;
    console.log(`[judge] COST: ~${todo} LLM classification calls (batched). Re-run with --yes to proceed.`);
    return { skipped: true };
  }

  const textById = new Map(records.map((r) => [r.mem0_id, r.text]));
  const judged = await judgeFacts(records, { invoke, alreadyJudged: decidedIds });
  const freshById = new Map(judged.map((r) => [r.mem0_id, { ...r, text: textById.get(r.mem0_id) ?? '' }]));

  // Record-order manifest: carry decided rows from `existing`, take fresh rows otherwise;
  // mergeUserEdits is the authoritative final "operator decision wins" pass.
  const rows = records.map((r) => (decidedIds.has(r.mem0_id) ? existingById.get(r.mem0_id) : freshById.get(r.mem0_id)));
  const merged = mergeUserEdits(rows, existing);
  validateManifest(merged);
  await fs.writeFile(manifestPath, serializeManifest(merged));
  await fs.writeFile(path.join(workdir, 'review.md'), renderReviewMd(merged));
  const kept = countKeepers(merged);
  console.log(`[judge] manifest + review written. kept ${kept}. STOP -- review review.md, edit manifest.jsonl, then --apply.`);
  return { kept, manifestPath };
}

// Reusable guard for an eval/scratch collection name (never write the live import there).
function isScratchCollection(name) {
  return /^eval_/.test(name) || (name !== 'memories' && /scratch|test/i.test(name));
}

// All --apply preflights fail CLOSED (throw) before any write. Stamp read + a probe
// embed are injected as seams (readStampFn, embedFn) so this is unit-testable offline.
export async function runApplyPreflights({ env, memory, rows, readStampFn, embedFn }) {
  // 1. MEM0_USER_ID required -- NO 'test-user' fallback (would strand the corpus
  //    in a partition the live server never reads).
  const userId = env.MEM0_USER_ID;
  if (!userId) throw new Error("--apply: MEM0_USER_ID is required (refusing reindex's test-user fallback)");

  // 2. Target guard -- never write the live import into a scratch/eval collection.
  const collection = memory.config.vectorStore.config.collectionName;
  if (isScratchCollection(collection)) {
    throw new Error(`--apply: refusing to write to scratch/eval collection '${collection}'`);
  }

  // 3. Manifest validation (fail-closed).
  validateManifest(rows);

  // 4. Embedding-stamp gate -- the importer's actual provider/model/dim (from a probe
  //    embed) must match the collection's stamp, else vectors land in a foreign space.
  //    A null stamp (fresh/unstamped collection) is allowed with a warning.
  const stamp = await readStampFn({ memory });
  const probe = await embedFn('_um_import_stamp_probe');
  if (!stamp) {
    console.warn(`[apply] WARN: collection '${collection}' has no embedding stamp (fresh collection assumed).`);
  } else if (stamp.provider !== probe.provider || stamp.model !== probe.model || stamp.dim !== probe.vector.length) {
    throw new Error(
      `--apply: embedding mismatch: collection stamp ${stamp.provider}/${stamp.model}/${stamp.dim} ` +
        `vs importer ${probe.provider}/${probe.model}/${probe.vector.length}`,
    );
  }
  return { userId, collection };
}

const importFilter = (userId, mem0_id) => ({
  must: [
    { key: 'userId', match: { value: userId } },
    { key: 'mem0_id', match: { value: mem0_id } },
  ],
});

// Stage 3 write loop. Drives the FULL manifest so operator drops are reconciled (not
// just keepers added). Per keeper: skip-if-unchanged (payload.hash == md5(text), 0
// embeds) else embed -> lane-classify -> delete-by-mem0_id -> umAdd(infer:false,
// _systemMigration:true). Delete-then-add keyed on mem0_id gives true idempotency.
export async function runApplyWrite({ memory, qc, collection, userId, rows, importedAt }) {
  // 1. Reconcile drops: delete any prior point for a keep:false row (no-op if absent).
  for (const r of rows.filter((x) => x.keep === false)) {
    await qc.delete(collection, { wait: true, filter: importFilter(userId, r.mem0_id) });
  }

  let written = 0;
  let skippedUnchanged = 0;
  let failed = 0;
  for (const r of rows.filter((x) => x.keep === true)) {
    try {
      // skip-if-unchanged FIRST (no embed): existing point with matching hash -> skip.
      const existing = await qc.scroll(collection, { filter: importFilter(userId, r.mem0_id), with_payload: true, limit: 1 });
      const cur = existing.points?.[0];
      if (cur && cur.payload?.hash === md5(r.text)) {
        skippedUnchanged++;
        continue;
      }
      // else: embed once -> classify lane from that vector -> delete prior -> add fresh.
      const { vector } = await embed(r.text);
      const { lane } = await classifyLane(vector);
      await qc.delete(collection, { wait: true, filter: importFilter(userId, r.mem0_id) });
      await umAdd({
        memory,
        text: r.text,
        userId,
        infer: false,
        _systemMigration: true,
        surface: 'mem0-import',
        metadata: { ...buildImportMetadata({ mem0_id: r.mem0_id, category: r.category, importedAt }), ...(lane ? { lane } : {}) },
        _qdrantClient: qc,
      });
      written++;
    } catch (e) {
      failed++;
      console.error(`[apply] FAILED mem0_id=${r.mem0_id}: ${e.message} (safe to re-run --apply)`);
    }
  }

  // Post-write assertion (userId-scoped): #points with surfaces 'mem0-import' == #keepers.
  const keepers = rows.filter((x) => x.keep === true).length;
  const counted = await qc.count(collection, {
    exact: true,
    filter: { must: [{ key: 'userId', match: { value: userId } }, { key: 'surfaces', match: { value: 'mem0-import' } }] },
  });
  if (counted.count !== keepers) {
    throw new Error(`[apply] count assertion failed: ${counted.count} mem0-import points != ${keepers} keepers (after reconcile)`);
  }
  console.log(
    `[apply] written ${written} / skipped-unchanged ${skippedUnchanged} / dropped ${rows.filter((x) => !x.keep).length} / failed ${failed}; count ${counted.count}`,
  );
  return { written, skippedUnchanged, failed, count: counted.count };
}

// CLI dispatch. The apply path's heavy deps (@qdrant, reindex/createMemoryInstance,
// embedding-stamp) are dynamic-imported so the module loads anywhere the stage
// functions are imported for testing; they resolve at runtime in the deps-flat image.
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const workdir = args.workdir || path.join(process.cwd(), '.mem0-import');

  if (args.stage === 'dump') {
    await runDump({ source: args.source, workdir });
  } else if (args.stage === 'judge') {
    const dump = await fs.readFile(path.join(workdir, 'mem0-dump.jsonl'), 'utf8');
    const records = dump.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    await runJudge({ records, workdir, invoke: makeJudgeInvoke(env), yes: args.yes });
  } else if (args.stage === 'apply') {
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const { createMemoryInstance } = await import('./reindex.mjs');
    const { readStamp } = await import('../server/lib/embedding-stamp.mjs');
    const collection = env.QDRANT_COLLECTION || 'memories';
    const memory = await createMemoryInstance({ env, collection });
    const qc = new QdrantClient({ host: env.QDRANT_HOST || 'localhost', port: parseInt(env.QDRANT_PORT || '6333', 10) });
    const { rows } = parseManifest(await fs.readFile(args.manifest || path.join(workdir, 'manifest.jsonl'), 'utf8'));
    const { userId } = await runApplyPreflights({ env, memory, rows, readStampFn: readStamp, embedFn: (t) => embed(t) });
    if (!args.yes) {
      console.log(`[apply] would write ${rows.filter((r) => r.keep).length} keepers to '${collection}' as userId=${userId}. Re-run with --yes.`);
      return;
    }
    await runApplyWrite({ memory, qc, collection, userId, rows, importedAt: new Date().toISOString() });
  } else {
    console.log('usage: mem0-import (--dump --source <jsonl> | --judge [--yes] | --apply [--manifest <path>] [--yes]) [--workdir <dir>]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
