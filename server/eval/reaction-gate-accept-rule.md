# FROZEN ACCEPT RULE — #215 reaction-salience gate measurement

**Status: FROZEN v5 (2026-08-01; 4 paired-Opus review rounds applied pre-freeze).** On freeze this header changes to FROZEN vN + date, the
file is sha256-hashed into `server/eval/accept-rule-215.sha256` (committed), and this file
is NEVER edited again — the measurement harness recomputes this file's hash and refuses to
emit any verdict on mismatch (H1, fail-closed, test-gated). This file is tracked (public):
it carries thresholds and protocol only — no corpus content. Rationale lives in the
gitignored spec (`docs/plans/2026-07-31-reaction-gate-measurement-spec.md`), which MAY
gain post-freeze deviation entries (§D); this file may not. Precedent: #188 anchored its
§5 text alone (`3da11fa`), keeping the spec appendable while the rule stayed frozen; here
the frozen unit is this standalone file, and tracking it makes deviation ordering
tamper-evident in git history.

## R1. Definitions (all frozen)

- **Scope:** ledger exchanges with `surface = 'mem0-compat'` for the operator user only
  (single-operator deployment; per-surface/user composition is a reported quantity).
  `'mem0-compat'` is the header-fallback surface the bot's captures carry today (#201
  live smoke: `reactions_7d` attaches under it), but it is `X-UM-Source`-overridable —
  so scoping is guarded, not assumed: if the UNSCOPED in-frame reacted count meets a
  volume arm while the scoped count does not, that is a **PRE-OUTCOME ABORT (scoping
  artifact)**, never PARK-SPARSE. PARK-SPARSE additionally requires the unscoped reacted
  count < 10.
- **T_freeze:** the recorded UTC instant a trigger snapshot (R2) is taken. The snapshot
  IS the check: counts are computed from the snapshot copy, and the copy that satisfies
  T-A/T-B becomes THE measurement snapshot (predictor state is therefore exactly
  reconstructible — `reaction_state` is last-write-wins and has no history). Unsatisfying
  snapshots are discarded (logged: date + counts).
- **Frame:** `W_start ≤ created_at ≤ T_freeze − M`; `W_start = 2026-08-01T00:00:00Z`,
  `M = 7 days`. (W_start may move ONLY via H5's mechanical forward-only excision — R7.)
- **Predictor (evaluated on the snapshot):** REACTED = ≥1 `reaction_state` row with
  `SUM(count) ≥ 1`. ZEROED = rows exist, sum 0 (reported `n_zeroed`; counted unreacted;
  excluded from the S2 pool). UNREACTED = no rows.
- **Strata:** S1 = stored+reacted in-frame; S2 = stored+never-reacted control (draw R3);
  S3 = abstained+reacted (secondary); S4 = abstained+unreacted (denominator only).
- **Point attribution:** where a `point_refs` entry carries `event` (recorded at capture
  from `umAdd` results — v1.13.2+): **AUTHORED** iff `event ∈ {ADD, SUPERSEDED_INBAND}`;
  **INHERITED** iff `event = DEDUP_MERGED`. For eventless rows (written pre-v1.13.2):
  AUTHORED iff no earlier ledger row references the same id AND payload `createdAt` ∈
  `[row.created_at − 1h, row.created_at + 1h]`; the heuristic-classified fraction is
  reported. Inherited facts are excluded from the outcome; inherited fraction reported
  per stratum. Superseded points are labeled on their stored text (at-the-time
  store-worthiness); superseded fraction reported per stratum.
- **Labelable exchange:** ≥1 AUTHORED, resolvable (H2) fact. `n1` = labelable S1
  exchanges post-exclusions; `n2` likewise for S2; `n1_facts`/`n2_facts` = their authored
  resolvable fact counts. The raw trigger count `|S1|` is pre-exclusion.
- **Outcome (primary, fact-level):** each authored resolvable fact is blind-labeled (R6);
  store-worthy = label ∈ {D, U}. `q1` = store-worthy fraction of S1's authored facts,
  `q2` likewise for S2. A point authored in one arm and inherited-referenced in the other
  leaks nothing (inherited refs are excluded); the cross-arm reference count is reported.
- **Descriptive only (never gated):** exchange-level ≥1-store-worthy rates; k (fact
  count) distribution per stratum + k-bucket (k ≤ 2 vs k ≥ 3) sensitivity; per-week
  n1w/n2w balance table + the week-balanced mean of within-week diffs; label
  distribution incl. X rate.

## R2. Trigger (when phase 2 runs)

- A trigger check = take a ledger snapshot, compute **stratum counts only** (never fact
  text, labels, payloads, or any outcome-bearing value — the ledger file itself is
  content-free: ids/hashes/timestamps/verdicts). At most one check per 7 days, each
  logged in `server/eval/reaction-gate-runs.log`.
- **T-A (volume):** raw in-frame `|S1| ≥ 20` AND never-reacted stored pool ≥ `|S1|` → run.
- **T-B (backstop):** a check MUST be run in the window 2026-11-01..2026-11-15 (missing
  it is a recorded protocol violation; the next check evaluates T-B late). On the first
  check on/after 2026-11-01: `10 ≤ |S1| < 20` (same pool condition) → run under this same
  rule; `|S1| < 10` (and unscoped < 10 — R1 scope guard) → **PARK-SPARSE** (terminal):
  publish stratum counts and base rates only, no labeling, no gate evaluation; re-opening
  requires a NEW pre-registration. A stage-2 abort on a T-B run does NOT strand the
  registration: the trigger re-arms as T-B and every subsequent check (≥ 7d apart)
  re-evaluates these same arms.
- **Registration lapse (global backstop):** if NO run has reached stage 7 by
  **2027-03-01**, the registration lapses to terminal PARK (counts published; new
  pre-registration required to continue). Complements R5.6's own lapse (that one governs
  the post-stage-7 re-run branch; this one every pre-stage-7 path) — together no path
  escapes both. A T-B check whose volume arm passes but whose pool condition fails is
  treated as a stage-2 abort: re-arm as T-B, global lapse backstops.
