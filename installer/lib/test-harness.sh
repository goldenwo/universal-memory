#!/usr/bin/env bash
# installer/lib/test-harness.sh — shared dump-on-fail test helpers (#20, #21)
#
# Two helpers, designed to be sourced from any test script:
#
#   _tx_capture <label> <command...>
#     Run <command...> capturing stdout+stderr and exit code into globals
#     TX_OUT_<label> and TX_EXIT_<label>. The label scopes the variables so
#     multiple captures can coexist in one test (e.g., TX_OUT_install,
#     TX_OUT_postcheck) without clobbering each other.
#
#   _dump_on_fail <label>
#     If TX_EXIT_<label> is non-zero, dump TX_OUT_<label> to stderr framed
#     by markers. Use at the end of a test (or in a trap) so failing CI
#     runs surface the captured output without per-script ad-hoc plumbing.
#
# Why a shared file:
#   v0.5 had ~7 test scripts each shadowing TX_OUT/TX_EXIT in their own way,
#   needing per-file `# shellcheck disable=SC2034` to silence false positives
#   on capture variables. Centralising the convention here lets each script
#   drop the file-level disable (E.2 follow-up).

# _tx_capture — capture stdout+stderr + exit code under a label
_tx_capture() {
  local label="$1"; shift
  local out_var="TX_OUT_${label}"
  local exit_var="TX_EXIT_${label}"
  local tx_out tx_exit=0
  # shellcheck disable=SC2034  # tx_out/tx_exit consumed by the eval below
  tx_out=$("$@" 2>&1) || tx_exit=$?
  eval "$out_var=\$tx_out; $exit_var=\$tx_exit"
}

# _dump_on_fail — print captured output if the labeled command failed
_dump_on_fail() {
  local label="$1"
  local exit_var="TX_EXIT_${label}"
  local out_var="TX_OUT_${label}"
  if [ "${!exit_var:-0}" -ne 0 ]; then
    echo "=== DUMP ($label exit=${!exit_var}) ===" >&2
    echo "${!out_var}" >&2
    echo "=== END DUMP ===" >&2
  fi
}
