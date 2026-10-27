// server/test/lint/no-retiring-models.test.mjs — model migration Phase B, spec R5.
// No default and no eval literal may name a model its vendor has shut down, or has announced
// a shutdown for, before 2027-07. Phase A and Phase B each found a dying model named as a
// default in a place no test looked (a plugin script, an eval literal, an .env.example line);
// this makes the next one red.
//
// RETIRING is every chat/completion and embedding id the three vendors' deprecation pages
// give a shutdown date before 2027-07-01, with the date. Re-read those pages whenever this
// lint or any model default is touched:
//   https://developers.openai.com/api/docs/deprecations
//   https://platform.claude.com/docs/en/docs/about-claude/model-deprecations
//   https://ai.google.dev/gemini-api/docs/deprecations
// Last read 2026-10-27. Image, audio, realtime, TTS, transcription, video and moderation
// models are out of scope. An Anthropic "Not sooner than" floor is not an announced date
// (claude-haiku-4-5-20251001 stays pinnable).
//
// The match follows no-raw-mkdtemp: literal shapes, not bare tokens — a quoted id, or an id
// after `=`, `:-` or `model:` — so prose can name a retired model freely, and comments are
// not stripped. An id matches with or without a dated `-YYYY-MM-DD` snapshot suffix, and
// never as a prefix of a longer id (gpt-4o does not match gpt-4o-mini).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers/tmpdir.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// [shutdown date, ids], as the pages give them. Rows, not an object keyed by date: two vendors
// can share a date, and a repeated object key silently drops the earlier list.
const RETIRING = Object.freeze([
  // OpenAI
  ['2027-04-01', ['gpt-5.1', 'gpt-5.3-codex', 'gpt-5.4-nano']],
  ['2027-01-14', ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini']],
  ['2026-12-11', ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro', 'o3', 'o3-pro']],
  ['2026-10-23', ['gpt-4.1-nano', 'gpt-3.5-turbo', 'gpt-3.5-turbo-0125', 'gpt-4', 'gpt-4-0613', 'gpt-4-1106-preview',
    'gpt-4-turbo', 'o1', 'o1-pro', 'o3-mini', 'o4-mini']],
  ['2026-10-01', ['gpt-5.4-cyber']],
  ['2026-09-28', ['gpt-3.5-turbo-instruct', 'gpt-3.5-turbo-1106', 'babbage-002', 'davinci-002']],
  ['2026-08-10', ['gpt-5.2-chat-latest', 'gpt-5.3-chat-latest']],
  ['2026-07-23', ['computer-use-preview', 'gpt-4o-search-preview', 'gpt-4o-mini-search-preview', 'gpt-5-chat-latest',
    'gpt-5-codex', 'gpt-5.1-chat-latest', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.2-codex',
    'o3-deep-research', 'o4-mini-deep-research']],
  ['2026-03-26', ['gpt-4-0314', 'gpt-4-0125-preview', 'gpt-4-turbo-preview']],
  ['2026-02-17', ['chatgpt-4o-latest']],
  ['2026-02-12', ['codex-mini-latest']],
  ['2025-10-27', ['o1-mini']],
  ['2025-07-28', ['o1-preview']],
  ['2025-07-14', ['gpt-4.5-preview']],
  ['2025-06-06', ['gpt-4-32k', 'gpt-4-32k-0613', 'gpt-4-32k-0314']],
  ['2024-12-06', ['gpt-4-vision-preview', 'gpt-4-1106-vision-preview']],
  ['2024-09-13', ['gpt-3.5-turbo-0613', 'gpt-3.5-turbo-16k-0613', 'gpt-3.5-turbo-0301']],
  ['2024-01-04', ['text-davinci-003', 'text-davinci-002', 'code-davinci-002']],
  // Anthropic
  ['2026-11-30', ['claude-sonnet-4-5-20250929']],
  ['2026-08-05', ['claude-opus-4-1-20250805']],
  ['2026-06-15', ['claude-opus-4-20250514', 'claude-sonnet-4-20250514']],
  ['2026-04-20', ['claude-3-haiku-20240307']],
  ['2026-02-19', ['claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022']],
  ['2026-01-05', ['claude-3-opus-20240229']],
  ['2025-10-28', ['claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022']],
  ['2025-07-21', ['claude-2.0', 'claude-2.1', 'claude-3-sonnet-20240229']],
  // Google
  ['2027-05-07', ['gemini-3.1-flash-lite']],
  ['2026-08-10', ['embedding-2-preview']],
  ['2026-07-28', ['gemini-2.5-computer-use-preview-10-2025']],
  ['2026-06-01', ['gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-lite-001']],
  ['2026-05-25', ['gemini-3.1-flash-lite-preview']],
  ['2026-03-31', ['gemini-2.5-flash-lite-preview-09-2025']],
  ['2026-03-09', ['gemini-3-pro-preview']],
  ['2026-02-17', ['gemini-2.5-flash-preview-09-25']],
  ['2026-01-14', ['text-embedding-004']],
  ['2025-12-09', ['gemini-2.0-flash-lite-preview', 'gemini-2.0-flash-lite-preview-02-05']],
  ['2025-12-02', ['gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-06-05']],
  ['2025-11-18', ['gemini-2.5-flash-preview-05-20']],
  ['2025-10-30', ['embedding-001']],
]);
const RETIRING_IDS = [...new Set(RETIRING.flatMap(([, ids]) => ids))];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SHAPE = new RegExp(
  `(?:['"\`]|=|:-|model:\\s*)(${RETIRING_IDS.map(escape).join('|')})(?:-\\d{4}-\\d{2}-\\d{2})?(?![\\w.-])`, 'g');

// Per-file exemptions, each with its reason. A file earns one only by pinning a legacy shape or
// keeping a retired id bootable, never by defaulting to one.
const ALLOWED = new Map([
  ['server/lib/pricing.mjs', 'retired ids stay priced, so an .env that still pins one keeps booting (spec non-goal)'],
  ['cli/test/mem0-import-judge-invoke.test.mjs', 'pins the legacy importer judge request shape'],
  ['cli/test/checkpoint.test.mjs', 'text-embedding-004 is an embedding-switch fixture (a stamp mismatch), never called'],
  ['cli/test/reindex-e2e.test.mjs', 'text-embedding-004 is an embedding-switch fixture, never called'],
  ['cli/test/reindex-phase1.test.mjs', 'text-embedding-004 is an embedding-switch fixture, never called'],
  ['cli/test/reindex-phase4-7.test.mjs', 'text-embedding-004 is an embedding-switch fixture, never called'],
  ['plugins/claude-code/universal-memory/hooks/lib/summarize.test.sh', 'pins the legacy (pre-luna) request body for an operator-pinned model'],
  ['plugins/claude-code/universal-memory/hooks/lib/update-state.test.sh', 'pins the legacy (pre-luna) request body for an operator-pinned model'],
  ['examples/openai-assistants/assistants-memory-tool.mjs', 'the Assistants API example, dead since 2026-08-26; deleted under spec R8 (plan T8)'],
  ['examples/openai-assistants/assistants-memory-tool.py', 'the Assistants API example, dead since 2026-08-26; deleted under spec R8 (plan T8)'],
]);

const EXT = /\.(mjs|js|sh|py)$/;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== '.git') yield* walk(p); }
    else if (EXT.test(p)) yield p;
  }
}

