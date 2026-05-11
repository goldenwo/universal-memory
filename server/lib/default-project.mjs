/**
 * server/lib/default-project.mjs — F1 unification helper (v1.1).
 *
 * Single source of truth for "when a write tool is invoked without a project
 * slug, what do we put it under." Resolves the heterogeneous behavior the A1
 * audit (docs/audits/2026-05-08-cross-surface-defaults.md §F1) called out:
 *
 *   Before F1 (v1.0 and the v1.1 D1 landing):
 *     - memory_capture       → hardcoded literal 'default'
 *     - memory_add           → silently dropped project metadata
 *     - memory_append_turn   → hard-failed with INPUT_INVALID
 *     - memory_checkpoint    → hard-failed with INPUT_INVALID
 *
 *   After F1:
 *     - All four write tools call `applyDefaultProject({...})` on the falsy
 *       arm and land under `umDefaultProject()`. Each call emits a one-line
 *       warn so operators can observe the soft-default firing.
 *     - Wrong-type / regex-failing values still hard-fail (programmer or
 *       hostile-input error, not "missing"). Only the falsy arm flips.
 *
 *   Read tools (memory_state, memory_recent) keep their hard-fail — an
 *   ambiguous-project read returning a fallback project's data would be
 *   misleading. memory_search remains project-optional (post-filter).
 *
 * Env var: `UM_DEFAULT_PROJECT`. Defaults to 'default' when unset OR when set
 * to an invalid slug (falls back + warns; an invalid env value should not
 * brick writes). The valid slug regex matches the existing PROJECT_SLUG_RE in
 * append-turn.mjs and the VALID_SLUG in checkpoint.mjs — kept here as the
 * canonical pattern so the env value is validated against the same rule the
 * tools enforce on caller input.
 */

/**
 * Canonical project / safe-name slug regex.
 *
 * Single source of truth for v1.1 F1 onwards. Previously duplicated across
 * `append-turn.mjs:PROJECT_SLUG_RE`, `checkpoint.mjs:VALID_SLUG`, and
 * `mem0-mcp-http.mjs:SAFE_NAME_RE` — all three are identical
 * `/^[a-zA-Z0-9._-]+$/` and now import from here. Post-merge review of
 * PR #78 flagged that the fourth caller had appeared (`validateSafeName` in
 * `mem0-mcp-http.mjs`), tripping the "if a fourth caller appears" trigger
 * the original F1 helper TODO'd. This export closes that loop.
 *
 * Exported because both this module's policy helpers AND the caller-input
 * validation paths (`validateSafeName` for `metadata.id` / `metadata.project`
 * filename components) need the same shape.
 */
export const PROJECT_SLUG_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Canonical tool identifiers for the `tool` arg of `applyDefaultProject`.
 *
 * The helper accepts any string at runtime (it's used only for the warn log
 * payload — not for validation), but every call site in the codebase passes
 * one of these five values. Keep this object frozen so a typo at a new call
 * site fails at write-time (`TOOL_IDS.MEMRY_ADD` → undefined → typeof check)
 * rather than producing a silently-wrong log binding.
 *
 * Surface coverage:
 *   - MEMORY_CAPTURE / MEMORY_ADD / MEMORY_APPEND_TURN / MEMORY_CHECKPOINT
 *     → MCP write tools (server/mem0-mcp-http.mjs + lib/append-turn.mjs +
 *       lib/checkpoint.mjs)
 *   - API_ADD → REST POST /api/add (server/mem0-mcp-http.mjs) — distinct
 *     surface from MEMORY_ADD so the warn log shows which transport saw the
 *     omission (ChatGPT Custom GPT uses the REST path per A1 audit §F6).
 */
export const TOOL_IDS = Object.freeze({
  MEMORY_CAPTURE: 'memory_capture',
  MEMORY_ADD: 'memory_add',
  MEMORY_APPEND_TURN: 'memory_append_turn',
  MEMORY_CHECKPOINT: 'memory_checkpoint',
  API_ADD: 'api_add',
});

