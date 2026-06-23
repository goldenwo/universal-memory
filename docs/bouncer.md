# Read-path answer bouncer

> **Status:** ships in v1.5 behind `UM_BOUNCER_ENABLED` (default **off**, opt-in).
> Results are never removed or reordered — the bouncer is a pure advisory signal.

## What it is

When `memory_search` returns results, the bouncer asks: does the top hit actually *answer* the query? If the hit's score falls in the ambiguous band and the LLM grader says "no", the response envelope receives an advisory `answered: false` field. Callers that don't check the field are unaffected — they get the same results as today.

The bouncer never removes or reorders results (recall-safe). It only surfaces a quality signal on top of the existing response.

## Wire shape

Normal response (bouncer off, or top hit answers):
```json
{ "results": [...] }
```

Flagged response (bouncer on, top hit graded as not answering):
```json
{ "results": [...], "answered": false }
```

The `answered` key is **absent** on normal responses; present and `false` only when the bouncer flags. The `results` array is identical in both cases.

## Env knobs

| Variable | Default | Meaning |
|---|---|---|
| `UM_BOUNCER_ENABLED` | unset (off) | Set to `true` to enable. **Opt-in** — the only `*_ENABLED` flag in this project that is default-off (all others are opt-out). Deliberately inert while soaking; flip to opt-out at the default-on decision. |
| `UM_BOUNCER_TIMEOUT_MS` | `1500` | Grader timeout in milliseconds. On timeout or any grader error the bouncer **fails open** — no flag is attached, results are returned unchanged. |

**Polarity note:** `UM_BOUNCER_ENABLED` is `=== 'true'` opt-in, unlike `UM_DEDUP_ENABLED` / `UM_AUTOSUPERSEDE_ENABLED` / `UM_LANE_CLASSIFIER_ENABLED`, which are `!== 'false'` opt-out. This will invert to opt-out at the default-on flip (post-soak).

## Cost

The grader LLM call fires **only** when the top hit's score is in the ambiguous band (≤ `BOUNCER_SCORE_GATE`). Clearly-strong hits (score above the gate) skip the grader entirely — they are counted as `skipped_high` in the metric. The gate constant lives in `server/lib/bouncer.mjs`.

Provider and model resolution follow the same chain as the answer-correctness eval grader:
`UM_ANSWER_GRADER_PROVIDER` → `UM_SUMMARIZER_PROVIDER` → `openai`; model similarly.

## Metric

```
um_bouncer_total{outcome=...}
```

| `outcome` | Meaning |
|---|---|
| `flagged` | Graded; top hit does not answer → `answered:false` emitted |
| `answered` | Graded; top hit answers → no flag |
| `skipped_high` | Score above gate; LLM skipped |
| `failopen` | Grader error or timeout; no flag (fail-open) |

Watch the `flagged` / `skipped_high` / `failopen` rates after enabling. A high `failopen` rate signals grader latency or provider issues.

## Later steps (not in this build)

- **Default-on flip** (opt-out polarity) — after sufficient soak data from `um_bouncer_total`.
- **Hard-drop mode** — a future `UM_BOUNCER_HARD_DROP=true` flag that removes flagged hits instead of advisory-flagging (separate eval gate required before shipping).
- **p99 latency telemetry** — expose grader call latency so the default-on cost/latency tradeoff is data-informed.
- **Growing the no-answer eval set** — the offline `eval/answer-grader-eval.mjs` fixture currently covers the PR-132 baseline; extend it before changing `TAU_ANSWER` or the grader model.
