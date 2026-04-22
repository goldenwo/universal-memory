#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=./config.sh
source "$SCRIPT_DIR/config.sh"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "ok - $1"; }
fail() { FAIL=$((FAIL+1)); echo "not ok - $1"; }

# T1: basic KEY=value export
tmp=$(mktemp -d); cat > "$tmp/c" <<EOF
FOO=bar
BAZ=qux
EOF
unset FOO BAZ
_um_load_config "$tmp/c"
[ "${FOO:-}" = "bar" ] && [ "${BAZ:-}" = "qux" ] && pass T1-basic || fail T1-basic

# T2: env wins over config
unset FOO; export FOO=env-value
cat > "$tmp/c2" <<EOF
FOO=config-value
EOF
_um_load_config "$tmp/c2"
[ "$FOO" = "env-value" ] && pass T2-env-wins || fail "T2-env-wins: FOO=$FOO"

# T3: CRLF stripped (trailing)
printf 'CRKEY=crval\r\n' > "$tmp/crlf"
unset CRKEY
_um_load_config "$tmp/crlf"
[ "${CRKEY:-}" = "crval" ] && pass T3-crlf-trailing || fail "T3-crlf-trailing: CRKEY=${CRKEY:-UNSET}"

# T4: CRLF stripped (embedded inside quoted value — "foo\r")
printf 'QKEY="foo\r"\n' > "$tmp/qcrlf"
unset QKEY
_um_load_config "$tmp/qcrlf"
[ "${QKEY:-}" = "foo" ] && pass T4-crlf-embedded || fail "T4-crlf-embedded: QKEY=${QKEY:-UNSET} (hex: $(printf %s "${QKEY:-}" | xxd -p))"

# T5: quoted values unquoted (no re-expansion)
cat > "$tmp/q" <<'EOF'
DQ="hello world"
SQ='$EVIL; rm -rf /'
EOF
unset DQ SQ
_um_load_config "$tmp/q"
[ "${DQ:-}" = "hello world" ] && pass T5a-dquote || fail "T5a-dquote: DQ=${DQ:-UNSET}"
[ "${SQ:-}" = '$EVIL; rm -rf /' ] && pass T5b-squote-safe || fail "T5b-squote-safe: SQ=${SQ:-UNSET}"

# T6: invalid line log-and-skip (non-fatal)
cat > "$tmp/bad" <<EOF
VALID=ok
garbled line without equals
ALSO_VALID=also_ok
EOF
unset VALID ALSO_VALID
# T6a: call directly (no subshell) so exports propagate; discard warnings
_um_load_config "$tmp/bad" 2>/dev/null
[ "${VALID:-}" = "ok" ] && [ "${ALSO_VALID:-}" = "also_ok" ] && pass T6a-continue-after-invalid || fail T6a-continue
# T6b: call in subshell to capture warning text
out=$(_um_load_config "$tmp/bad" 2>&1 >/dev/null)
echo "$out" | grep -q "unparseable config line" && pass T6b-warning-emitted || fail T6b-warning

# T7: missing file returns 0
_um_load_config "/nonexistent/path/config" && pass T7-missing-file-ok || fail T7-missing-file

# T8: comments + blank lines ignored
cat > "$tmp/comments" <<EOF

# this is a comment
COMMENT_SAFE=ok
  # indented comment (NOT supported — this is a config line with # value)
EOF
unset COMMENT_SAFE
_um_load_config "$tmp/comments"
[ "${COMMENT_SAFE:-}" = "ok" ] && pass T8-comments || fail T8-comments

rm -rf "$tmp"

echo ""
echo "config.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
