#!/usr/bin/env bash
# append-user-memory.sh
#
# Append a confirmed, universal memory note to `📂 Context/Work/.hook-state/user-memory.md`.
# This is the global-escalation target: PM updates that span multiple active
# projects belong here, not duplicated across project events.jsonl files.
#
# Inputs:
#   --content-file <path>  Markdown body to append (required, ≤16 KiB).
#   --source <ref>         Optional short source ref (path, URL, or label).
#   --tag <tag>            Optional short tag, e.g. "global", "constraint", "decision".
#   --root <path>          Repo root override.
#   --json                 (Accepted for parity; output is always JSON.)
#
# Behavior:
#   - Creates the file with a default header if missing.
#   - Appends a timestamped section.
#   - Refuses content that fails secret/PII validation via bin/validate-events.sh
#     style regexes (kept inline so we don't synthesize fake events).

set -euo pipefail

TOOL_ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ROOT="$TOOL_ROOT"
CONTENT_FILE=""
SOURCE_REF=""
TAG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --content-file) CONTENT_FILE="$2"; shift 2 ;;
    --source) SOURCE_REF="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"
USER_MEMORY="$ROOT/📂 Context/Work/.hook-state/user-memory.md"

json() {
  printf '{"status":"%s","user_memory_path":"%s","message":"%s"}\n' "$1" "${2:-}" "${3:-}"
}

[ -n "$CONTENT_FILE" ] || { json "validation_failed" "$USER_MEMORY" "missing --content-file"; exit 1; }
[ -f "$CONTENT_FILE" ] || { json "validation_failed" "$USER_MEMORY" "content file not found"; exit 1; }

bytes="$(wc -c < "$CONTENT_FILE" | tr -d '[:space:]')"
if [ "${bytes:-0}" -gt 16384 ]; then
  json "validation_failed" "$USER_MEMORY" "content exceeds 16 KiB"
  exit 1
fi
if [ "${bytes:-0}" -eq 0 ]; then
  json "validation_failed" "$USER_MEMORY" "content is empty"
  exit 1
fi

content="$(cat "$CONTENT_FILE")"

if printf '%s' "$content" | LC_ALL=C grep -q '[^[:print:][:space:]]'; then
  json "validation_failed" "$USER_MEMORY" "binary or non-printable content rejected"
  exit 1
fi

shopt -s nocasematch
if [[ "$content" =~ sk-[A-Za-z0-9_-]{20,} ]] \
  || [[ "$content" =~ ghp_[A-Za-z0-9_]{20,} ]] \
  || [[ "$content" =~ xox[baprs]-[A-Za-z0-9-]{20,} ]] \
  || [[ "$content" =~ AKIA[0-9A-Z]{16} ]] \
  || [[ "$content" =~ -----BEGIN[[:space:]][A-Z[:space:]]*PRIVATE\ KEY----- ]] \
  || [[ "$content" =~ (password|passwd|api[_-]?key|secret|token)[[:space:]]*[:=][[:space:]]*[^[:space:],}\"]+ ]]; then
  shopt -u nocasematch
  json "validation_failed" "$USER_MEMORY" "possible secret detected"
  exit 1
fi
shopt -u nocasematch

if [[ "$content" =~ \<\!-- ]] || [[ "$content" =~ ignore[[:space:]]+previous[[:space:]]+instructions ]]; then
  json "validation_failed" "$USER_MEMORY" "unsafe prompt-visible content detected"
  exit 1
fi

mkdir -p "$(dirname "$USER_MEMORY")"

if [ ! -f "$USER_MEMORY" ]; then
  cat > "$USER_MEMORY" <<'EOF'
# User Memory

Universal, cross-project notes about the operator, environment, and durable constraints.
PM OS reads this file before every response and prefers it over duplicating notes across
multiple `events.jsonl` files when an update applies to more than one active project.

EOF
fi

ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
LOCK_DIR="$USER_MEMORY.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  json "append_locked" "$USER_MEMORY" "user-memory append already in progress"
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

{
  printf '\n## %s' "$ts"
  if [ -n "$TAG" ]; then
    safe_tag="${TAG//[^A-Za-z0-9_-]/}"
    [ -n "$safe_tag" ] && printf ' — %s' "$safe_tag"
  fi
  printf '\n\n'
  printf '%s\n' "$content"
  if [ -n "$SOURCE_REF" ]; then
    printf '\n_Source: %s_\n' "$SOURCE_REF"
  fi
} >> "$USER_MEMORY"

json "ok" "$USER_MEMORY" "appended universal memory note"
