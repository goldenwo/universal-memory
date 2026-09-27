/**
 * server/eval/state-cap-eval.mjs — #326 keyed eval: the decisive review for the merge PROMPT.
 *
 * Spec: docs/plans/2026-09-25-326-state-cap-section-aware-spec.md §4.2.5. Sibling of
 * checkpoint-cost-eval.mjs: the PURE parts (the matcher, the labels' positive control, the
 * pass-1 and pass-2 measurements, the threshold aggregation) are named exports unit-tested
 * offline in test/state-cap-eval.test.mjs; the CLI shim (inputs on disk, the real summarize,
 * the keyed arms) is guarded by IS_MAIN so importing this module never calls a provider.
 *
 * Inputs (gitignored, main checkout only — pass absolute paths):
 *   <dir>/state/<project>/state.md, <dir>/sessions/<project>/<summary>.md, <dir>/../labels.json
 *
 * Usage (from server/, OPENAI_API_KEY in .env):
 *   node --env-file=.env eval/state-cap-eval.mjs --inputs <dir> --prompt-dir <dir> --arm old|new --out <pass1.json>
 *   node --env-file=.env eval/state-cap-eval.mjs --inputs <dir> --prompt-dir <dir> --pass2 <pass1-new.json> --out <pass2.json>
 *   node eval/state-cap-eval.mjs --aggregate --old <pass1-old.json> --new <pass1-new.json> --pass2-results <pass2.json> --out <aggregate.json>
 *
 * Per-project files carry raw model text and stay under docs/plans/… (gitignored); the
 * aggregate carries numbers only (spec 4.2.5 "Results").
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseState,
  ageInFlight,
  REQUIRED_SECTIONS,
  SECTION_LIMITS,
  STATE_CAP_CHARS,
} from '../lib/state-cap.mjs';

const DAY_MS = 86_400_000;
const RETENTION_SECTIONS = ['In flight', 'Next actions'];
const DECISION_DATE_RE = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})/;
const STAMP_RE = /^(.*?) \[(\d{4}-\d{2}-\d{2})\]\s*$/;
const BACKDATE_DAYS = 20;

// ---------------------------------------------------------------------------
// The matcher (spec 4.2.5 "Matcher")
// ---------------------------------------------------------------------------
/** Delete `* \` _ ( ) [ ]`, collapse whitespace, case-fold. Applied to keys and lines alike. */
export function normalise(s) {
  return s.replace(/[*`_()[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** Index of the first line whose normalised text contains the normalised key, else -1. */
export function findKey(key, lines) {
  const nk = normalise(key);
  if (!nk) return -1;
  return lines.findIndex(l => normalise(l).includes(nk));
}
/**
 * An output entry EXTENDS a cut-off Recent-decisions line when the normalised cut-off text,
 * with its trailing partial word dropped, is a prefix of the normalised entry.
 */
export function extendsCutoff(entry, cutoff) {
  if (!cutoff) return false;
  const c = normalise(cutoff).replace(/\s*\S+$/, '');
  return c.length > 0 && normalise(entry).startsWith(c);
}

// ---------------------------------------------------------------------------
// Units and sections
// ---------------------------------------------------------------------------
const isItem = u => !u.blank && !u.placeholder && u.lines.join('\n').trim() !== '...';
function requiredSection(md, name) {
  return parseState(md).sections.find(s => s.required && s.name === name) ?? null;
}
function sectionUnits(md, name) {
  return (requiredSection(md, name)?.units ?? []).filter(isItem);
}
function sectionLines(md, names) {
  return names.flatMap(n => sectionUnits(md, n).flatMap(u => u.lines));
}
const unitText = u => u.lines.join('\n');
const leadingDate = text => DECISION_DATE_RE.exec(text)?.[1] ?? null;
const ymd = d => new Date(d).toISOString().slice(0, 10);
const dayAfter = day => ymd(new Date(`${day}T00:00:00Z`).getTime() + DAY_MS);
const stripStamp = line => line.replace(/ \[\d{4}-\d{2}-\d{2}\]\s*$/, '');

// ---------------------------------------------------------------------------
// Positive control (three parts, before any arm)
// ---------------------------------------------------------------------------
/**
 * On the unchanged inputs: (1) the matcher finds every key; (2) each key matches exactly one
 * labelled unit; (3) every unit parseState finds in In flight / Next actions (bullets and
 * numbered items; not the old slice's trailing `...`) carries a label. The eval refuses to run
 * when any part fails.
 */
export function positiveControl(inputs, labels) {
  const out = { ok: true, keys_total: 0, keys_found: 0, units_parsed: 0, units_labelled: 0, missing: [], ambiguous: [], unlabelled: [] };
  for (const [project, lab] of Object.entries(labels)) {
    const md = inputs[project];
    if (typeof md !== 'string') { out.ok = false; out.missing.push({ project, key: '(input doc missing)' }); continue; }
    const units = RETENTION_SECTIONS.flatMap(n => sectionUnits(md, n).map(u => ({ section: n, lines: u.lines })));
    out.units_parsed += units.length;
    out.units_labelled += lab.units.length;
    const covered = new Set();
    for (const u of lab.units) {
      out.keys_total++;
      const nk = normalise(u.key);
      const hits = units.map((x, i) => (nk && x.lines.some(l => normalise(l).includes(nk)) ? i : -1)).filter(i => i >= 0);
      if (hits.length === 0) { out.ok = false; out.missing.push({ project, key: u.key }); continue; }
      out.keys_found++;
      if (hits.length > 1) { out.ok = false; out.ambiguous.push({ project, key: u.key, count: hits.length }); }
      for (const i of hits) covered.add(i);
    }
    units.forEach((x, i) => {
      if (!covered.has(i)) { out.ok = false; out.unlabelled.push({ project, section: x.section, text: x.lines[0].slice(0, 80) }); }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pass 1 (both arms), per doc on the RAW model output
// ---------------------------------------------------------------------------
export function pass1Metrics({ raw, input, labels, suppliedDate, report }) {
  const futureAfter = dayAfter(suppliedDate);
  const p = parseState(raw);
  const headings = p.sections.filter(s => s.required).length;
  const inflight = sectionUnits(raw, 'In flight');
  const cf = sectionUnits(raw, 'Current focus');

  // Dating: every entry absent from the input starts with the supplied date; every entry
  // present is byte-identical or extends a pre-labelled cut-off line.
  const inputEntries = sectionUnits(input, 'Recent decisions').map(unitText);
  const inputSet = new Set(inputEntries);
  const inputDates = new Set(inputEntries.map(leadingDate).filter(Boolean));
  const cutoff = labels.cutoff_decision_line ?? null;
  const cutoffDate = cutoff ? leadingDate(cutoff) : null;
  const dating = { new_entries: 0, invented: 0, changed_existing: 0, extended: 0 };
  let futureDecisionDates = 0;
  const datedInOrder = [];
  for (const u of sectionUnits(raw, 'Recent decisions')) {
    const text = unitText(u);
    const date = leadingDate(text);
    if (date) datedInOrder.push(date);
    if (inputSet.has(text)) continue;
    if (cutoff && extendsCutoff(u.lines[0], cutoff)) {
      dating.extended++;
      if (cutoffDate && date !== cutoffDate) dating.invented++;
      continue;
    }
    if (date && inputDates.has(date) && date !== suppliedDate) {
      dating.changed_existing++;
      dating.invented++;
      continue;
    }
    dating.new_entries++;
    if (date !== suppliedDate) dating.invented++;
    if (date && date > futureAfter) futureDecisionDates++;
  }
  const orderClean = datedInOrder.every((d, i) => i === 0 || d >= datedInOrder[i - 1]);

  // Retention: per section, dropped_live <= max(0, live - limit) and no dropped live unit is mentioned.
  const outLines = sectionLines(raw, RETENTION_SECTIONS);
  const mentioned = new Set((labels.pass2 ?? []).filter(k => k.mentioned).map(k => normalise(k.key)));
  const retention = { ok: true, has_live: false, sections: {} };
  for (const name of RETENTION_SECTIONS) {
    const live = labels.units.filter(u => u.section === name && u.label === 'live');
    if (live.length) retention.has_live = true;
    const dropped = live.filter(u => findKey(u.key, outLines) < 0);
    const allowed = Math.max(0, live.length - SECTION_LIMITS[name]);
    const droppedMentioned = dropped.filter(u => mentioned.has(normalise(u.key))).map(u => u.key);
    retention.sections[name] = { live: live.length, dropped_live: dropped.length, allowed, dropped_mentioned: droppedMentioned };
    if (dropped.length > allowed || droppedMentioned.length) retention.ok = false;
  }

  // Stale carry: raw In-flight units citing an issue closed before covers_until, with their stamp.
  const staleCarry = [];
  for (const [ref, closedAt] of Object.entries(labels.stale_issue_refs ?? {})) {
    for (const u of inflight) {
      if (unitText(u).includes(ref)) staleCarry.push({ ref, stamp: u.stamp ?? null, closed_at: closedAt });
    }
  }

  return {
    length: raw.length,
    raw_le_cap: raw.length <= STATE_CAP_CHARS,
    headings,
    headings_missing: REQUIRED_SECTIONS.filter(n => !p.sections.some(s => s.required && s.name === n)),
    inflight_units: inflight.length,
    all_stamped: inflight.every(u => Boolean(u.stamp)),
    unstamped: inflight.filter(u => !u.stamp).length,
    future_stamps: inflight.filter(u => u.stamp && u.stamp > futureAfter).length,
    future_decision_dates: futureDecisionDates,
    current_focus_len: cf.reduce((n, u) => n + u.size, 0),
    dating,
    order_clean: orderClean,
    retention,
    stale_carry: staleCarry,
    report,
  };
}

// ---------------------------------------------------------------------------
// Pass 2 (NEW arm), the ageing pass
// ---------------------------------------------------------------------------
/**
 * Back-date the pre-selected keys found in a pass-1 raw output to `backdatedDate`. Returns the
 * modified doc and the selection with `backdated` / `excluded` per key (a key not found, or found
 * unstamped, is reported and excluded).
 */
export function backdateSelected(raw1, pass2Keys, backdatedDate) {
  const lines = raw1.split('\n');
  const section = requiredSection(raw1, 'In flight');
  const firstLines = new Map(); // normalised first line -> line index in `lines`
  if (section) {
    for (const u of section.units.filter(isItem)) {
      const idx = lines.indexOf(u.lines[0]);
      if (idx >= 0) firstLines.set(u.lines[0], idx);
    }
  }
  const selected = [];
  for (const k of pass2Keys) {
    const nk = normalise(k.key);
    const hit = [...firstLines.entries()].find(([first]) => normalise(first).includes(nk));
    if (!hit) { selected.push({ ...k, backdated: false, excluded: 'not found in the pass-1 raw output' }); continue; }
    const [first, idx] = hit;
    const m = STAMP_RE.exec(first);
    if (!m) { selected.push({ ...k, backdated: false, excluded: 'unstamped in the pass-1 raw output' }); continue; }
    lines[idx] = `${m[1]} [${backdatedDate}]`;
    selected.push({ ...k, backdated: true, original_stamp: m[2] });
  }
  return { md: lines.join('\n'), selected };
}

export function pass2Conditions({ input2, raw2, written2, selected, suppliedDate, backdatedDate, now, asOf }) {
  const inflight2 = sectionUnits(input2, 'In flight');
  const n = inflight2.length;
  const rawUnits = sectionUnits(raw2, 'In flight');
  const rawLines = rawUnits.flatMap(u => u.lines);
  const writtenLines = sectionLines(written2, ['In flight']);
  const findUnit = key => rawUnits.find(u => u.lines.some(l => normalise(l).includes(normalise(key)))) ?? null;
  const asOfIso = asOf ?? now;
  const agedRaw = ageInFlight(raw2, { asOf: asOfIso, now }).md;
  const agedLines = sectionLines(agedRaw, ['In flight']);

  const cond1 = { ok: true, failures: [] };
  const cond2 = { ok: true, failures: [], removed_by_bound: [] };
  let backdatedDroppedByModel = 0;
  for (const k of selected.filter(s => s.backdated)) {
    const unit = findUnit(k.key);
    if (!unit) backdatedDroppedByModel++;
    if (!k.mentioned) {
      // NOT re-stamped (absent, or present with the back-dated stamp) AND absent from the written doc.
      const reasons = [];
      if (unit && unit.stamp !== backdatedDate) reasons.push(`re-stamped ${unit.stamp ?? '(unstamped)'}`);
      if (findKey(k.key, writtenLines) >= 0) reasons.push('still in the written doc (not aged)');
      if (reasons.length) { cond1.ok = false; cond1.failures.push({ key: k.key, reason: reasons.join('; ') }); }
    } else {
      // carries the supplied date in the raw output and is not removed by ageing.
      if (!unit) { cond2.ok = false; cond2.failures.push({ key: k.key, reason: 'dropped by the model' }); continue; }
      if (unit.stamp !== suppliedDate) { cond2.ok = false; cond2.failures.push({ key: k.key, reason: `stamp ${unit.stamp ?? '(unstamped)'}, expected ${suppliedDate}` }); continue; }
      if (findKey(k.key, agedLines) < 0) { cond2.ok = false; cond2.failures.push({ key: k.key, reason: 'removed by ageInFlight' }); continue; }
      if (findKey(k.key, writtenLines) < 0) cond2.removed_by_bound.push(k.key);
    }
  }

  // (3) supplied-date units the model dropped number <= max(0, n - 8) and none is mentioned.
  const mentionedKeys = selected.filter(s => s.mentioned).map(s => normalise(s.key));
  const droppedSupplied = inflight2.filter(u => u.stamp === suppliedDate && findKey(stripStamp(u.lines[0]), rawLines) < 0);
  const droppedMentioned = droppedSupplied.filter(u => mentionedKeys.some(k => normalise(u.lines[0]).includes(k))).map(u => u.lines[0].slice(0, 60));
  const allowed = Math.max(0, n - SECTION_LIMITS['In flight']);
  const cond3 = { ok: droppedSupplied.length <= allowed && droppedMentioned.length === 0, dropped_supplied: droppedSupplied.length, allowed, dropped_mentioned: droppedMentioned };

  return { n, cond1, cond2, cond3, backdated_dropped_by_model: backdatedDroppedByModel, all_ok: cond1.ok && cond2.ok && cond3.ok };
}

// ---------------------------------------------------------------------------
// Aggregation against the pre-registered thresholds (spec 4.2.5)
// ---------------------------------------------------------------------------
export const THRESHOLDS = Object.freeze({
  headings_and_cap: 'pass 1: >= 12/13 docs with 6/6 headings and raw <= 3000',
  median_raw_length: 'pass 1: median raw length < 2500',
  invented_dates_zero: 'pass 1: invented-date count 0 on 13/13',
  future_zero: 'pass 1: future stamps and future decision dates 0 on 13/13',
  all_stamped: 'pass 1: every In-flight unit stamped on 13/13',
  order_clean: 'pass 1: decision dates non-decreasing on 13/13',
  retention: 'pass 1: retention holds on >= 11/12 docs that have live units',
  current_focus: 'pass 1: Current focus <= 400 on >= 11/13',
  pass2: 'pass 2: all three conditions on >= 11/12',
});
const CONTROL = 'control: the OLD arm misses 6/6 headings or raw <= 3000 on >= 7/13';

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const missesShape = d => d.headings < 6 || !d.raw_le_cap;

export function aggregate({ newArm, oldArm, pass2 }) {
  const N = newArm.length;
  const count = pred => newArm.filter(pred).length;
  const withLive = newArm.filter(d => d.retention?.has_live);
  const pass2Docs = pass2 ?? [];
  const t = {};
  const set = (name, value, ok, need, extra = {}) => { t[name] = { ok, value, need, ...extra }; };
  set('headings_and_cap', count(d => !missesShape(d)), count(d => !missesShape(d)) >= Math.min(12, N), `>= ${Math.min(12, N)}/${N}`, { failing: newArm.filter(missesShape).map(d => d.project) });
  const med = median(newArm.map(d => d.length));
  set('median_raw_length', med, med !== null && med < 2500, '< 2500');
  set('invented_dates_zero', count(d => d.dating.invented === 0), count(d => d.dating.invented === 0) === N, `${N}/${N}`, { failing: newArm.filter(d => d.dating.invented > 0).map(d => `${d.project}:${d.dating.invented}`) });
  set('future_zero', count(d => d.future_stamps === 0 && d.future_decision_dates === 0), count(d => d.future_stamps === 0 && d.future_decision_dates === 0) === N, `${N}/${N}`, { failing: newArm.filter(d => d.future_stamps || d.future_decision_dates).map(d => d.project) });
  set('all_stamped', count(d => d.all_stamped), count(d => d.all_stamped) === N, `${N}/${N}`, { failing: newArm.filter(d => !d.all_stamped).map(d => d.project) });
  set('order_clean', count(d => d.order_clean), count(d => d.order_clean) === N, `${N}/${N}`, { failing: newArm.filter(d => !d.order_clean).map(d => d.project) });
  const retOk = withLive.filter(d => d.retention.ok).length;
  set('retention', retOk, retOk >= Math.max(0, withLive.length - 1), `>= ${Math.max(0, withLive.length - 1)}/${withLive.length}`, { failing: withLive.filter(d => !d.retention.ok).map(d => d.project) });
  const cfOk = count(d => d.current_focus_len <= 400);
  set('current_focus', cfOk, cfOk >= Math.max(0, N - 2), `>= ${Math.max(0, N - 2)}/${N}`, { failing: newArm.filter(d => d.current_focus_len > 400).map(d => `${d.project}:${d.current_focus_len}`) });
  const p2ok = pass2Docs.filter(d => d.cond1?.ok && d.cond2?.ok && d.cond3?.ok).length;
  set('pass2', p2ok, pass2Docs.length > 0 && p2ok >= Math.max(0, pass2Docs.length - 1), `>= ${Math.max(0, pass2Docs.length - 1)}/${pass2Docs.length}`, { failing: pass2Docs.filter(d => !(d.cond1?.ok && d.cond2?.ok && d.cond3?.ok)).map(d => d.project) });
  const oldMisses = (oldArm ?? []).filter(missesShape).length;
  const control = { rule: CONTROL, old_arm_misses: oldMisses, need: `>= ${Math.min(7, N)}/${oldArm?.length ?? 0}`, ok: oldArm ? oldMisses >= Math.min(7, N) : false, missing: (oldArm ?? []).filter(missesShape).map(d => d.project) };
  return { thresholds: t, control, all_ok: control.ok && Object.values(t).every(x => x.ok) };
}

// ---------------------------------------------------------------------------
// CLI shim — guarded by IS_MAIN; the only place a provider is called.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { arm: 'new', temperature: 0.2 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--inputs') a.inputs = next();
    else if (k === '--labels') a.labels = next();
    else if (k === '--prompt-dir') a.promptDir = next();
    else if (k === '--out') a.out = next();
    else if (k === '--arm') a.arm = next();
    else if (k === '--pass2') a.pass2 = next();
    else if (k === '--aggregate') a.aggregate = true;
    else if (k === '--old') a.old = next();
    else if (k === '--new') a.new = next();
    else if (k === '--pass2-results') a.pass2Results = next();
    else if (k === '--project') a.project = next();
    else if (k === '--control-only') a.controlOnly = true;
    else throw new Error(`unknown arg ${k}`);
  }
  return a;
}
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
function splitFrontmatter(md) {
  const m = FM_RE.exec(md);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: md.slice(m[0].length) };
}

async function loadInputs(inputsDir, labels) {
  const inputs = {};
  for (const [project, lab] of Object.entries(labels)) {
    const state = await fs.readFile(path.join(inputsDir, 'state', project, 'state.md'), 'utf8');
    const summaryRaw = await fs.readFile(path.join(inputsDir, 'sessions', project, lab.summary), 'utf8');
    const { fm, body } = splitFrontmatter(summaryRaw);
    const asOf = fm.covers_until ?? fm.valid_from;
    if (!asOf) throw new Error(`${project}: the summary has neither covers_until nor valid_from`);
    inputs[project] = { state, summary: body, asOf, asOfSource: fm.covers_until ? 'covers_until' : 'valid_from' };
  }
  return inputs;
}

async function runMerge({ updateState, summarize, promptDir, temperature, oldStateMd, newSummary, projectId, asOf }) {
  let raw = null;
  const result = await updateState(
    { oldStateMd, newSummary, projectId, asOf },
    {
      promptDir,
      temperature,
      now: () => new Date(asOf),
      summarizeFn: async (userPrompt, opts) => {
        const r = await summarize(userPrompt, opts);
        raw = r.summary;
        return r;
      },
    },
  );
  if (result.ok === false || typeof raw !== 'string') throw new Error(`${projectId}: merge failed: ${JSON.stringify(result).slice(0, 200)}`);
  return { raw, written: result.mergedMd, report: result.shaping, cost_usd: result.costUsd, tokens_in: result.tokensIn, tokens_out: result.tokensOut };
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const args = parseArgs(process.argv);
  if (args.aggregate) {
    const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
    const oldRun = args.old ? await read(args.old) : null;
    const newRun = await read(args.new);
    const p2 = args.pass2Results ? await read(args.pass2Results) : null;
    // The committed aggregate carries NUMBERS ONLY (spec 4.2.5): project names become doc-NN in the
    // NEW arm's order (the mapping lives in the gitignored eval.md) and every key or unit text is
    // reduced to a count. The per-project files with text stay under docs/plans/... (gitignored).
    const ids = new Map(newRun.docs.map((d, i) => [d.project, `doc-${String(i + 1).padStart(2, '0')}`]));
    const id = project => ids.get(project) ?? project;
    const agg = aggregate({ newArm: newRun.docs.map(d => ({ project: d.project, ...d.metrics })), oldArm: oldRun ? oldRun.docs.map(d => ({ project: d.project, ...d.metrics })) : null, pass2: p2 ? p2.docs.map(d => ({ project: d.project, ...d.conditions })) : null });
    const scrubMetrics = m => ({
      ...m,
      headings_missing: m.headings_missing,
      retention: { ok: m.retention.ok, has_live: m.retention.has_live, sections: Object.fromEntries(Object.entries(m.retention.sections).map(([k, v]) => [k, { ...v, dropped_mentioned: v.dropped_mentioned.length }])) },
      stale_carry: { units: m.stale_carry.length, stamped_supplied: m.stale_carry.filter(s => s.stamp).length },
      report: undefined,
    });
    const numbersOnly = run => run && { arm: run.arm, model: run.model, temperature: run.temperature, ran_at: run.ran_at, docs: run.docs.map(d => ({ doc: id(d.project), as_of_source: d.as_of_source, ...scrubMetrics(d.metrics), report: d.report ? { added: d.report.added.length, aged: d.report.aged, aged_future: d.report.aged_future, bounded: d.report.bounded, trims: d.report.trims } : null })) };
    const scrubList = xs => xs.map(x => id(String(x).split(':')[0]) + (String(x).includes(':') ? ':' + String(x).split(':').slice(1).join(':') : ''));
    const thresholds = Object.fromEntries(Object.entries(agg.thresholds).map(([k, v]) => [k, { ...v, failing: v.failing ? scrubList(v.failing) : undefined }]));
    const control = { ...agg.control, missing: agg.control.missing.map(id) };
    const out = { schema_version: 1, spec: 'docs/plans/2026-09-25-326-state-cap-section-aware-spec.md#4.2.5', control, thresholds, all_ok: agg.all_ok, old_arm: numbersOnly(oldRun), new_arm: numbersOnly(newRun), pass2: p2 && { ran_at: p2.ran_at, docs: p2.docs.map(d => ({ doc: id(d.project), n: d.conditions.n, cond1: { ok: d.conditions.cond1.ok, failures: d.conditions.cond1.failures.length }, cond2: { ok: d.conditions.cond2.ok, failures: d.conditions.cond2.failures.length, removed_by_bound: d.conditions.cond2.removed_by_bound.length }, cond3: { ...d.conditions.cond3, dropped_mentioned: d.conditions.cond3.dropped_mentioned.length }, backdated_dropped_by_model: d.conditions.backdated_dropped_by_model, selected: d.selected.length, backdated: d.selected.filter(s => s.backdated).length, excluded_not_found: d.selected.filter(s => /not found/.test(s.excluded ?? '')).length, excluded_unstamped: d.selected.filter(s => /unstamped/.test(s.excluded ?? '')).length })) } };
    await fs.writeFile(args.out, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`[state-cap-eval] aggregate written to ${args.out}: all_ok=${agg.all_ok} control=${agg.control.ok} (${agg.control.old_arm_misses} misses)`);
    for (const [k, v] of Object.entries(agg.thresholds)) console.log(`  ${v.ok ? 'PASS' : 'FAIL'} ${k}: ${v.value} (need ${v.need})${v.failing?.length ? ' failing: ' + v.failing.join(', ') : ''}`);
    process.exit(agg.all_ok ? 0 : 1);
  }

  if (!args.inputs || !args.out) { console.error('usage: --inputs <dir> --prompt-dir <dir> [--arm old|new] --out <json> | --pass2 <pass1-new.json>'); process.exit(2); }
  const labelsPath = args.labels ?? path.join(args.inputs, '..', 'labels.json');
  const labels = JSON.parse(await fs.readFile(labelsPath, 'utf8'));
  const inputs = await loadInputs(args.inputs, labels);

  // The positive control runs first and the eval refuses to run when any part fails.
  const control = positiveControl(Object.fromEntries(Object.entries(inputs).map(([p, v]) => [p, v.state])), labels);
  console.log(`[state-cap-eval] positive control: keys ${control.keys_found}/${control.keys_total}, units labelled ${control.units_labelled}/${control.units_parsed}, ambiguous ${control.ambiguous.length}, unlabelled ${control.unlabelled.length}`);
  if (!control.ok) { console.error(JSON.stringify(control, null, 2)); process.exit(2); }
  if (args.controlOnly) process.exit(0);

  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) { console.error('[state-cap-eval] OPENAI_API_KEY not set - run with node --env-file=.env'); process.exit(2); }
  process.env.UM_SUMMARIZER_PROVIDER ??= 'openai';
  process.env.UM_SUMMARIZER_MODEL ??= 'gpt-4o-mini';
  const { updateState } = await import('../lib/update-state.mjs');
  const { summarize } = await import('../lib/summarize.mjs');
  const ranAt = new Date().toISOString();
  const projects = args.project ? [args.project] : Object.keys(labels);

  if (!args.pass2) {
    if (!args.promptDir) { console.error('--prompt-dir is required for a pass-1 arm'); process.exit(2); }
    const docs = [];
    for (const project of projects) {
      const inp = inputs[project];
      const suppliedDate = ymd(inp.asOf);
      const merge = await runMerge({ updateState, summarize, promptDir: args.promptDir, temperature: args.temperature, oldStateMd: inp.state, newSummary: inp.summary, projectId: project, asOf: inp.asOf });
      const metrics = pass1Metrics({ raw: merge.raw, input: inp.state, labels: labels[project], suppliedDate, report: merge.report });
      docs.push({ project, as_of: inp.asOf, as_of_source: inp.asOfSource, supplied_date: suppliedDate, metrics, report: merge.report, cost_usd: merge.cost_usd, tokens_in: merge.tokens_in, tokens_out: merge.tokens_out, raw: merge.raw, written: merge.written });
      console.log(`[state-cap-eval] ${args.arm} ${project}: len ${metrics.length} headings ${metrics.headings}/6 inflight ${metrics.inflight_units} stamped ${metrics.all_stamped} invented ${metrics.dating.invented} retention ${metrics.retention.ok} cf ${metrics.current_focus_len}`);
    }
    await fs.writeFile(args.out, JSON.stringify({ arm: args.arm, model: process.env.UM_SUMMARIZER_MODEL, temperature: args.temperature, prompt_dir: args.promptDir, ran_at: ranAt, control, docs }, null, 2) + '\n', 'utf8');
    console.log(`[state-cap-eval] pass 1 (${args.arm}) written to ${args.out}`);
  } else {
    const pass1 = JSON.parse(await fs.readFile(args.pass2, 'utf8'));
    const promptDir = args.promptDir ?? pass1.prompt_dir;
    const docs = [];
    for (const project of projects) {
      const lab = labels[project];
      if (!lab.pass2?.length) { console.log(`[state-cap-eval] pass 2 ${project}: no pre-selected keys, leaves the denominator`); continue; }
      const doc1 = pass1.docs.find(d => d.project === project);
      if (!doc1) throw new Error(`${project}: not in the pass-1 file`);
      const inp = inputs[project];
      const suppliedDate = ymd(inp.asOf);
      const backdatedDate = ymd(new Date(inp.asOf).getTime() - BACKDATE_DAYS * DAY_MS);
      const { md: input2, selected } = backdateSelected(doc1.raw, lab.pass2, backdatedDate);
      const merge = await runMerge({ updateState, summarize, promptDir, temperature: args.temperature, oldStateMd: input2, newSummary: inp.summary, projectId: project, asOf: inp.asOf });
      const conditions = pass2Conditions({ input2, raw2: merge.raw, written2: merge.written, selected, suppliedDate, backdatedDate, now: inp.asOf, asOf: inp.asOf });
      docs.push({ project, supplied_date: suppliedDate, backdated_date: backdatedDate, selected, conditions, report: merge.report, cost_usd: merge.cost_usd, input2, raw2: merge.raw, written2: merge.written });
      console.log(`[state-cap-eval] pass 2 ${project}: n ${conditions.n} cond1 ${conditions.cond1.ok} cond2 ${conditions.cond2.ok} cond3 ${conditions.cond3.ok} (backdated ${selected.filter(s => s.backdated).length}/${selected.length}, dropped by model ${conditions.backdated_dropped_by_model})`);
    }
    await fs.writeFile(args.out, JSON.stringify({ arm: 'new', pass: 2, model: process.env.UM_SUMMARIZER_MODEL, temperature: args.temperature, prompt_dir: promptDir, ran_at: ranAt, docs }, null, 2) + '\n', 'utf8');
    console.log(`[state-cap-eval] pass 2 written to ${args.out}`);
  }
}
