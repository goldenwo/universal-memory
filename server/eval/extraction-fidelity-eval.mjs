/**
 * extraction-fidelity-eval.mjs — Tier-2 #10. Runs the REAL facts() extraction over a labelled
 * fixture, judges extracted↔gold both directions (lib/extraction-grader.mjs), and scores
 * micro-averaged precision/recall (pure extractionFidelity). Sibling of answer-grader-eval.mjs.
 * One invocation = one run (run twice for stability). Live deps lazy-imported inside cliMain.
 *
 * Run (from server/):
 *   node --env-file=.env eval/extraction-fidelity-eval.mjs --fixture eval/extraction-set.jsonl --out eval/results/<date>-tier2-extraction-run1.json
 */
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { extractionFidelity, loadFixtureJsonl } from './memory-quality-eval.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--fixture') args.fixture = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

/** Normalize facts() output to a plain string list (factsInvoke returns string[]; defensive on objects). */
function normalizeExtracted(factsResult) {
  const f = factsResult?.facts;
  if (!Array.isArray(f)) return [];
  return f.map((x) => (typeof x === 'string' ? x : (x?.text ?? x?.memory ?? JSON.stringify(x)))).filter(Boolean);
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.fixture) { console.error('Usage: extraction-fidelity-eval.mjs --fixture <path> [--out <path>]'); process.exit(2); }
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) {
    console.error('[extraction-eval] OPENAI_API_KEY not set — run: node --env-file=.env eval/extraction-fidelity-eval.mjs --fixture eval/extraction-set.jsonl');
    process.exit(2);
  }

  const { facts } = await import('../lib/facts.mjs');
  const { judgeExtraction } = await import('../lib/extraction-grader.mjs');
  const model = process.env.UM_EXTRACTION_GRADER_MODEL ?? 'gpt-4o-mini';
  const rows = await loadFixtureJsonl(args.fixture);

  const judgedRows = [];
  for (const row of rows) {
    const gold = row.expected_facts ?? [];
    const extracted = normalizeExtracted(await facts(row.input_text, { temperature: 0 }));
    const v = await judgeExtraction(row.input_text, gold, extracted, { model });
    judgedRows.push({
      id: row.id, ok: v.ok,
      goldTotal: gold.length,
      goldMatched: v.goldMatched.filter(Boolean).length,
      extractedTotal: extracted.length,
      extractedSupported: v.extractedSupported.filter(Boolean).length,
    });
  }

  const extraction = extractionFidelity(judgedRows);
  const result = {
    timestamp: new Date().toISOString(), fixture: args.fixture, judgeModel: model,
    factsModel: process.env.UM_FACTS_MODEL ?? 'gpt-4.1-nano (provider default)',
    pinnable: extraction.parseFails === 0,
    extraction,
  };
  const out = args.out ?? fileURLToPath(new URL(`./results/${result.timestamp.slice(0, 10)}-extraction-run1.json`, import.meta.url));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  const e = result.extraction;
  console.log(`[extraction-eval] judge=${model} graded=${e.graded} parseFails=${e.parseFails} precision=${e.precision} recall=${e.recall} f1=${e.f1} noiseAbstained=${e.noiseAbstained}/${e.noiseTotal}`);
  console.log(`[extraction-eval] written to ${out}`);
  if (!result.pinnable) console.error(`[extraction-eval] WARNING: parseFails=${e.parseFails} > 0 — result NOT pinnable (treat as unmeasured); fix judge truncation/format before pinning targets.`);
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) cliMain().catch((e) => { console.error('[extraction-eval] FATAL:', e?.message ?? e); process.exit(1); });
