#!/usr/bin/env bash
# pm-patterns-state.sh — firing log for good-pm-bad-pm tripwires.
#
# Append-only JSONL (same convention as events.jsonl); local hook-state,
# gitignored, never distributed. Single writer for the file.
#
#   --fired <pattern-id>   append one firing (kebab-case id from the catalog)
#   --status [--json]      aggregate: per-pattern count + last_fired_at
set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ACTION=""
PATTERN_ID=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --fired)
      ACTION="fired"
      if [ "$#" -ge 2 ]; then
        PATTERN_ID="$2"
        shift 2
      else
        PATTERN_ID=""
        shift 1
      fi
      ;;
    --status) ACTION="status"; shift ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"
STATE_DIR="$ROOT/📂 Context/Work/.hook-state"
STATE_FILE="$STATE_DIR/pm-patterns.jsonl"

case "${ACTION:-status}" in
  fired)
    if ! printf '%s' "$PATTERN_ID" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$'; then
      echo '{"status":"error","message":"invalid_pattern_id"}' >&2
      exit 2
    fi
    mkdir -p "$STATE_DIR"
    printf '{"pattern":"%s","at":"%s"}\n' "$PATTERN_ID" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$STATE_FILE"
    tail -n 1 "$STATE_FILE"
    ;;
  status)
    if [ ! -f "$STATE_FILE" ]; then
      echo '{"patterns":[]}'
      exit 0
    fi
    awk '
      match($0, /"pattern":"[a-z0-9-]+"/) {
        id = substr($0, RSTART + 11, RLENGTH - 12)
        at = ""
        if (match($0, /"at":"[^"]*"/)) at = substr($0, RSTART + 6, RLENGTH - 7)
        if (at == "") next
        count[id]++
        last[id] = at
      }
      END {
        printf "{\"patterns\":["
        sep = ""
        for (id in count) {
          printf "%s{\"pattern\":\"%s\",\"count\":%d,\"last_fired_at\":\"%s\"}", sep, id, count[id], last[id]
          sep = ","
        }
        printf "]}\n"
      }
    ' "$STATE_FILE"
    ;;
  *)
    echo "ERROR: no action provided" >&2
    exit 2
    ;;
esac
