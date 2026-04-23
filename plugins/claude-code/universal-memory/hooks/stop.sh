#!/bin/bash
# stop.sh — append-only raw capture. No LLM, no state update. <50ms.

# Recursive-hook guard — if invoked inside a summarizer subprocess (A3's
# claude-agent-sdk backend spawns `claude -p`), exit immediately. Without
# this, the nested `claude` process would re-trigger this hook, causing
# duplicate captures at best and infinite loop at worst.
if [ "${UM_IN_SUMMARIZER_SUBPROCESS:-}" = "1" ]; then exit 0; fi

set -uo pipefail

TRANSCRIPT=$(cat)
[ -z "$TRANSCRIPT" ] && exit 0

PROJECT=$(basename "${CLAUDE_CWD:-$(pwd)}")
VAULT="${UM_VAULT_DIR:-$HOME/.um/vault}"
DATE=$(date -u +%Y-%m-%d)
TIME=$(date -u +%H:%M:%SZ)
RAW_DIR="$VAULT/captures/$PROJECT/raw"
mkdir -p "$RAW_DIR"

RAW_FILE="$RAW_DIR/$DATE.md"
LOCK_FILE="$RAW_FILE.lock"

# Write truncated transcript to a temp file so perl can read it without
# conflicting with the heredoc that provides perl's program source.
_UM_TMP=$(mktemp)
trap 'rm -f "$_UM_TMP"' EXIT
printf '%s' "$TRANSCRIPT" | head -c 10000 > "$_UM_TMP"

# Acquire an exclusive advisory lock on the sibling .lock file before appending,
# so that concurrent stop.sh invocations and the memory_append_turn MCP tool
# (Task 1.3) do not interleave writes. Both writers lock the same <date>.md.lock path.
#
# Uses perl Fcntl::flock (flock(2) syscall) for portability across Linux, macOS,
# and Windows Git Bash, where the util-linux `flock` binary may be unavailable.
perl - "$LOCK_FILE" "$RAW_FILE" "$TIME" "$_UM_TMP" <<'PERL_FLOCK'
    use Fcntl qw(:flock);
    my ($lock_file, $raw_file, $time, $tmp) = @ARGV;
    open(my $t_fh,    '<', $tmp)       or die "stop.sh: cannot open tmp $tmp: $!";
    local $/; my $transcript = <$t_fh>; close($t_fh);
    open(my $lock_fh, '>>', $lock_file) or die "stop.sh: cannot open lock $lock_file: $!";
    flock($lock_fh, LOCK_EX)            or die "stop.sh: cannot flock $lock_file: $!";
    open(my $out_fh,  '>>', $raw_file)  or die "stop.sh: cannot open raw $raw_file: $!";
    print $out_fh "## $time\n\n$transcript\n\n";
    close($out_fh);
    flock($lock_fh, LOCK_UN);
    close($lock_fh);
PERL_FLOCK

exit 0
