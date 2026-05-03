#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=./config.sh
source "$SCRIPT_DIR/config.sh"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "ok - $1"; }
fail() { FAIL=$((FAIL+1)); echo "not ok - $1"; }
# Wrap a command (or `[` test) into a pass/fail call. Avoids the
# A && pass || fail SC2015 idiom: if `pass` ever returned non-zero
# (even though it can't here), the `|| fail` would fire spuriously.
check() { local desc="$1"; local msg="${2:-$1}"; shift 2; if "$@"; then pass "$desc"; else fail "$msg"; fi; }

# T1: basic KEY=value export
tmp=$(mktemp -d); cat > "$tmp/c" <<EOF
FOO=bar
BAZ=qux
EOF
unset FOO BAZ
_um_load_config "$tmp/c"
if [ "${FOO:-}" = "bar" ] && [ "${BAZ:-}" = "qux" ]; then pass T1-basic; else fail T1-basic; fi

# T2: env wins over config
unset FOO; export FOO=env-value
cat > "$tmp/c2" <<EOF
FOO=config-value
EOF
_um_load_config "$tmp/c2"
check T2-env-wins "T2-env-wins: FOO=$FOO" [ "$FOO" = "env-value" ]

# T3: CRLF stripped (trailing)
printf 'CRKEY=crval\r\n' > "$tmp/crlf"
unset CRKEY
_um_load_config "$tmp/crlf"
check T3-crlf-trailing "T3-crlf-trailing: CRKEY=${CRKEY:-UNSET}" [ "${CRKEY:-}" = "crval" ]

# T4: CRLF stripped (embedded inside quoted value — "foo\r")
printf 'QKEY="foo\r"\n' > "$tmp/qcrlf"
unset QKEY
_um_load_config "$tmp/qcrlf"
check T4-crlf-embedded "T4-crlf-embedded: QKEY=${QKEY:-UNSET} (hex: $(printf %s "${QKEY:-}" | xxd -p))" [ "${QKEY:-}" = "foo" ]

# T5: quoted values unquoted (no re-expansion)
cat > "$tmp/q" <<'EOF'
DQ="hello world"
SQ='$EVIL; rm -rf /'
EOF
unset DQ SQ
_um_load_config "$tmp/q"
check T5a-dquote "T5a-dquote: DQ=${DQ:-UNSET}" [ "${DQ:-}" = "hello world" ]
# '$EVIL; rm -rf /' is an intentional literal — the test verifies single-quoted
# config values are NOT re-expanded. SC2016 disabled at the literal site.
# shellcheck disable=SC2016
check T5b-squote-safe "T5b-squote-safe: SQ=${SQ:-UNSET}" [ "${SQ:-}" = '$EVIL; rm -rf /' ]

# T6: invalid line log-and-skip (non-fatal)
cat > "$tmp/bad" <<EOF
VALID=ok
garbled line without equals
ALSO_VALID=also_ok
EOF
unset VALID ALSO_VALID
# T6a: call directly (no subshell) so exports propagate; discard warnings
_um_load_config "$tmp/bad" 2>/dev/null
if [ "${VALID:-}" = "ok" ] && [ "${ALSO_VALID:-}" = "also_ok" ]; then pass T6a-continue-after-invalid; else fail T6a-continue; fi
# T6b: call in subshell to capture warning text
out=$(_um_load_config "$tmp/bad" 2>&1 >/dev/null)
if echo "$out" | grep -q "unparseable config line"; then pass T6b-warning-emitted; else fail T6b-warning; fi

# T7: missing file returns 0
if _um_load_config "/nonexistent/path/config"; then pass T7-missing-file-ok; else fail T7-missing-file; fi

# T8: comments + blank lines ignored
cat > "$tmp/comments" <<EOF

# this is a comment
COMMENT_SAFE=ok
  # indented comment (NOT supported — this is a config line with # value)
EOF
unset COMMENT_SAFE
_um_load_config "$tmp/comments"
check T8-comments "T8-comments" [ "${COMMENT_SAFE:-}" = "ok" ]

rm -rf "$tmp"

echo ""
echo "config.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