// Every hit in one text: [{line, id}].
function hits(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(SHAPE)) out.push({ line: i + 1, id: m[1] });
  });
  return out;
}

// The walk spec R5 names, relative to `root`: [{rel, line, id}] for every hit, allowlisted or not.
function scan(root) {
  const files = [];
  for (const sub of ['server/lib', 'server/eval', 'cli', 'plugins', 'installer', 'examples']) files.push(...walk(join(root, sub)));
  try {
    for (const e of readdirSync(join(root, 'server'))) if (e.endsWith('.mjs')) files.push(join(root, 'server', e));
  } catch { /* no server dir */ }
  const found = [];
  for (const f of files) {
    const rel = f.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length + 1);
    for (const h of hits(readFileSync(f, 'utf8'))) found.push({ rel, ...h });
  }
  // server/.env.example: its non-comment lines only (installers copy them into a live .env).
  let env = '';
  try { env = readFileSync(join(root, 'server', '.env.example'), 'utf8'); } catch { /* none */ }
  const active = env.split(/\r?\n/).map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
  for (const h of hits(active)) found.push({ rel: 'server/.env.example', ...h });
  return { files: files.length, found };
}

test('no default, eval literal, plugin, installer or example names a retiring model', () => {
  const { files, found } = scan(REPO_ROOT);
  // A broken root or walk() would scan nothing and pass vacuously.
  assert.ok(files >= 150, `lint scanned only ${files} files — the walk roots or walk() are broken`);
  const offenders = found.filter((h) => !ALLOWED.has(h.rel)).map((h) => `${h.rel}:${h.line} '${h.id}'`);
  assert.deepEqual(offenders, [],
    `retiring model ids found:\n  ${offenders.join('\n  ')}\n` +
    'Move the default to a measured replacement. If the file pins a legacy shape or keeps a retired id bootable, ' +
    'add it to ALLOWED with the reason.');
});

