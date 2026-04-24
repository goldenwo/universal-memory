# shellcheck shell=bash
# hooks/lib/config.sh — sourced by bin/um dispatcher to load KEY=value config files.
# Contract per docs/um-cli.md: env > repo-local > user-global; values are literal bytes;
# CRLF globally stripped; invalid lines log-and-skip.

_um_load_config() {
  local path="$1"
  [ -r "$path" ] || return 0
  local line key value lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    case "$line" in ''|'#'*) continue ;; esac
    if [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      # RH9 R2-round + M3 R3-round: global CR-strip handles trailing CR + embedded CR
      value="${value//$'\r'/}"
      # Strip surrounding single or double quotes (do NOT re-expand contents)
      case "$value" in
        \"*\") value="${value%\"}"; value="${value#\"}" ;;
        \'*\') value="${value%\'}"; value="${value#\'}" ;;
      esac
      # H1 R3-round precedence fix: only export if the key is not already set in env
      if [ -z "${!key+x}" ]; then
        # shellcheck disable=SC2163
        export "$key=$value"
      fi
    else
      echo "um: warning: $path:$lineno: unparseable config line (skipping)" >&2
    fi
  done <"$path"
}