- **Environment preconditions:** (1) `UM_CAPTURE_LEDGER_RETENTION_DAYS ≥ 400` live on
  the Pi before 2026-08-25 (first at-risk prune of in-frame rows: 2026-08-31; 400d covers
  the registration's full lifetime W_start → 2027-03-01 lapse = 212d with slack —
  round-2 fix: 180d was shorter than the registration itself). Verified mechanically by
  H5. (2) NO vault reindex during the frame (reindex re-mints ids / re-stamps payloads;
  a violation trips H2/H3a and voids the run — the detectors are the enforcement).

## R3. Control draw (S2) and floors

Seeded (**20260801**; run 2 uses **20260802**), **date-stratified**: within each ISO week
of the frame, draw `round(2 × |S1 ∩ week|)` never-reacted stored exchanges (whole pool if
smaller; realized per-week balance is reported). Floors, all evaluated at R4 stage 2
(PRE-OUTCOME ABORT on failure): labelable `n2 ≥ n1`; `n1_facts ≥ 30`; `n2_facts ≥ 30`.
(The fact floors also floor the d computation at ≥ 60 items.)

## R4. Staged computation (harness-enforced order; leak minimization)

1. **H1** anchor check — nothing runs on mismatch.
2. Snapshot (= the firing trigger check) → strata → mechanical exclusions →
   **R1 scope guard (scoped/unscoped divergence) + H2/H2b/H3/H5** + R3 floors. Any
   failure → **PRE-OUTCOME ABORT**: publishable,
   fixable; VOIDS this T_freeze entirely (the run never happened; logged); the trigger
   re-arms and a future check (≥ 7 days later) mints a new T_freeze and frame — which is
   how frame-frozen conditions (pruned pool, starved control) become fixable. Does NOT
   consume the run cap.
3. Emit blind item files; **commit their sha256s + the snapshot's sha256** to
   `reaction-gate-runs.log` BEFORE any labeling pass.
4. Blind passes + adjudication (R6).
5. Compute **d** alone. `d > 0.25` → **G3 ABORT**: exactly ONE instrument repair (fresh
   blind passes on the SAME committed item files; rubric clarifications recorded as a
   deviation entry); `d > 0.25` again → **PARK-INSTRUMENT** (terminal).