// One-shot warn flag for an invalid UM_DEFAULT_PROJECT env value. We warn on
// the first resolve() call that observes the bad value, then suppress to keep
// the log clean if the same write tool is invoked in a tight loop. Process
// lifetime; resets on restart.
let _invalidEnvWarnEmitted = false;

/**
 * Reset the one-shot invalid-env warn flag. **Test-only seam** — production
 * code MUST NOT call this. Without it, ordering-dependent test runs cannot
 * deterministically observe the warn (e.g. a later test asserting the warn
 * fired would silently degrade to a no-op if an earlier test consumed the
 * one-shot). Post-merge review of PR #78 flagged this as a test-flake hazard.
 *
 * @internal
 */
export function _resetInvalidEnvWarnForTests() {
  _invalidEnvWarnEmitted = false;
}

/**
 * Resolve the operator-configured default project slug.
 *
 * Returns the validated `UM_DEFAULT_PROJECT` env value if it is a non-empty
 * slug; otherwise returns the literal `'default'`. When the env is SET but
 * fails validation, emits a one-shot warn via the supplied logger so the
 * operator gets a breadcrumb that their config is being ignored.
 *
 * @param {object} [opts]
 * @param {{warn: Function}} [opts.logger] — pino-shaped logger (warn method);
 *   when omitted the invalid-env warn is silently suppressed (keeps unit-test
 *   call sites free of logger plumbing).
 * @returns {string} slug — guaranteed to match PROJECT_SLUG_RE.
 */
export function umDefaultProject({ logger } = {}) {
  const raw = process.env.UM_DEFAULT_PROJECT;
  if (raw && PROJECT_SLUG_RE.test(raw)) return raw;
  if (raw && !_invalidEnvWarnEmitted && logger?.warn) {
    _invalidEnvWarnEmitted = true;
    logger.warn(
      { um_default_project_env: raw },
      'UM_DEFAULT_PROJECT is set but does not match the project slug pattern ' +
      '/^[a-zA-Z0-9._-]+$/; falling back to literal "default" for this and ' +
      'subsequent writes until the env is fixed.',
    );
  }
  return 'default';
}

/**
 * Apply the F1 soft-default policy. Returns the effective project slug to use
 * for the write, and (when defaulting) emits a one-line warn so the
 * soft-default is observable per A1 audit finding F4.
 *
 * Semantics:
 *   - Falsy `project` (undefined / null / '') → returns `umDefaultProject()`
 *     and emits a warn keyed by tool + request_id (when logger supplied).
 *   - Non-falsy, non-string `project` → returns `null` so the caller can
 *     emit its existing hard-fail envelope (programmer error; do not
 *     silently coerce).
 *   - Non-falsy string that fails the slug regex → returns `null` (caller
 *     hard-fails; an invalid caller-supplied slug should not be silently
 *     substituted with the default).
 *   - Valid slug → returns it unchanged.
 *
 * @param {object} args
 * @param {*} args.project — raw caller-supplied value (any type).
 * @param {string} args.tool — tool name for the warn log (memory_add,
 *   memory_capture, memory_append_turn, memory_checkpoint).
 * @param {{warn: Function}} [args.logger]
 * @param {string} [args.requestId] — pino ALS-correlated request id, when
 *   available; omitted from the warn payload when not.
 * @returns {string|null} effective project slug, or null if the caller
 *   should hard-fail (wrong-type or regex-mismatch).
 */
export function applyDefaultProject({ project, tool, logger, requestId } = {}) {
  // Falsy → soft-default + warn.
  if (project === undefined || project === null || project === '') {
    const effective = umDefaultProject({ logger });
    if (logger?.warn) {
      logger.warn(
        {
          tool,
          ...(requestId ? { request_id: requestId } : {}),
          project_effective: effective,
          reason: 'caller_omitted_project',
        },
        `${tool}: caller omitted project; defaulting to "${effective}" ` +
        '(set UM_DEFAULT_PROJECT to override the fallback slug).',
      );
    }
    return effective;
  }
  // Non-falsy non-string OR regex-mismatch → caller hard-fails.
  if (typeof project !== 'string' || !PROJECT_SLUG_RE.test(project)) return null;
  return project;
}