test('every ALLOWED entry still has a hit (a stale exemption is removed, not kept)', () => {
  const hitFiles = new Set(scan(REPO_ROOT).found.map((h) => h.rel));
  const stale = [...ALLOWED.keys()].filter((rel) => !hitFiles.has(rel));
  assert.deepEqual(stale, []);
});

test('RETIRING: every entry is dated and every id is listed once', () => {
  for (const [date] of RETIRING) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(RETIRING.every(([d]) => d < '2027-07-01'), 'only shutdowns before 2027-07 belong here');
  const all = RETIRING.flatMap(([, ids]) => ids);
  assert.equal(all.length, RETIRING_IDS.length, 'an id appears under two dates');
  for (const id of ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gemini-2.0-flash', 'text-embedding-004']) {
    assert.ok(RETIRING_IDS.includes(id), `${id} (spec R5's 2026-10-25 list) is listed`);
  }
  for (const id of ['gpt-6-luna', 'gpt-5.6-luna', 'text-embedding-3-small', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'gemini-3.6-flash']) {
    assert.equal(RETIRING_IDS.includes(id), false, `${id} has no announced shutdown before 2027-07`);
  }
});

// Mutation control: a fresh tree with one .mjs and one .sh default on a retiring model turns
// the same scan red, and the shapes that must stay quiet do.
test('mutation control: a retiring default in a .mjs and in a .sh is caught; prose and live ids are not', () => {
  const root = tempDir('um-retiring-lint-');
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put('server/lib/fixture.mjs', [
    "export const defaults = { summarizerModel: 'gpt-4o-mini' };",
    "// prose may name gpt-4o-mini without quotes, and 'gpt-4o-minimal' is another id",
    "const ok = ['gpt-6-luna', 'gpt-6-luna-2026-11-02', 'gpt-5.6-luna'];",
    "const snap = 'gpt-4.1-mini-2025-04-14';",
  ].join('\n'));
  put('plugins/p/hooks/fixture.sh', 'MODEL="${UM_MODEL:-gpt-4.1}"\n# gpt-4.1 in prose is fine\n');
  put('server/.env.example', '#UM_SUMMARIZER_MODEL=gpt-4o-mini\nUM_FACTS_MODEL=gemini-2.0-flash\nUM_OTHER=gpt-6-luna\n');
  put('server/test/ignored.test.mjs', "const legacy = 'gpt-4o-mini';\n");
  const { found } = scan(root);
  assert.deepEqual(found.map((h) => `${h.rel}:${h.line}:${h.id}`).sort(), [
    'plugins/p/hooks/fixture.sh:1:gpt-4.1',
    'server/.env.example:2:gemini-2.0-flash',
    'server/lib/fixture.mjs:1:gpt-4o-mini',
    'server/lib/fixture.mjs:4:gpt-4.1-mini',
  ]);
});