6. Compute **q2** alone. `q2 ≥ 0.75` → **G0 ABORT-INSTRUMENT** (terminal; any successor
   design is a new pre-registration). q1 and the contrast are never computed here.
7. Compute q1, the contrast, G1/G2 → decision (R5).

A run consumes the 2-run cap iff stage 7 is reached. Every snapshot/check/run appends to
`reaction-gate-runs.log` (committed): date, kind, T_freeze, stage reached, artifact
hashes, counts, outcome. Gaps in the log are a protocol violation reported in the results
doc.

## R5. Gates and decision mapping (ordered; first match wins)

Gates:
- **G1 (headroom-normalized effect):** `q1 − q2 ≥ 0.25 × (1 − q2)` — closes ≥ 25% of the
  available headroom. (Round-2 fix: a flat 0.25 made gate difficulty a function of the
  nuisance q2, with a dead band under G0's ceiling; the relative form is uniform across
  q2 and follows the house precedent of relative rules — A3's B/2.)
- **G2 (calibration-matched permutation):** one-sided **within-week** permutation —
  stratum labels permuted within each ISO-week block, preserving per-week arm counts
  (matching the R3 sampling design — round-2 fix: an unrestricted null is miscalibrated
  where a week's pool binds); statistic = pooled `q1 − q2`; a replicate with an empty arm
  scores 0 (defensive convention — unreachable while the R3 floors hold); 10,000
  permutations; seed 20260801 (run 2: 20260802);
  `p = (1 + #{perm ≥ obs}) / 10001`; pass iff `p ≤ 0.05`.

Mapping:
1. Stage-2 failure → PRE-OUTCOME ABORT (T_freeze voided; re-arm; cap unconsumed).
2. G3 (d > 0.25 after one repair) → PARK-INSTRUMENT (terminal).
3. G0 (q2 ≥ 0.75) → ABORT-INSTRUMENT (terminal; new registration required).
4. G1 AND G2 → **FLIP-SPEC**: authorizes WRITING a salience spec scoped to **read-path
   ranking / retention / late-salience weighting only** (reactions arrive after capture —
   #201 — so write-time admission cannot consume them). No behavior change ships from
   this verdict alone. The flip spec must address the k-bucket sensitivity and the
   inherited-fraction differential.
5. `q1 − q2 ≤ 0` → **PARK-NEGATIVE** (terminal; numbers published; pipeline stays).
6. Otherwise → **PARK-INCONCLUSIVE**: ONE re-run permitted when raw in-frame
   `|S1| ≥ 2 × n1(run 1)`; the re-run is a FULL fresh cycle on its own later frame —
   new snapshot, S2 redrawn with seed 20260802, ALL items re-labeled fresh (run-1 labels
   are never reused), d recomputed. Recorded property: two looks at nominal α = 0.05 ≈
   family-wise 0.08-0.10 — accepted for a park/ship engineering decision, stated in the
   results doc. Lapses to terminal PARK if the doubling has not fired by **2027-03-01**.

Secondary (never feeds the mapping): if `|S3| ≥ 5` resolvable items, report `fa` =
store-worthy rate of S3 content WITH its 95% Wilson interval; `fa ≥ 0.4` is recorded as
evidence toward a future reaction-rescue registration. Else INSUFFICIENT. S3 exclusions
itemized (id + reason).

## R6. Labeling instrument (frozen verbatim; rubric inline)

Two independent blind subagent passes, then blind adjudication of disagreements by the
primary session (items unattributed, seeded-random order, seed 20260801 / run-2
20260802). Item files carry fact text ONLY — no reaction fields, verdicts, capture ids,
timestamps, or stratum marks; S1∪S2 facts pooled and shuffled in one file; S3 content
items in a second. `d` = pre-adjudication disagreement rate on the binary collapse
(D∪U vs rest) over S1∪S2 items. Enum (closed):

- **D** — durable fact about the work/world: decisions, outcomes, stable configurations,
  lessons, commitments. Would plausibly matter to a future session.
- **U** — durable fact about the USER: preferences, identity, standing rules.
- **E** — ephemeral status: transient state, in-flight progress, soon-stale observations.
- **T** — observer telemetry: meta-commentary on the session/tooling itself.
- **F** — referent-stripped: depends on a referent the text no longer carries.
- **X** — unlabelable: empty, truncated, or unintelligible.

Store-worthy = D ∪ U. Model-family residual (recorded): all labeling roles are
Claude-family; correlated bias lifts deltas and the floor together.

## R7. Health gates (floors frozen)

| Gate | Test | On fail |
|---|---|---|
| **H1** | sha256(this file) == committed `server/eval/accept-rule-215.sha256` line. Missing anchor, missing file, or mismatch → refuse before ANY other work. | Refuse (no verdict) |
| **H2** | Per-stratum excluded-ref fraction (dangling after read-only `(userId, hash)` re-resolution; the harness never writes `point_refs` back) `≤ 0.10`, AND between-arm differential `|excl(S1) − excl(S2)| ≤ 0.05` (round-2: differential attrition vs a headroom-relative effect gate). | PRE-OUTCOME ABORT |
| **H2b** | Text binding: every resolved ref has `point_refs.hash == payload.hash` AND `md5(payload.data) == payload.hash` (write-time evidence crossing id→text attribution; `add.mjs` invariant). Violations = 0. | PRE-OUTCOME ABORT |
| **H3** | Id-space: (a) NO in-frame ledger-referenced point carries `metadata.id` (`doSearch` projects `metadata.id ?? point id`, `mem0-mcp-http.mjs:1851`) — any violation → FAIL; (b) stratified probes — `min(10, n)` seeded picks per stratum from CURRENT points, S1 AND S2, empty probe stratum = FAIL; `doSearch` with the fact's own text must surface the projected id at rank ≤ 3; **at most 1 miss per stratum** (round-2: a fractional floor at small n was an accidental zero-miss rule). | PRE-OUTCOME ABORT |
| **H4** | Denominators derive ONLY from `capture_ledger` + `exchange_tally`. CI-gated by a negative-control fixture whose `capture_extraction` counters imply different numbers. | CI gate |
| **H5** | Retention detector, SCOPED to `surface='mem0-compat'` + operator user: in-frame tally rows for that scope = 0 (other-surface/smoke tally rows do not trip it). On failure the damage is permanent for the affected prefix under a fixed W_start, so the repair is a mechanical, forward-only, outcome-blind frame excision: `W_start' = (last in-frame tally day) + 1`, logged in runs.log; symmetric across arms (reacted rows survive pruning but the excised prefix is dropped from S1 too). Then PRE-OUTCOME ABORT + re-arm as usual. | PRE-OUTCOME ABORT (+ frame excision) |

## D. Deviation protocol

Post-freeze deviations (the #188 D1/D2 shape) are permitted ONLY for **mechanics
repairs** — never thresholds, margins, floors, caps, seeds, windows, or the decision
mapping. A deviation MUST be: (1) recorded as a numbered D-entry whose FULL text (what
changed, why the frozen text is broken) is appended to `reaction-gate-runs.log`
(tracked — content AND ordering are tamper-evident, not just ordering) and mirrored in
the SPEC, BEFORE the affected quantity is first computed; (2) accompanied by why the frozen text is broken (not
inconvenient); (3) listed prominently in the results doc. A broken threshold or mapping
has no repair path: it requires a NEW pre-registration (new rule file + new anchor), and
the results doc must link the abandoned registration and its runs.log trail. "The change
makes gates harder" is recorded context, never sufficient justification (#188 §10.4).

## Reported-only quantities (frozen list; no thresholds, no gates)

Base rates `r(verdict)` from live rows + tally; stratum sizes (raw and labelable);
`n_zeroed`; cross-arm reference count; inherited fraction per stratum;
heuristic-attribution fraction (eventless rows); superseded fraction per stratum; k
distribution + k-bucket sensitivity; per-week n1w/n2w balance + week-balanced diff;
label distribution + X rate; per-surface/user composition; resolution-tier composition
(NULL `run_id` share, mem0ai/mem0#6708) + `refinerDisagreed` counter at T_freeze;
reactions-per-week series; S3 resolution losses. Recorded limitation: the permutation
null is not conditioned on the G0 non-abort event (anti-conservative only near the
ceiling, where the headroom-relative G1 dominates decisions).
