# Changelog

All notable changes to universal-memory are documented here. Format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/); this project
adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (v1.1) — `/adr` skill POST route bug

Discovered during B2 (PR [#81](https://github.com/goldenwo/universal-memory/pull/81)) spec authoring and filed as the B2 "Out of scope" hygiene followup: `create-adr.sh` POSTed to `"$endpoint/memory_add"`, but the live UM server exposes no `/memory_add` route — only `/api/add` (`server/mem0-mcp-http.mjs:2221`). Against any real server `/adr` fell into the warn-only 404 path: file written + git-committed, but the universal-memory registration silently failed. The skill's stub-based integration tests passed only because the test stub accepts any POST path; the path assertion just verified the helper sent whatever it sent.

- **Fix in two production sites.** `cmd_create`'s `_post_memory_add` (`create-adr.sh:346`) and `cmd_sync`'s curl_args block (`create-adr.sh:610`) now POST to `"$endpoint/api/add"`. Payload shape (`{text, metadata: {...}}`) was already compatible with the server's `/api/add` handler contract — no payload changes.
- **Test assertion updated.** INT2 in `create-adr.test.sh:432-433` now asserts the captured stub path equals `/api/add` (was `/memory_add`). INT11 (`cmd_sync` happy path) only asserts body shape, so it's correct by construction.
- **Hygiene PR per the standing flow carve-out.** Narrow scope: only the POST destination changed; no recursive paired-Opus review.

### Added (v1.1) — Phase B2: `/remember` casual-save skill (axis 4 advance)

Second instance of the create-adr pattern (W1.1, 2026-05-08). Ships a `/remember <text>` slash-command skill that POSTs a casual fact to the running UM server via REST `/api/add`. Closes issue [#70](https://github.com/goldenwo/universal-memory/issues/70) §3 — the "no `/remember <fact>` skill" gap for Claude Code casual users (no-project sessions, doctype-free explicit save).

- **New skill at `plugins/claude-code/universal-memory/skills/create-remember/`** — markdown body (`skill.md`) + bash helper (`create-remember.sh`) + 101-assertion test suite (`create-remember.test.sh`). Same install convention as `/adr`: manual copy to `~/.claude/skills/create-remember/` at v1.1.
- **POST to `/api/add` with `metadata.type: "note"`** and no `metadata.project` — server's F1 soft-default (PR [#78](https://github.com/goldenwo/universal-memory/pull/78) + [#79](https://github.com/goldenwo/universal-memory/pull/79)) injects `UM_DEFAULT_PROJECT` (or literal `"default"`). 2-line success output: `Remembered: <preview>` + `Registered with universal-memory (<endpoint>) project=<resolved>`. When the server response carries any `results[].event === 'DEDUP_MERGED'` (D1 dedup hit, PR [#77](https://github.com/goldenwo/universal-memory/pull/77)), the second line gains a `— dedup match` suffix — running `/remember "X"` twice is idempotent by content (correct semantic for casual saves).
- **Warn-only contract on transient/auth failures** (HTTP 401/403/429/5xx/000) — single WARNING line, exit 0, sanitized text preview included so the operator can re-run verbatim. Hard-fail (exit 65) only on payload-class errors (400/422) where re-running won't help.
- **Codepoint-counted 4096 limit** via `python3` primary (`UM_CODEPOINT_TOOL` operator override). Multi-byte content (CJK, emoji) is correctly counted by codepoint, not byte — `awk length()` and bash `${#var}` rejected as broken on BSD/busybox awk and `LC_ALL=C` respectively. 60-codepoint success-output preview uses the same counter.
- **Text sanitization** — strips C0/C1/DEL, rejects Unicode bidi-override codepoints (CVE-2021-42574 "Trojan Source"), trims, collapses whitespace. JSON payload escaping via pure-bash parameter substitution (no `jq` dependency).
- **Auth-token resolution chain** — env `UM_AUTH_TOKEN` → `$HOME/.claude/skills/create-remember/config.json` (`auth_token` field, per-skill scoping) → anonymous (loopback-only acceptable).
- **Smoke gate** — new `UM_SMOKE_REMEMBER_ON=1`-gated block in `server/test/smoke.sh` (mirrors D1's `UM_SMOKE_DEDUP_ON=1` block at line 1602). Two consecutive `/remember` invocations with identical text; second must surface "dedup match". `.github/workflows/smoke.yml` run-smoke step env updated to set the flag at release-gate time.
- **Spec + plan + 3-round paired-Opus review** — `docs/plans/2026-05-10-b2-remember-skill-spec.md` + `-plan.md` (both gitignored). Methodology + operational lenses CONVERGED at round 3 (7 BLOCKERs + 14 IMPORTANTs resolved across 2 revision passes; 17 NITs folded into PR commits per the standing automated engineering flow carve-out).
- **Out of scope for B2:** `/forget` (issue #70 §4, future); `--project <slug>` override (stretch); Claude.ai connector / ChatGPT Desktop parity (no slash-command surface there; tracked for v1.2+); the pre-existing `/adr` POSTs-to-`/memory_add`-not-`/api/add` bug (filed as a separate hygiene followup).
- **Shellcheck CI** — `.github/workflows/smoke.yml` shellcheck step file list extended to cover `create-remember.sh` + `create-remember.test.sh`.

### Changed (v1.1) — Phase F1 hygiene — slug regex + tool-id centralization

Tidies the items the PR #79 description flagged as "deferred to a separate hygiene PR." No behavior change; the F1 contract and all four+REST write-tool soft-defaults are unchanged. Verified by adding 4 new tests (PROJECT_SLUG_RE invariant + canonical pattern, TOOL_IDS frozen-shape, helper accepts arbitrary tool strings) without removing any.

- **Canonical project slug regex** centralized to `server/lib/default-project.mjs:PROJECT_SLUG_RE` (exported). The duplicate `SAFE_NAME_RE` const in `server/mem0-mcp-http.mjs` (used by `validateSafeName`) was the fourth identical `/^[a-zA-Z0-9._-]+$/` in the tree — flagged by post-merge review of #78 as having tripped the "if a fourth caller appears" trigger the original F1 helper TODO'd.
- **`TOOL_IDS` frozen enum** for the `tool` arg of `applyDefaultProject`. All five call sites (`memory_capture` / `memory_add` / `memory_append_turn` / `memory_checkpoint` / REST `api_add`) now import from `default-project.mjs` — typos at a new call site fail at write-time rather than producing a silently-wrong log binding. Named `TOOL_IDS` (not `TOOLS`) to avoid colliding with the existing `export const TOOLS = [...]` MCP tool registry in `mem0-mcp-http.mjs`.
- **Tombstone comments** in `server/lib/append-turn.mjs` + `server/lib/checkpoint.mjs` rewritten — the old text said "moved to ./default-project.mjs ... Kept inline pre-F1" which read as if the const remained. New wording describes what the file no longer carries.

### Fixed (v1.1) — Post-merge review follow-ups for PRs #77 + #78

Paired-Opus post-merge review on PRs #77 (D1 flag-flip) + #78 (F1 project soft-default) surfaced one blocker + two important findings; this PR closes them out.

- **BLOCKER (#77) — `smoke.sh` S1 truthiness gap.** The S1 case statement accepted `false|0|FALSE|False` as the "explicitly disabled" arm and would advertise "S2 will be skipped" with `UM_DEDUP_ENABLED=FALSE` set, but the runtime gate at `server/lib/add.mjs:computeDedupEligible()` uses strict `=== 'false'` — so `FALSE` / `0` / `False` keep dedup ON server-side. Result: an operator setting `UM_DEDUP_ENABLED=FALSE` would get a misleading smoke message ("disabled, skipping S2") while the server still has dedup ON, hiding the exact operator-config drift S1 was designed to catch. **Fix:** S1 now accepts only the literal lowercase `false` as the explicit-off arm; every other non-truthy value lands in the typo-FAIL arm with a pointer to the runtime gate's strict-`'false'` contract.
- **IMPORTANT (#78) — REST `/api/add` was missed by F1.** PR #78's F1 unification updated the four MCP write tools but left the REST `/api/add` handler (mem0-mcp-http.mjs ~2217) passing `metadata` straight through to `umAdd` — preserving the v1.0 silent-drop on the project field. The A1 audit §F6 specifically named ChatGPT Custom GPT (Actions API, REST `/api/add`) as the casualty of the silent-drop; F1's MCP-only scope missed exactly the surface F6 was about. **Fix:** REST `/api/add` now mirrors the MCP `memory_add` handler's soft-default policy (`applyDefaultProject({ tool: 'api_add', ... })`). Caller-supplied non-empty project values still pass through unchanged.
- **IMPORTANT (#78) — `_invalidEnvWarnEmitted` was a test-flake hazard.** The module-level one-shot flag in `server/lib/default-project.mjs` had no reset hook, so the test asserting the warn fired degraded to `BEHAVIOR_OR_NOOP` (couldn't distinguish "warn fired" from "earlier test consumed the one-shot"). **Fix:** new `_resetInvalidEnvWarnForTests()` export resets the flag deterministically; the test now asserts strict `equal(logger.calls.length, 1)` on first call AND `equal(0)` on a second call within the same env scope (verifying both halves of the one-shot contract).
- **Stale-fact cleanups.** `/api/memory_capture` mention in the workflow comment + CHANGELOG entry corrected to `/api/add` (the PR #77 follow-up commit moved the S2 probe to `/api/add`; the comment + changelog didn't catch up). `UM_DEDUP_EMBEDDING_THRESHOLD` default in the v1.1 D1 historical Added entry now strikes-through `0.95` and forward-references the Changed entry's `0.84` so a release-time reader gets the correct current value.

The TOOLS enum / tombstone cleanup / `PROJECT_SLUG_RE` centralization items the original draft of this entry called out as "deferred" landed in the immediately-following hygiene PR (see the "Changed (v1.1) — Phase F1 hygiene" entry above).

### Changed (v1.1) — Phase F1: project soft-default unification

- **New `UM_DEFAULT_PROJECT` env var** (defaults to literal `default`). All four MCP write tools (`memory_capture`, `memory_add`, `memory_append_turn`, `memory_checkpoint`) now route omitted-project writes through this slug. Resolves the heterogeneous-default behavior the [A1 audit](docs/audits/2026-05-08-cross-surface-defaults.md) §F1 flagged: pre-F1, the same caller error (omit `metadata.project`) produced **three** different observable outcomes — soft-default `'default'` for `memory_capture`, silent-drop for `memory_add`, hard-fail `INPUT_INVALID` for `memory_append_turn` + `memory_checkpoint`. Post-F1 all four soft-default to a single configured slug.
- **`memory_append_turn` + `memory_checkpoint` hard-fail → soft-default on the omitted arm.** Per audit finding F5 ("worst UX in the matrix"), Claude.ai / ChatGPT users issuing "save this conversation" without a project signal used to get `INPUT_INVALID` envelopes; now the turn lands under the soft-default slug + a `warn` log fires so the operator can observe accumulation. Wrong-type and regex-mismatch slugs (e.g. `../escape`, `my project`) still hard-fail — the F1 flip *only* covers the truly-omitted arm (`undefined` / `null` / `''`).
- **`memory_add` no longer silently drops `metadata.project`.** When the caller omits the field (Custom GPT Actions surface in particular — see audit §F6), the helper injects `UM_DEFAULT_PROJECT` so the write is project-filterable on retrieval. Caller-supplied non-empty values pass through unchanged; F1 deliberately does not add validation to `memory_add` to avoid breaking pre-v1.1 callers that pass non-slug project strings.
- **`memory_state` / `memory_recent` intentionally keep their hard-fail.** Reads where the project is ambiguous should not silently return data from the fallback project — the error envelope is the right UX. `memory_search` remains project-optional (post-filter).
- **New `server/lib/default-project.mjs`** is the single source of truth — `umDefaultProject()` validates the env value against the canonical slug regex `/^[a-zA-Z0-9._-]+$/` (an invalid env value falls back to `default` + one-shot warn), and `applyDefaultProject({ project, tool, logger, requestId })` is the policy entry point that returns either an effective slug or `null` (signaling the caller to hard-fail). 28 new tests cover the helper + each handler's flipped arm + regression guards that invalid slugs still hard-fail.
- **Docs:** new "Project soft-default policy" section in [`docs/mcp-tools.md`](docs/mcp-tools.md) plus per-tool table updates. `server/.env.example` documents `UM_DEFAULT_PROJECT` with a pointer to the audit and the read-vs-write asymmetry rationale.

### Changed (v1.1) — Phase D1: cross-surface dedup flag-flipped to default ON

- **`UM_DEDUP_ENABLED` default flipped `false` → `true`.** Activates the v1.1 D1 dedup hook for all new deployments. Threshold pinned at the eval-derived `UM_DEDUP_EMBEDDING_THRESHOLD=0.84` from PR [#76](https://github.com/goldenwo/universal-memory/pull/76). The two prereqs for this flip (landing PR with the hook, then empirical threshold tuning) are both merged; this PR is the third and final step of the D1 rollout per spec §10.3.
- **Opt-out semantics.** Only the explicit string `UM_DEDUP_ENABLED=false` disables dedup. Unset/empty/anything-else keeps it ON. Runtime gate at `server/lib/add.mjs:computeDedupEligible()` inverted from strict-`'true'` opt-in to strict-`'false'` opt-out; comment in the eligibility block names the change for future readers.
- **CI smoke probe now fires.** `.github/workflows/smoke.yml` sets `UM_SMOKE_DEDUP_ON=1` on the smoke step, which gates the S2 dedup probe (two identical `/api/add` writes → second must return `event=DEDUP_MERGED`). Container reads the new default from `server/.env.example` via `install.sh`, so no env-passthrough is needed at the install step.
- **smoke.sh S1 regression guard inverted.** The pre-flip guard FAILed when `UM_DEDUP_ENABLED` was on without explicit `UM_SMOKE_DEDUP_ON=1`. Post-flip S1 PASSes by default (the new contract) and accepts explicit `false` as the opt-out path; an unrecognized value (typo) still FAILs loud.
- **Tests updated to the new contract.** T9 in `server/test/dedup.test.mjs` (flag-off regression guard) now sets `UM_DEDUP_ENABLED='false'` explicitly instead of `delete`-ing — required because `delete` now means default-ON. Same fix in `server/test/dedup-bench.test.mjs:runBatch` for the `enabled=false` arm. `withDedupOn` helper unchanged (sets `'true'` explicitly, restores prev; semantically still correct).

### Added (v1.1) — Phase D1: cross-surface fact dedup hook (flag-gated, landing PR shipped flag-off)

- **New `server/lib/dedup.mjs`** — server-side write-time dedup hook integrated into the `umAdd()` orchestrator at `server/lib/add.mjs`. Two-layer check (content-hash via qdrant `scroll`, embedding-similarity via qdrant `search` with `score_threshold`); on hit, `setPayload`-merge extends the existing point's `surfaces` and `projects` Set fields, increments `dedupCount`, sets `dedupLastSeenAt`, and returns `event: 'DEDUP_MERGED'` instead of upserting a new point. Direct advance of [#72](https://github.com/goldenwo/universal-memory/issues/72) **axis 1 (cross-surface dedup)**.
- **New `server/lib/dedup-constants.mjs`** — `RESERVED_METADATA_FIELDS` (frozen 6-element list: `surfaces`, `projects`, `dedupCount`, `dedupVersion`, `dedupLastSeenAt`, `systemMigration`); `NAMESPACE_UM` (fixed UUID v5 namespace for deterministic point IDs in the hash-layer); `assertNoReservedFields(metadata)` thrower runs at umAdd entry, OUTSIDE `withRequestContext`. Reserves `metadata.systemMigration` so untrusted callers cannot smuggle the dedup bypass via metadata — internal callers (Phase F migration, `cli/reindex.mjs:531`, server-side vault reindex paths) pass `_systemMigration: true` as a top-level umAdd arg (the underscore-prefix server-internal seam pattern, parallel to `_qdrantClient`/`_factsCounter`/`_logger`).
- **New flag `UM_DEDUP_ENABLED` (default `false`)** in `server/.env.example`. The landing PR ships flag-OFF; the flag-flip PR will run after the post-merge threshold-tuning eval and 1 week of clean `um_dedup_total{result='hit'}` rate observation.
- **New flag `UM_DEDUP_EMBEDDING_THRESHOLD` (default ~~`0.95`~~ `0.84`)** for the Layer 2 cosine similarity threshold. PR #75 landed the conservative seed at 0.95; PR #76's empirical 50-pair eval shifted it to the plateau-midpoint 0.84 (F_0.5 precision-weighted, 8-τ saturation band). See the "Changed (v1.1) — Phase D1: cross-surface dedup flag-flipped to default ON" entry above for the current value.
- **Schema additions (additive, flattened, camelCase per existing payload contract):** every payload now seeds `surfaces: [string]`, `projects: [string]` (Set-typed; pre-DP2 Option C closes the F1 cross-surface heterogeneous-defaults gap), `dedupCount: number` (1 on first write, 2+ on merges), `dedupVersion: 1`. Existing pre-D1 points work as-is on the read path; merges happen forward-only. Retroactive dedup is a separate Phase F deliverable per spec R11.
- **TOCTOU guard:** dedup-eligible writes use `uuidv5(\`${userId}:${hash}\`, NAMESPACE_UM)` as the qdrant point ID (per spec DP8) so concurrent identical writes collide deterministically rather than producing two near-duplicate points. Non-dedup-eligible writes (flag-off, system docs, migration/reindex bypass) keep using `randomUUID()` for legacy parity.
- **Reindex bypass (R14 + symmetric extension):** `cli/reindex.mjs` Phase 3 `rebuildOne()`, server-side `reindexDoc()` (internal helper), and `/api/reindex` (REST endpoint) all pass `_systemMigration: true` to skip dedup. Without this bypass, vault rebuilds could inadvertently merge a rebuilt doc into a different doc's record under the same userId via uuidv5 collision.
- **Two new metrics:** `um_dedup_total{kind, result, stage}` counter (kind ∈ {hash, embedding}, result ∈ {hit, miss, error}, stage ∈ {scroll, search, setPayload, ''}) and `um_dedup_check_duration_seconds{kind, stage}` histogram. Bounded cardinality (24 max combinations); registry inventory bumped to 12 metrics in `test/metrics.test.mjs`.
- **20 new tests:** `test/dedup.test.mjs` covers spec §8.1 T1–T14 + T11b (parametric T8 over 6 reserved fields, mock-narrowing T9/T10/T11 to `.upsert`-only client, F1-cascade T4b, env-var → score_threshold flow T14, etc.); `test/dedup-bench.test.mjs` covers spec §8.4 B1 perf regression guard (mocked-qdrant overhead ≤ 80ms p95). Smoke `test/smoke.sh` adds S1 (flag-off regression — fails clearly if flag is unexpectedly on) and S2 (flag-on micro-smoke, gated by `UM_SMOKE_DEDUP_ON=1` for the flag-flip PR). Two live integration tests (L1 + L2) in `test/add-live.test.mjs` gated by `UM_LIVE_TESTS=1`.
- **`uuid@9.0.1` promoted to direct dep** in `server/package.json` (was transitive via `mem0ai`). Pinned to mem0's transitive version.
- **Spec + plan**: `docs/plans/2026-05-09-d1-spec.md` (CONVERGED at R4 via `spec-review-loop`, 4 rounds: 3 BL + 6 G + 3 M → 2 BL + 4 G + 1 M → 0 → 0 BL + G11 fix); `docs/plans/2026-05-09-d1-plan.md` (CONVERGED at R4, two-consecutive-zero rule met). Both gitignored. ADR `0006-cross-surface-dedup` registers the DP2 Option C decision (cross-project bucketing via `projects` Set).

### Added (v1.1) — Phase B1: surface coverage parity matrix

- **New [`docs/surfaces.md`](docs/surfaces.md)** — canonical matrix of every surface universal-memory supports today (Claude Code, Claude.ai web, Claude Desktop, ChatGPT Desktop, ChatGPT Custom GPT, Codex CLI, Discord OpenClaw bridge, `um` CLI) with five columns: capture path (`auto` / `partial-auto` / `manual` / `none`), recall path, setup-step count, project/lane signal source, and which of [#72](https://github.com/goldenwo/universal-memory/issues/72)'s vision axes the surface's current tier blocks.
- **Direct advance of universality axis 6** ("surface coverage parity matrix as living doc"). First vision-axis-advancing PR after the v0.6→v1.1 hygiene streak (per the drift-check verdict on the last 10 merged PRs: 0/10 advanced any axis; recency streak: 10).
- **Tier ladder explicit:** `none → manual → partial-auto → auto`. PR descriptions that move a surface up a rung now have a documented place to cite the shift.
- **Three cross-cutting findings surfaced by the matrix layout:** (1) no surface today serves axis 3 (mobile-friendly capture and recall); (2) only Claude Code serves axis 5 (auto context routing) — five of seven surfaces have no host-side project signal at all; (3) every surface has a multi-step setup story — axis 4's gradient is the matrix's "Setup steps" column.
- **Living-doc commitment** in §"Living-doc commitment" — matrix updates with each release-tag audit; new-surface PRs prepend a row; surface-tier-changing PRs update the relevant row.

### Added (v1.1) — Phase A1 + A2 + A3: cross-surface defaults audit (complete)

- **New audit doc** at [`docs/audits/2026-05-08-cross-surface-defaults.md`](docs/audits/2026-05-08-cross-surface-defaults.md) traces what `metadata.project` value each non-Claude-Code surface (Claude.ai, Claude Desktop, ChatGPT Desktop, ChatGPT Custom GPT, Codex CLI, Discord OpenClaw) actually passes to `memory_capture` / `memory_add` / `memory_append_turn` today. Records six findings (heterogeneous server defaults, CC-only auto-resolution, placeholder rubric strings, `'default'`-collision risk, `memory_append_turn` hard-fail UX, ChatGPT Custom GPT bypassing the soft-default entirely) and links each to the downstream phases that depend on the answer (B1 / D1 / E3 in particular).
- **§7 A2 — mem0 version on Pi:** Pi runs Node.js `mem0ai@2.4.5` (npm), not Python — original probe (`pip show mem0ai`) was wrong on two dimensions: mem0 isn't containerized on the Pi (runs as `systemd --user`), and isn't Python. One patch behind UM v1.0's `mem0ai@2.4.6`. Phase C1 (in-place migration) is unblocked: low-risk patch bump, no major-version skew.
- **§8 A3 — Discord OpenClaw integration:** OpenClaw is third-party (`@mem0/openclaw-mem0@1.0.6` npm extension + `openclaw@2026.4.21` gateway) and **uses mem0 via in-process JS import, not wire-protocol** — there is no network boundary between OpenClaw and mem0. The `mem0-pi-mcp` HTTP service is a separate exposure for *external* MCP clients (e.g., Claude Code over Tailscale serve), distinct from how Discord OpenClaw itself talks to mem0. OpenClaw passes **no project metadata at all** — its 4-tool surface (`memory_search` / `memory_add` / `memory_list` / `memory_delete`) lands all captures in a flat `userId='golden'` namespace.
- **§4 C2 implications row updated** to reflect the in-process-extension reality: Phase C2 must operate at the plugin/shim layer, not at the `mem0-pi-mcp` HTTP boundary as previously assumed.

### Fixed (v1.1) — `/adr` skill paired-Opus review follow-up (W1.1)

Post-merge paired-Opus review on PR #67 surfaced 1 BLOCKER + 5 IMP findings; this PR closes them out. No surface change for operators on the happy path; failure-mode and round-trip behavior is more correct.

- **BLOCKER (B1) — YAML colon in title produced invalid frontmatter.** Common ADR titles like `"Adopt mem0: a vector store"` rendered as `title: Adopt mem0: a vector store` — valid bash heredoc, INVALID YAML (PyYAML rejects with `ScannerError`). The helper's loose `${line#title:}` parser silently round-tripped the broken file, so the breakage was invisible to `cmd_sync` but tripped every YAML-aware downstream consumer (CI lints, third-party ADR readers, the eventual `/adr supersede` tooling). Fix: `_yaml_dq` helper double-quotes title + decided_by always; new `_fm_value` parser unwraps the quoted form on `cmd_sync`. New regression test asserts round-trip via PyYAML.
- **IMP (S1) — `cmd_sync` JSON injection via crafted ADR frontmatter.** `fm_id`, `fm_status`, and `fm_decided_at` flowed into the memory_add payload via `printf` with no escaping. A PR-merged ADR file with a crafted frontmatter (e.g., `decided_at: 2026-05-08", "evil_field": "yes`) injected arbitrary metadata fields when an operator ran `/adr sync NNNN`. Fix: pass all frontmatter values through `_json_escape`.
- **IMP (S2) — `adr_id` shape mismatch between create + sync.** `cmd_create` POSTed `"adr_id":"0001"` (4-digit prefix), `cmd_sync` POSTed `"adr_id":"0001-sync-me"` (full slug). Server-side reconciliation between rounds for the same ADR couldn't match. Fix: `cmd_sync` extracts the leading 4-digit prefix from frontmatter `id:` and uses that.
- **IMP (D1) — `cmd_sync` ignored `--no-path` privacy contract.** Operators who used `--no-path` on the original create couldn't replicate the privacy contract through sync. Fix: `cmd_sync` accepts `--no-path` and respects it.
- **IMP (I1) — 403/400/422 fell through to a generic warn that misleads.** A 403 (auth-class) bucketed with the generic "re-run sync" message that operators take as actionable; 400/422 (payload-class) suggested "re-run sync" when re-running won't help. Fix: 403 buckets with 401 (auth-class with `set UM_AUTH_TOKEN` pointer); 400/422 surface `payload rejected; re-running will not help` with an issue-tracker pointer.
- **IMP (I2) — Inline `um_resolve_endpoint` fallback omitted both-different conflict warn.** When both `UM_SERVER_URL` and `UM_ENDPOINT` were set with different values AND the W1.5 lib was absent (pre-v1.1 install), the fallback silently picked `UM_SERVER_URL` with no warning — diverging from the lib's behavior. Fix: ported the conflict-warn logic into the inline fallback so the parity contract holds.
- **MIN — `git add` errors are now surfaced verbatim** in the helper's stderr (e.g., gitignore matches), giving operators a breadcrumb instead of just `git commit failed`.
- **MIN — `_git_commit_adr` tmpfile cleanup hardened** with EXIT trap (in addition to RETURN) so signal-interrupt between `git add` and `git commit` doesn't leak the tmpfile.
- **skill.md — explicit guidance** for `/adr --commit sync NNNN` (reject) and `/adr sync NNNN extra-junk` (reject).

Test surface grew from 103 to 139 tests, including new round-trips: PyYAML parse of a colon-containing title, shell-metacharacter title pass-through, sync `--no-path`, sync extra-args / wrong-flag rejection, 403/422 bucket assertions, exact 3-line success-output count, empty `git config user.name`, padded `sync 0001`.

### Added (v1.1) — `/adr` skill: Architectural Decision Records (W1.1)

- **New Claude Code skill `/adr`** at `~/.claude/skills/create-adr/`. Authors an ADR in the consumer's repo, commits it via git, and registers an atomic decision fact with the universal-memory server. Three subcommands: `/adr "<title>"` to create; `/adr sync NNNN` to re-register an existing ADR (idempotent recovery for hooks-failure / network-failure cases); `/adr --help`.
- **Architecture: markdown skill + bash helper.** `skill.md` is the LLM-facing prose contract; `create-adr.sh` is the bash helper that does all safety-critical work (file write via `set -C` noclobber + symlink reject, git commit via `git commit -F <tmpfile>`, HTTP POST via `curl`). Sources the W1.5 endpoint resolver directly — no language port, no drift risk.
- **401 = warn-only for `/adr` create.** A 401 from `memory_add` after the file is written + committed becomes a WARNING line on the third row of success output (`WARNING: not registered with universal-memory — auth failed (set UM_AUTH_TOKEN, see <repo>/server/.env). Run /adr sync NNNN after fixing.`). Exit code 0. **Deliberate asymmetry:** `/adr sync` returns non-zero on 401 — sync IS the recovery command, so a 401 there means auth is still broken and should fail loud.
- **`.um-self-host` sentinel** at the universal-memory repo root gates the self-application guard: when the skill detects this file (or `package.json#name === "universal-memory-server"`) it skips git commit + memory_add POST, writing only the file. `--commit` flag overrides for explicit self-host commits.
- **`metadata.type: "adr"`** is now an enumerated value of the OpenAPI `MemoryMetadata.type` description for retrieval-side filtering.
- **Title sanitization:** strips C0/C1 controls + DEL; rejects Unicode bidi-override codepoints (CVE-2021-42574 "Trojan Source"); slug clamped to lowercase ASCII alphanumerics + hyphens, max 60 chars, `untitled` fallback for empty results.
- **Auto-numbering:** `max+1` across `docs/decisions/NNNN-*.md`, gap-preserving (`0001, 0003 → 0004`), 4+ digit zero-pad with no upper cap. One collision retry then loud fail.

### Changed (v1.1) — `UM_ENDPOINT` → `UM_SERVER_URL` consolidation (W1.5)

- **`UM_ENDPOINT` is now deprecated; rename to `UM_SERVER_URL`.** The old variable is still respected with a one-line deprecation warning on stderr; it will be removed in v1.2.
- A new shared endpoint resolver lives at `~/.local/share/um/lib/endpoint.sh`. Hooks (`auto-start`, `session-start`, `session-end`, `user-prompt-submit`) source it and call `um_resolve_endpoint` for the canonical URL. The CLI + auto-installed marker block already used `UM_SERVER_URL` directly; no operator-facing change there.
- If your `.env` or shell rc sets `UM_ENDPOINT`, rename it to `UM_SERVER_URL` (no other change required). If both are set with different values, `UM_SERVER_URL` wins and the resolver names which value was used. See `MIGRATION.md` `## v1.0 → v1.1`.
- Hook fail-soft fallback: if the resolver lib file isn't installed (pre-v1.1 install state), hooks fall back to inline `${UM_SERVER_URL:-${UM_ENDPOINT:-}}` resolution so they continue to work without re-running `install.sh`.

### W6.2 — Image size reduction

- **Server image: 598 MB → 288 MB** (310 MB saved, 51.8% reduction; compressed: 94 MB → 60 MB). Achieves the v1.0 W6.2 primary <350 MB target.
- Mechanism: a `patch-package`-applied transform of `mem0ai@2.4.6/dist/oss/index.mjs` converts 14 eager imports of unused-provider peerDeps (groq-sdk, @mistralai/mistralai, cloudflare, redis, @langchain/core/messages, @langchain/core/documents, @azure/search-documents, @azure/identity, @supabase/supabase-js ×2, pg, neo4j-driver, plus 2 of better-sqlite3 which mem0 still uses for its history manager) to fail-soft dynamic imports. The Dockerfile then surgically removes the unused-provider directories from `node_modules` after install + patch + prune.
- **Expected post-upgrade boot-log change:** operators tailing `docker logs` will see 12 new informational warns on every server boot, one per peer-skipped package — these are NOT errors:
  ```
  [mem0-patch] groq-sdk not installed (peer-skipped) — expected on boot per W6.2
  [mem0-patch] @mistralai/mistralai not installed (peer-skipped) — expected on boot per W6.2
  …
  [mem0-patch] neo4j-driver not installed (peer-skipped) — expected on boot per W6.2
  ```
  Filter with `docker logs ... | grep -v '\[mem0-patch\]'` if log noise matters; the lines are stable across boots and version-pinned to `mem0ai@2.4.6`. The `— expected on boot per W6.2` suffix is grep-able to this CHANGELOG entry.
- **Forward-compat for adding a peer-skipped provider later (source-build operators only):** the dynamic-import shape resolves at boot if the package is present in `node_modules/`, so an operator running a **custom source build** (`UM_BUILD_LOCAL=1` or directly editing `server/Dockerfile`) can add e.g. `npm install @mistralai/mistralai` to `package.json` AND remove the corresponding line from the Dockerfile's surgical-rm list — the `[mem0-patch] @mistralai/mistralai` warn then disappears at boot. **Operators extending the published GHCR image** (`FROM ghcr.io/goldenwo/universal-memory-server:1.0.0`) cannot just `RUN npm install <pkg>` because the package directory was already removed at the upstream deps stage; they would need to fork the Dockerfile.
- **Reconciliation procedure when mem0ai is bumped:** see `server/patches/README.md` (durable, in-repo). The source-hash pin at `server/patches/mem0ai+2.4.6.source.sha256` is verified at Docker build time — a mismatched hash fails the build LOUDLY rather than silently applying the patch against a mutated tarball.

---

## [1.0.0] — 2026-05-08

**v1.0 is the stabilization + public-release milestone.** No new features relative to v0.8; the work is making the existing surface externally consumable: distribution shape, public-repo polish, security review, walkthrough validation, marketplace listing, and release ceremony.

The cumulative arc that v1.0 ships, by version:

- **v0.2 (Apr 2026)** — Session continuity: stop-hook raw capture, LLM session summaries, per-project `state.md`, memory versioning, 10-tool MCP surface.
- **v0.3** — Cross-platform reach: Codex CLI plugin, Claude.ai / Claude Desktop / ChatGPT Desktop connection guides, OpenAPI 3.1 at `/openapi.yaml`, `um-tunnel` CLI.
- **v0.4** — Progressive disclosure: compact `{id, title, score, snippet}` reads by default, opt-in `?full=1`; standalone `um` CLI; schema-hygiene `tools/list` filter.
- **v0.5** — Cross-env first-class capture: `memory_append_turn` + `memory_checkpoint` from any MCP client; modular installer with NONINTERACTIVE overrides.
- **v0.6** — Bearer auth + ops foundations: per-IP rate limiter, structured logging with request IDs, `/metrics`, container entrypoint guards, claude-mem bridge.
- **v0.7** — Provider neutrality: openai / anthropic / google / ollama swappable per surface; embedding-stamp guard; `um reindex` CLI.
- **v0.8** — Orchestrator wiring + cleanup: `umAdd()` replaces `mem0.add()` everywhere; production embed/facts metrics now emit; v0.6 follow-up queue closed.
- **v1.0 (this release)** — Stabilize + publish (in progress).

### Added

- **`docs/walkthrough/macos-solo-dev.md`** (PR #52, 68318df) — fresh-eyes walkthrough doc for solo developers on macOS. 10 steps with explicit per-step Verify checks; Troubleshooting section; feedback rubric for the W2.2 fresh-eyes runner.
- **`CONTRIBUTING.md`** (PR #49, b491848) — public contributor guide. PR flow, conventional commits, test-plan format, code-review tiers (Sonnet vs paired-Opus), development principles, phase-boundary discipline.
- **`docs/decisions/0005-adr-invocation-model.md`** — accepted ADR for the post-v1.0 `create-adr` skill invocation: **Option A (`/adr` slash command)**. Reserves Option C (end-of-session batch) as a future safety net. (ADR file is gitignored locally; canonical record committed via this CHANGELOG entry.)
- **`server/test/cors-preflight.test.mjs`** — pins the CORS preflight contract: `Authorization` header is always advertised in `Access-Control-Allow-Headers` so browser-origin clients aren't silently broken.
- **W6.4 logger redaction** — `UM_AUTH_TOKEN` value-redaction pattern (lazy-init at first emit) added to the layer-2 censor's `KEY_PATTERNS`. Defense-in-depth only.

### Changed

- **`SECURITY.md` expanded** (PR #49, b491848) — full disclosure policy via GitHub PVR, response timeline, supported-version table, in/out-of-scope matrix, hardening notes for operators. Preserves the v0.7+ Qdrant write-stamp known-limitation note verbatim.
- **README tone retuned** (PR #50, 37c3d63) — six version-narrative artifacts retired (`(new in v0.5)`, `(new in v0.6)`, `**In v0.6 they compose**`, `**v0.6 note**`, `**Recall-only through v0.4**`, deferred-Agents-SDK link). Upgrading section reframed to point at MIGRATION + CHANGELOG cumulatively, with a "pin a tag" advice line.
- **`server/docker-compose.yml` dual-mode** — pull-by-default. Default behavior: `docker compose up -d` pulls `ghcr.io/goldenwo/universal-memory-server:${UM_VERSION:-latest}` (~20s vs ~2-5min cold-build). Pin via `UM_VERSION` in `.env`. Build override via new `server/docker-compose.build.yml` (combine with `-f` chaining). `server/install.sh` detects `UM_BUILD_LOCAL=1` and forwards both files.
- **`compareTokens` hashes inputs to fixed-size SHA-256 digests** before timing-safe compare (`server/lib/auth.mjs`). Replaces the prior length-mismatch dummy-compare scheme. Length-independent timing.
- **CORS preflight** advertises `Authorization` in `Access-Control-Allow-Headers` (`server/mem0-mcp-http.mjs`). Unblocks browser-origin bearer-auth flows that were silently rejected at the preflight stage.

### Fixed

- **`docs/research/2026-04-24-v0.6-verifications/V1-fixture-prep.sh`** (PR #49, b491848) — replaces hardcoded `REPO_ROOT="E:/Projects/universal-memory"` with `git rev-parse --show-toplevel`. Closes the only "recommended regardless" finding from the W4.1 secrets audit.
- **`server/.env.example` UM_MCP_WRITE_ENABLED warning** — replaced pre-v0.6 stale text claiming "server accepts unauthenticated writes from ANY host" with current accurate description: writes are protected by bearer auth since v0.6; loopback bypass + token semantics referenced. (W6.4 nice-to-have.)
- **Rate-limit IP-key under reverse proxy** — added `UM_RATE_LIMIT_TRUSTED_PROXY_HEADER` env var (default unset) for installs behind Cloudflare Tunnel / nginx / Tailscale Funnel. When set, the rate limiter keys on the named forwarded-for header instead of the socket peer IP, preventing any client sharing the proxy from trivially bypassing limits. Documented spoof-safety conditions in `.env.example`. (W6.4 nice-to-have.)
- **`evictOneOldest()` O(n) — accepted as documented intentional design** (W6.4 nice-to-have). The current O(n)-on-admit approach is preferred over a periodic O(n) sweep that would spike p99 latency for unlucky requests. Per `server/lib/rate-limit.mjs:39-41`. No code change; CHANGELOG note records the deliberation. v1.x cleanup may revisit with an LRU rewrite if real-world workloads expose contention.
- **Issue [#47](https://github.com/goldenwo/universal-memory/issues/47) — OpenAI live-continuity flake mitigated** in `server/test/continuity.sh`. Live OpenAI mode occasionally returns empty/malformed output; `session-end.sh` correctly degrades by keeping existing state.md but on the FIRST session there's nothing to keep, so the test asserted on a never-created file. Steps 3 + 6 now retry up to 3 times with 2s backoff — matches the production pattern (a real user would just run another session). Per `feedback_test_integrity.md`: test still exercises real behavior (state.md created, summary written, headers present); only the retry envelope is new. Mocked mode (`UM_CONTINUITY_LIVE=0`) succeeds on attempt 1; retry is a no-op there.

### Docs

- **`docs/walkthrough/`** new directory with three platform walkthroughs:
  - `macos-solo-dev.md` (PR #52, 68318df) — primary, macOS-verified
  - `linux-solo-dev.md` — derived from macOS; GNU `stat`/`ss` adaptations + docker-group note
  - `windows-solo-dev.md` — derived from Linux; WSL2-primary path; native PowerShell deferred to v1.1+
  Both mirrors are unverified on their target platforms and explicitly invite W2.2 runner feedback for paper cuts.
- **MIGRATION.md `v0.7 → v0.8` and `v0.8 → v1.0` sections** — operator-facing notes per release transition. `v0.8 → v1.0` covers the distribution-shape change (pull-by-default), the W6.4 hardening trio, the cumulative bearer-auth posture summary, and the formalized post-v1.0 support window.
- **`server/.env.example`** — new "Image / version pin" section documents `UM_VERSION`, `UM_IMAGE`, `UM_BUILD_LOCAL` knobs. New "Mem0 history DB" guidance documents the persistent volume-mount pair. (PR #51 + this PR.)
- **15 GitHub topics applied** for discoverability: `ai-memory`, `llm`, `memory`, `claude`, `claude-code`, `mcp`, `model-context-protocol`, `codex-cli`, `mem0`, `qdrant`, `self-hosted`, `markdown`, `rag`, `semantic-search`, `session-continuity`.

### Verification

- W4.1 secrets audit: GO verdict (no real secrets in history; previous `git filter-repo` pass on `docs/decisions/` + `docs/plans/` held).
- W6.4 security review: 3 Important findings (CORS, compareTokens, logger redaction), 0 Critical. All three fixed.
- W6.1 history-DB persistence example shipped (PR #51, d3178b1).

---

## [0.8.0-alpha] — 2026-05-07

v0.8 in progress — the first landed slice is **G2 orchestrator wiring**:
production embed/facts metric emission. v0.7-alpha promised
`um_provider_tokens_total{surface=facts}` and similar for `embed`, but
those surfaces emitted zero — `mem0.add()` bypassed our orchestrators.
v0.8 G2 introduces `umAdd()` (`server/lib/add.mjs`), which routes
through `embed()` and `facts()` orchestrators, then upserts directly
into Qdrant via `@qdrant/js-client-rest`.

### Added

- **`server/lib/add.mjs`** — `umAdd()` orchestrator replacing all 6
  `mem0.add()` call sites (4 in `mem0-mcp-http.mjs`, 1 in
  `lib/embedding-stamp.mjs`, 1 in `cli/reindex.mjs`).
- **Provider methods:** real `embed()` on openai/google/ollama;
  `factsInvoke()` on all four providers (anthropic facts-only).
- **`um_facts_extracted_total` counter** — sums facts extracted per
  `(provider, model)`. Powers the operator alert
  `rate(um_facts_extracted_total[5m]) == 0` while
  `request_duration_seconds_count > 0` (pipeline succeeding but
  extracting nothing — provider misconfig?).
- **`@qdrant/js-client-rest`** promoted from transitive (via mem0) to
  direct server dependency, pinned to mem0's resolved version.
- **`scripts/check-no-mem0-add.sh`** — CI gate forbidding `mem0.add()`
  reappearance in `server/`/`cli/`.
- **Live round-trip test** at `server/test/add-live.test.mjs` (gated by
  `UM_LIVE_TESTS=1`, blocks merge when run) — verifies umAdd's payload
  schema is readable by `mem0.getAll`/`mem0.search`. Mirrors production's
  explicit `vectorStore: { provider: 'qdrant', config: {...} }` Memory
  wiring; mem0's default in-memory fallback would silently ship empty
  reads.
- **Mock-SDK + real-qdrant DE5 stamp roundtrip** at
  `server/test/add-stamp-roundtrip.test.mjs` (gated by
  `UM_QDRANT_INTEGRATION=1`). Companion to the live spike: exercises the
  full `writeStamp(via umAdd) → readStamp(via mem0.getAll)` chain against
  the compose-managed qdrant using `UM_TEST_MOCK_SDK=1` internally — no
  API keys needed. Closes the spec §8 "DE5 stamp roundtrip in boot-smoke"
  acceptance gap that mock-SDK boot-tests can't reach (they intentionally
  short-circuit `writeStamp`).
- **CI grep gate wired into `.github/workflows/smoke.yml`** as the first
  step after checkout, fail-fast before the stack comes up.
- **Qdrant host port mapping in `server/docker-compose.yml`** — loopback
  only by default (`127.0.0.1:6333:6333`), env-overridable via
  `UM_QDRANT_PORT`. Lets local devs introspect their qdrant via curl/MCP
  and lets the new integration test reach qdrant from the runner.

### Changed

- **Qdrant server image bumped `v1.11.3 → v1.13.0`** to match the
  `@qdrant/js-client-rest` 1.13.0 client pulled transitively by
  `mem0ai@2.4.6`. Two-minor-version mismatch was emitting a runtime
  warning on every qdrant client construction. Forward storage-format
  migration is automatic within a major version; existing operators
  pull the new image and `docker compose up -d --force-recreate qdrant`.

- **Behavior change for `infer:true`:** umAdd does NOT replicate mem0's
  semantic dedup (existing-memory query + LLM ADD/UPDATE/DELETE). Every
  extracted fact becomes a new ADD. Re-running the same `/api/add`
  request twice now creates 2 facts instead of 1. Callers depending on
  idempotent re-adds must use deterministic `metadata.id` and check
  before calling. Documented in spec §3 non-goals.
- **Reindex traffic shares prod metric labels** — v0.8 has no
  `target`/`caller_class` label on `um_provider_*`. A 10× reindex spike
  looks identical to a 10× user-write spike on dashboards. Adding a
  traffic-source label is a v0.9 candidate (spec §10).

### v0.8 follow-ups (cleanup queue, 2026-05-02 → 2026-05-07)

A series of small PRs closing the v0.6/v0.8 follow-up backlog. Behavior-
preserving except where called out. None of these change the public API
surface; they harden the install path, close test coverage gaps, and
finish the reindex CLI wiring.

#### Added

- **v0.8.1 vault frontmatter audit** (PR #38, d2b4ecd). Closes #37.
  Inline doc at `cli/reindex.mjs:530` recording the audit conclusion (no
  current writer emits `userId`/`user_id` in vault frontmatter; the
  conditional read is forward-compat). Regression test exercising the
  explicit-camel-`userId` path.
- **Stale-symlink replacement test** (PR #39, f6a8fce). Closes #22.
  T17 in `installer/install-plugin-cc.test.sh` mirrors the v0.4-class
  T9 invariants against `installer/install-plugin-cc.sh`. Wires
  `install-plugin-cc.test.sh` into `smoke.yml`'s `installer-test`
  matrix on ubuntu-latest + macos-latest.
- **`um-cli reindex` CLI wrapper** (PR #45, b8259b7). Five new exports
  in `cli/reindex.mjs`: `createMemoryInstance`, `createVaultAdapter`,
  `wrapOldMemoryForReindex`, `createQdrantClient`, `runReindex`,
  `main`. Top-level orchestrator sequences phases 1→7 with `--resume`
  gating per `state.phase_completed`; SIGINT handler around phase 3.
  CLI argv parsed via `node:util` parseArgs; flags `--confirm`,
  `--resume`, `--no-server-probe`, `--keep-old`, `--checkpoint-path`,
  `--dry-run`, `--help`. New `reindex` subcommand in `plugins/claude-
  code/universal-memory/bin/um` dispatches to the CLI.
- **DE12 e2e test fill** (PR #45, b8259b7). 3 scenarios in
  `cli/test/reindex-e2e.test.mjs` (UM_LIVE_TESTS-gated; operator-run):
  provider flip (openai → google), `--resume` mid-phase-3, `--resume`
  between phase-4 and phase-5. Replaces previous `assert.fail()`
  scaffolding.
- **CI wire-up for `install-plugin-codex.test.sh`** (PR #43, 23fda16).
  Companion to PR #39; closes the second half of the "shellchecked but
  never run end-to-end" gap. T13 (Codex detected) + T19 (Codex absent)
  now run in CI.

#### Changed

- **Shellcheck `--severity=style` restored** (PR #41, f2f11ca). Closes
  #23. 71 findings addressed: 65 real fixes + 6 justified inline
  disables. CI flag changes in `smoke.yml`: removed `--severity=
  warning`, added `-x` (follow `# shellcheck source=` directives), added
  `-P SCRIPTDIR` (resolve relative source paths against each script's
  own directory).
- **Plugin CLI exec bits** (PR #40, 3d6d8ba). Flipped git mode 100644 →
  100755 on 12 plugin CLIs in `plugins/claude-code/universal-memory/
  bin/`: `um`, `um-capture(.sh)`, `um-forget`, `um-list.sh`,
  `um-preview`, `um-recent.sh`, `um-search.sh`, `um-state.sh`,
  `um-supersede`, `um-tail.sh`, `um-tunnel`. Mode-only changes (blob
  hashes unchanged). Windows checkouts ignored Unix exec bits, masking
  the issue locally; fresh clones on Linux/macOS produced non-executable
  CLIs.
- **Reindex code split** (PR #46, be90f32). `cli/reindex.mjs` (1474 →
  1155 lines). Phases 4-6 moved to new `cli/lib/swap.mjs`; phase 7
  moved to new `cli/lib/archive.mjs`. Pure refactor: re-exports from
  `cli/reindex.mjs` keep existing imports unchanged.

#### Fixed

- **Windows `ln -s` silent-fallback launcher** (PR #42, 182bb58). Long-
  pending T15 failure in `installer/install-plugin-cc.test.sh`. git-bash
  on Windows silently copies on `ln -s` and returns exit 0; the bridge
  CLI's static ESM imports then fail with `ERR_MODULE_NOT_FOUND` on a
  flat copy at `~/.local/bin/`. `installer/install-plugin-cc.sh` now
  re-checks `[ -L "$bin_link" ]` after `ln -s`; when false, writes a
  bash launcher that `exec`s node on the bridge source in the plugin
  install dir (where sibling files resolve).
- **macOS bash 3.2 empty-array under `set -u`** (PR #39, f6a8fce).
  `installer/install-plugin-cc.test.sh:97` `run_plugin_cc` helper
  expanded `"${env_vars[@]}"` directly. Bash 3.2 (macOS default) treats
  this as unbound when the array is empty. Fixed via `${arr[@]+
  "${arr[@]}"}` idiom.

#### Docs

- **ROADMAP refresh** (PR #44, df8ba39). Marked v0.8 G2 + v0.8.1 audit +
  cleanup queue as shipped. Updated operational debt to reflect Qdrant
  alignment as resolved.

## [0.7.0-alpha] — 2026-05-01

Provider-neutrality release. The memory server, MCP HTTP layer, and reindex
CLI work with **OpenAI, Anthropic, Google, and Ollama** across all three
LLM surfaces (embedding, summarizer, facts) — previous releases were
OpenAI-only. Alpha: OpenAI paths and Anthropic-as-summarizer/facts are
production-ready; Google + Ollama paths are spec-compliant and unit-tested
but await first-user live validation.

### Added

- **Four-provider neutrality** — pick any combination per surface via
  `UM_EMBEDDING_PROVIDER`, `UM_SUMMARIZER_PROVIDER`, `UM_FACTS_PROVIDER`
  (each accepts `openai` | `anthropic` | `google` | `ollama`). Optional
  `UM_FACTS_FALLBACK` for cross-provider facts fallback.
- **Provider registry** at `server/lib/provider/registry.mjs`; per-provider
  modules at `server/lib/provider/{openai,anthropic,google,ollama}.mjs`
  exposing a uniform contract per spec §3.2.
- **Surface dispatchers** — `server/lib/embed.mjs` + `server/lib/facts.mjs`
  (Pattern B: config translation for mem0); `server/lib/summarize.mjs`
  (Pattern A: direct dispatch).
- **Embedding-stamp guard** — server reads `_um_embedding_stamp` sentinel
  doc on boot and refuses to start if the configured embedder doesn't match
  the recorded provider/model/dim. Operator is pointed at `um-cli reindex`.
- **`cli/reindex.mjs`** — 7-phase reindex orchestrator with crash-safe
  resume (Adv-1 stamp-then-swap, Adv-4 atomic phase advance per spec §6.5);
  wrapped as `um-cli reindex --confirm`. ~941 lines.
- **`_um_embedding_stamp` system doc** — filtered from all read paths via
  `isSystemDoc()` so it never surfaces to recall, search, or list.
- **Wizard 4-path provider picker** — `installer/wizard-lib.sh` offers
  OpenAI-only / mix-providers / local-Ollama / skip-and-edit during
  install.sh interactive mode.
- **`um_provider_*` Prometheus metrics** — `tokens_total`, `cost_total`,
  `request_duration_seconds`, `errors_total` per provider × surface. The
  `SURFACES` enum in `server/lib/metrics.mjs` is the single source of truth
  for metric labels (`'embed'`, `'summarize'`, `'facts'`).
- **R11 secret redaction** — pino redaction at log emission for `sk-`,
  `sk-ant-`, `AIza`, and `Bearer` patterns; covers headers, URL params,
  and free-form message strings. Pattern order matters: `sk-ant-` precedes
  `sk-` so greedy match doesn't consume the prefix.
- **Mocked-SDK boot smoke** (`UM_TEST_MOCK_SDK=1`) — every provider config
  can be smoke-tested without real API keys.
- **`docs/contributing/add-provider.md`** — 6-touch checklist for adding a
  fifth provider.
- **`MIGRATION.md` §`v0.6 → v0.7`** — env-var rename table + reindex
  decision tree.

### Changed

- **Breaking:** Env-var renames per pre-1.0 hard-break policy (no fallback
  shims; see `MIGRATION.md` §`v0.6 → v0.7`):
  - `UM_SUMMARIZER` → `UM_SUMMARIZER_PROVIDER`
  - `UM_SUMMARIZE_MODEL` → `UM_SUMMARIZER_MODEL`
  - `MEM0_LLM_MODEL` → `UM_FACTS_MODEL`
  - `MEM0_EMBEDDER_MODEL` → `UM_EMBEDDING_MODEL`
- **Breaking:** `installer/install.sh --yes` now refuses on missing API key
  (was permissive in v0.6).
- `mem0ai` exact-pinned to `2.4.6` (R1 mitigation — guards against silent
  SDK-pin drift that pruned `ollama` from `node_modules` and broke 18 test
  files).

### Fixed

- R11 redaction wired in **both** `makeLogger()` (test path) and
  `getLogger()` → `base()` → `buildOptions()` (production path). Initial
  implementation only covered the test path; caught in PR review.

### Security

- Secret patterns redacted from logs at emission time (R11) — covers
  OpenAI (`sk-`), Anthropic (`sk-ant-`), Google (`AIza`), and any
  `Bearer <token>` headers.

### Test signal

- 589 server unit tests / 583 pass / 0 fail / 6 skipped
- 34 wizard tests, 0 fail
- 66 install tests, 0 fail
- 36 CLI tests / 33 pass / 3 skipped (UM_LIVE_TESTS-gated)
- CI: smoke + cross-platform installer (ubuntu + macos) all SUCCESS
- DE1 §6.1 live spike (real qdrant + openai): mem0 `metadata.id` roundtrips ✅
- FIN1 anthropic-as-facts: live Claude call extracts facts ✅

### Tracked v0.8 follow-ups (none block this alpha — see `ROADMAP.md` §v0.8)

## [0.6.0-alpha] — 2026-04-25

### Added
- Bearer auth on `/api/*` and `/mcp` with loopback + forwarded-header safe default (§4.2)
- Structured pino logging with `request_id` propagation
- `/metrics` Prometheus exposition (5 bound metrics, loopback-only default)
- Per-IP token-bucket rate limiter with bounded map + LRU eviction
- `um-bridge-claude-mem` — one-way ingest from `~/.claude-mem/claude-mem.db`
- BRIDGES.md registry; `source:` discriminator in vault frontmatter
- `<external-summary>` untrusted-content boundary for bridge-ingested records
- Shared `_dump_on_fail` test harness (`installer/lib/test-harness.sh`)
- Container entrypoint guard refusing root+rw+writes-enabled (#28)
- UM_CONTAINER_USER change warning on re-run (#30)
- CLI friendly-error translation via `_um_curl_wrap` (401/429/503/5xx)
- `server/lib/jsonrpc-errors.mjs` — string-to-numeric JSON-RPC code map + `toJsonRpcError()` helper
- `server/test/error-shape.test.mjs` — cross-cutting per-endpoint envelope-shape gate; catches future regressions where a handler forgets the unified envelope helper
- `server/test/jsonrpc-errors.test.mjs` — JSON-RPC code-map unit tests (every stable code mapped, fallback to `-32603`)

### Changed
- **Breaking:** `/api/list` envelope → `{results: [...]}`
- **Breaking:** Unified §5.1 error envelope across every endpoint (B.13). Every 4xx/5xx from `/api/*` returns `{ok:false, error:{code, message, retryable}}` with a stable `code` from the §5.2 prefix-groups (`AUTH_*`, `INPUT_*`, `STATE_*`, `LIMIT_*`, `UPSTREAM_*`, `SERVER_*`). Replaces the legacy `{error:'<string>'}` and `{schema_version:1, ok:false, error:'<string>'}` shapes. The local `errorResponse` helper in `server/mem0-mcp-http.mjs` is removed — single source of truth is now `server/lib/error-envelope.mjs`. OpenAPI `ErrorResponse` schema updated to match.
- **Breaking:** `/mcp` JSON-RPC dual-shape — tool errors return the §5.1 unified envelope inside `result.content[0].text` (JSON-encoded, replacing the old free-form `"Error: <msg>"` plain text). Outer JSON-RPC envelope errors (parse error, method not found) carry a numeric `error.code` in the `-32xxx` range, mapped from the stable string code by `server/lib/jsonrpc-errors.mjs`.
- **Breaking:** `/openapi.yaml` (full) now default-secure — auth-required + loopback-only
- **Breaking:** Request-body cap `UM_HTTP_MAX_REQUEST_BYTES` (default 2 MB) — clients sending larger payloads receive 413 `INPUT_TOO_LARGE`
- **Breaking:** `/metrics` now default-secure loopback-only — ops with existing Prometheus scrape from non-loopback must set `UM_METRICS_LOOPBACK_ONLY=false` + configure `UM_METRICS_AUTH_REQUIRED`
- mem0/qdrant calls now retry 3× with 100/200/400 ms jittered backoff before surfacing `UPSTREAM_FAILURE` — p99 latency may shift by ~700 ms on transient upstream failures (previously surfaced immediately)
- Cross-process lockdir replaces Perl flock + proper-lockfile (server+plugin)
- O_NOFOLLOW on all vault writes (symlink-swap fix)

### Fixed
- Typeof-string guard on timestamp inputs
- #20, #21, #28, #29, #30 (backlog)

### Security
- Constant-time token compare (A1)
- Forwarded-header default-deny on loopback (10-header list forces auth even from 127.0.0.1 when any proxy/tunnel indicator present) — tunnel-safety default
- `<external-summary>` marker blocks prompt-injection from bridge sources (A3) — REJECT-on-literal-marker (LLM-entity-decode bypass fix)
- `/metrics` default-secure posture (A2)
- `/openapi.yaml` auth-required default (A4)
- Bridge `--db-path` realpath + allowlist (rejects UNC paths, absolute escapes, symlinks outside `~/.claude-mem/`)

## [0.5.0-alpha] — 2026-04-23

Cross-env first-class release. Non-CC surfaces (Claude.ai, ChatGPT Desktop,
Codex) can now append turns and trigger session summaries directly via MCP,
without Claude Code hooks. Modular installer with interactive wizard.
Shared prompt templates + `UM_PROMPT_DIR`. I4 fix for `claude-agent-sdk`.

### Added

- **`memory_append_turn` MCP tool + `POST /api/append-turn` REST endpoint** —
  append a conversation turn (`project`, `content`, `role` required;
  `timestamp`, `conversation_id` optional) directly to the raw-capture pipeline.
  Enables Claude.ai, ChatGPT Desktop, and Codex to feed turns to the vault
  without Claude Code's Stop hook. Flock-protected file writes prevent turn
  corruption within the node server (concurrent `memory_append_turn` calls)
  and within Claude Code (concurrent `stop.sh` invocations). Cross-process
  bash↔node races on the same raw-capture file are a known v0.6 hardening
  item — stop.sh writes complete in <10ms so practical overlap is rare, but
  not zero. Log-injection guard on project value.
- **`memory_checkpoint` server-side implementation** — triggers full
  session-end pipeline (summary + state merge + reindex) from any MCP surface
  via `POST /api/checkpoint`. Drops v0.4 stub; see MIGRATION.md.
- **Modular install flags** — `install.sh` is now the unified entry point with
  composable component flags: `--server`, `--plugin-cc`, `--plugin-codex`,
  `--cli`, `--all`, plus `--interactive`, `--yes`, `--dry-run`.
- **Interactive wizard** — `install.sh` auto-triggers a numeric-menu walkthrough
  when run with no flags in a TTY. `--yes` skips it; `--dry-run` prints without
  executing.
- **Shared prompt templates** — `summarize.txt` + `update-state.txt` prompts
  extracted to `server/config/prompts/` and written to the vault at install time.
- **`UM_PROMPT_DIR` env var** — installer writes this to the managed block in
  `~/.bashrc`/`~/.zshrc` for plugin-cc installs. `hooks/lib/summarize.sh` +
  `update-state.sh` read prompts from this path; fall back to plugin-local
  `hooks/lib/prompts/` if unset. Eliminates prompt drift between CC plugin and
  server paths.
- **Rubric-drift-gate test** — `server/test/rubric-drift.test.mjs` asserts that
  rubric blocks in all 5 mirror files match the canonical
  `docs/memory-routing-rubric.md`. 1 pass, 0 fail.
- **BACKENDS registry in `summarize.mjs`** — groundwork for v0.7
  provider-neutrality (Anthropic/Google/Ollama swap). Allows adding new
  summarization backends without touching the dispatch core.
- **Backend fallback for `claude-agent-sdk` server-side** — when
  `UM_SUMMARIZER=claude-agent-sdk` is configured in server `.env`,
  `memory_checkpoint` (server-side) falls back to `openai`/`ollama` with a
  warning log; Docker cannot spawn a host-side Claude Code process.

### Changed

- **`memory_checkpoint` no longer a stub** — the v0.4 actionable-error response
  (`"use /um-checkpoint or hooks/session-end.sh"`) is replaced with a real
  server-side implementation. Existing CC users see no behavior change;
  Claude.ai / ChatGPT Desktop / Codex users gain the ability to trigger state
  refresh directly.
- **`install.sh` is unified entry point** — supports composable component flags.
  `install-cli.sh` continues as the v0.4 back-compat entry point for CLI-only
  installs; its behavior is unchanged.
- **Plugin-copy logic extracted** — refactored from `server/install.sh` into
  `installer/install-plugin-cc.sh` + `installer/install-plugin-codex.sh`.
- **`hooks/lib/summarize.sh` + `update-state.sh`** — now read prompts via
  `$UM_PROMPT_DIR` (falls back to plugin-local `hooks/lib/prompts/`).

### Fixed

- **I4 (`claude-agent-sdk` system prompt)** — `summarize.sh` now prepends
  `_UM_SYSTEM_PROMPT` before piping the transcript when using the
  `claude-agent-sdk` backend. Fixes a silent quality regression where the
  system prompt was omitted for this non-default config.
- **`stop.sh` flock-protected** — raw-capture appends use Perl
  `Fcntl::flock` via a sibling lockfile. No turn corruption under concurrent
  writes.
- **`installer/lib/marker-block.sh` idempotency** — re-running `install.sh` or
  `install-cli.sh` now leaves `~/.bashrc` at a stable line count. In v0.4.0-alpha
  the helper prepended a leading `\n` on every write but awk didn't strip the
  blank line that the prior run had written, so each re-install grew the bashrc
  by 1 blank line (unbounded over many runs). Fix: awk now buffers blank lines
  and discards the buffer when it sees the marker-start sentinel. Regression
  tests added to `installer/install-cli.test.sh` (T8) and `server/install.test.sh`
  (T18 extended). See commit `46e8700`.
- **`um` dispatcher standalone-install fallback** — `um --version` failed the
  6-lib health check whenever `UM_LIB_DIR` was unset for standalone installs.
  Fix: two-tier fallback — env var first, then standalone layout
  (`~/.local/share/um/lib`), then plugin-context layout. Regression test T11
  added to `bin/um.test.sh`. See commit `7c0b026`.
- **`server/test/smoke.sh` T10-E broadened** — `memory_checkpoint` is in
  `WRITE_TOOL_NAMES` so the writes-gate error fires before the stub error when
  `UM_MCP_WRITE_ENABLED=false`. Assertion now accepts either error message. See
  commit `5b2cd6c`.

### Security

- **Flock-protected raw-capture appends** — concurrent `memory_append_turn` or
  Stop-hook writes to the same day-file are now serialized via a Perl
  `Fcntl::flock` sibling lockfile. Prevents partial-write turn corruption.
- **Log-injection guard in `append-turn.mjs`** — raw project value is sanitized
  before appearing in error-message log output.

## [0.4.0-alpha] — 2026-04-21

Hybrid-rebalance release. Five phases (0, B.1, B.3, A, D) plus docs capstone
(E) across 85 commits and three rounds of dual-Opus design review. Headline:
progressive disclosure cuts 41.9% of single-hop tool-call context on reads,
and a first-class `um` CLI replaces ad-hoc curl for everyday vault work.
All Critical / Important / Scalability findings from review are resolved;
ten Minor findings are deferred to v0.5.

### Added

- **Progressive disclosure on read responses** (Phase B.1). REST
  `/api/search`, `/api/list`, `/api/recent/{project}` and MCP `memory_search`,
  `memory_list`, `memory_recent` return compact `{id, title, score, snippet}`
  (~200-byte snippet = title + first 240 chars of body) by default. Opt into
  full bodies via `?full=1` (REST) or `full: true` (MCP). 41.9% single-hop
  context reduction measured against v0.3 baseline using the 20-query
  fixture.
- **`GET /api/recent/{project}`** REST endpoint — filesystem mtime-sorted
  recent session summaries. Parity with MCP `memory_recent`.
- **`um` CLI** (Phase A). Seven subcommands — `um search`, `um state`,
  `um recent`, `um list`, `um capture`, `um tail`, `um --version` — behind a
  dispatcher with a shared `hooks/lib/config.sh` KEY=value loader (env
  overrides repo `.um/config` overrides user `~/.um/config`). Standalone
  installer at `installer/install-cli.sh`. Shared project-resolution lib at
  `hooks/lib/resolve-project.sh`. Reference: `docs/um-cli.md`.
- **`installer/install-cli.sh`** standalone CLI installer (Phase D).
  Git-clone-based; writes an env-sourced managed block into `~/.bashrc` /
  `~/.zshrc`. Cross-platform CI matrix on ubuntu + macOS. Companion doc:
  `installer/install-cli.md`.
- **Shared `installer/lib/marker-block.sh`** sourced by both
  `install.sh` (full-server) and `install-cli.sh` (CLI-only) so the two
  installers emit identical rc-file blocks.
- **Token-cost measurement harness** at `server/test/token-cost.test.mjs`
  with a 20-query fixture + checked-in baseline JSONs (Phase 0 / B.1).
- **Schema drift gate**: `server/test/custom-gpt-actions.test.mjs`
  byte-matches `plugins/chatgpt-custom-gpt/universal-memory/actions-trimmed.yaml`
  against `openapi.mjs`'s generator output so the Custom GPT action spec
  cannot silently drift from the canonical schema.

### Changed

- **BREAKING for REST consumers**: `/api/search` and `/api/list` default
  response shape is now `{id, title, score, snippet}` (compact) instead of
  the full body with `metadata`. Pass `?full=1` to opt into full bodies.
  See `MIGRATION.md`.
- **BREAKING for MCP clients reading full bodies**: `memory_search`,
  `memory_list`, `memory_recent` return compact shape by default. Pass
  `full: true` in tool arguments to opt back in.
- **BREAKING for MCP listTools consumers**: `tools/list` returns 4 read
  tools by default (`memory_search`, `memory_list`, `memory_state`,
  `memory_recent`). The 7 write tools (`memory_add`, `memory_append_turn`,
  `memory_capture`, `memory_checkpoint`, `memory_delete`, `memory_forget`,
  `memory_supersede`) are filtered out unless `UM_MCP_WRITE_ENABLED=true`
  on the server. Direct `tools/call` against a filtered tool still returns
  `{ ok: false, error: "MCP writes disabled" }` (graceful) — commit
  `0cb912b`.
- `memory_recent` MCP tool now reads the filesystem directly (mtime-sorted)
  via `doRecent()` — previously wrapped `memory_search('session_summary',
  ...)` in v0.3. REST `/api/recent/{project}` has parity. `project` arg now
  required (commits `b9ed0cb`, `e956641`).
- Summarizer prompt compressed 35.5% and default model dropped to the cheap
  tier (commit `524cf0e`).
- Read-tool MCP descriptions trimmed — verbose examples moved to
  `docs/mcp-tools.md` (commit `2fd7cc6`).
- Install docs pivoted from `curl | bash` to `git clone + bash
  installer/install-cli.sh` for the standalone CLI (commit `267ba27`). The
  full-server `installer/install.sh` still supports `curl | bash` via
  self-bootstrap.
- `UM_LIB_DIR` env override wired into all `bin/um*` scripts (commits
  `d3ea4ad`, `92be508`) — lets the installer place hook libs at
  `~/.local/share/um/lib/` without requiring the full plugin tree.

### Fixed

Server:

- `/api/list` now honors `?limit` (was silently ignored — commit `5b3bd2d`).
- `decodeURIComponent` on `/api/state/{project}` path — URL-encoded project
  slugs parse correctly (commit `b42223c`).
- `doState` race-tolerance — non-ENOENT I/O errors log and return
  `state:null` instead of crashing (commits `3f838b1`, `47d3a29`).
- OpenAPI `id` field descriptions now read as filename stem (not mem0
  UUID); `actions-trimmed.yaml` regenerated (commit `5ca00a1`).
- `doRecent` surrogate-safe snippet slice + race-tolerant file reads
  (commit `a5bbd39`).
- MCP `memory_recent` now calls `doRecent` — was silently diverging from
  REST (commit `e956641`).
- Snippet-design fixture relocated to `server/config/` for Docker-image
  safety (commit `aaeaccd`).
- 500-response sanitization — `err.message` scrubbed in the top-level catch
  (commit `4ac9026`).

CLI:

- `um` usage log drops PII — logs `{timestamp, subcommand, arg_count}` only
  (commit `de69f2a`).
- `resolve-project.sh` slug validation — path-traversal guard; e.g.
  `--project "../evil"` rejected (commit `406a184`).
- `um.test.sh` uses an isolated temp dir (previously destroyed real
  subcommand files on cleanup — commit `3257038`).
- `um-tail.sh` sed unescape order fix for bodies with literal backslashes
  (commit `e3473b5`).
- CLI error messages surface `curl` exit code (`-fSsm` replaces `-sfm` —
  commit `171d530`).
- `um-capture` emits `exit 1` on write failure (commit `182539a`).
- `um-forget` / `um-supersede` honor `UM_SERVER_URL` with `UM_ENDPOINT`
  back-compat fallback (commit `bedb0e6`).
- `vault.sh` `date -d` BSD fallback for macOS `find_orphans` (commit
  `6440464`).

Installer:

- `install-cli.sh` guards `SHELL` / `HOME` unbound under `set -u` (commit
  `8ea2a07`).
- `install.sh` honors env-sourced contract (dropped silent Case-2 skip per
  plan RH6 — commit `a6e9dd5`).
- `marker-block.sh` same-dir mktemp + trap cleanup for atomic `mv` (commit
  `60185ca`); escapes single quotes in values (commit `be87cd7`).
- `install-cli.sh` verifies library + script copy success — no silent fail
  (commit `42dc103`).
- `um-tunnel` now copied by the installer; T1 label corrected from symlink
  to dispatcher (commit `9a983b7`).

CI:

- softprops release-asset action pinned to SHA + pre-check installer asset
  exists (commit `7dacb65`).
- Installer cross-platform matrix — ubuntu + macOS (commit `26f8e66`).
- `um.test.sh` uses a portable sed redirect — BSD-compatible (commit
  `8d0ccae`).

### Security

- MCP write tools are now hidden from the default `tools/list` response
  when `UM_MCP_WRITE_ENABLED=false` (default). Reduces accidental exposure
  of write capability to clients that discover tools via `tools/list`
  (Phase B.3, commit `0cb912b`).
- `GET /openapi.yaml` documented as intentionally unauthenticated — exposes
  schema only, no vault contents. See `docs/mcp-tools.md` Security section.
- Usage log stripped of PII (see CLI `de69f2a` above).

### Deprecated / Removed

- `installer/um-cli/lib/` duplicate removed; `install-cli.sh` now copies
  libs directly from `plugins/claude-code/universal-memory/hooks/lib/`
  (commit `714eb8f`).
- `um validate` subcommand dropped per Phase 0.5b (vault-as-git signal
  absent at gate). Phase A ships 7 subcommands, not 8.

### Notes / known limitations

- `/api/list` response envelope is still a raw array, not
  `{results: [...]}`. Intentionally preserved for backward compatibility
  per Phase B.1.4b — will be unified with `/api/search` and `/api/recent`
  in a future release. Not a regression in v0.4.
- Max-transcript tokenization projection (research doc §1 row 4b) is
  likely ~2× understated; the sample is BPE-optimal. Measurement
  methodology flagged for v0.5 tightening.
- `claude-agent-sdk` summarizer mode pipes the transcript but not the
  system prompt — a silent quality regression for that non-default config.
  Tracked as I4 for v0.5 (`summarize.sh` needs to prepend
  `_UM_SYSTEM_PROMPT`).

## [0.3.0-alpha] — 2026-04-20

Cross-platform release. Phases A–F of the v0.3 plan: Codex CLI plugin,
ChatGPT Desktop + Claude.ai + Custom GPT connection guides, OpenAPI 3.1
surface, `um-tunnel` CLI, OpenAI Assistants API example, pluggable
summarizer (`UM_SUMMARIZER`), `/um-preview` slash command, `install.sh
--yes`. See [ROADMAP.md](ROADMAP.md) for the shipped row link to the
release.

[Unreleased]: https://github.com/goldenwo/universal-memory/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/goldenwo/universal-memory/compare/v0.8.0-alpha...v1.0.0
[0.8.0-alpha]: https://github.com/goldenwo/universal-memory/compare/v0.7.0-alpha...v0.8.0-alpha
[0.7.0-alpha]: https://github.com/goldenwo/universal-memory/compare/v0.6.0-alpha...v0.7.0-alpha
[0.6.0-alpha]: https://github.com/goldenwo/universal-memory/compare/v0.5.0-alpha...v0.6.0-alpha
[0.5.0-alpha]: https://github.com/goldenwo/universal-memory/compare/v0.4.0-alpha...v0.5.0-alpha
[0.4.0-alpha]: https://github.com/goldenwo/universal-memory/releases/tag/v0.4.0-alpha
[0.3.0-alpha]: https://github.com/goldenwo/universal-memory/releases/tag/v0.3.0-alpha
