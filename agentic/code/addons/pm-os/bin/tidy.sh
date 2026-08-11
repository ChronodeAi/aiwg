#!/usr/bin/env bash
# bin/tidy.sh — Fast file scanner for the /tidy skill
#
# Reads tidy.json state, finds modified .md files in 📂 Context/Work/, detects
# orphans (files at Work/ root or in legacy type-based folders), and outputs a
# structured JSON report the skill can consume.
#
# Usage: bash bin/tidy.sh
# Output: JSON report to stdout

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

STATE_FILE="📂 Context/Work/.hook-state/tidy.json"
WORK_DIR="📂 Context/Work"

mkdir -p "📂 Context/Work/.hook-state"

if [ ! -d "$WORK_DIR" ]; then
  printf '{"error": "📂 Context/Work/ directory not found", "modified_files": [], "orphans": [], "total": 0}\n'
  exit 0
fi

LAST_RUN=""
if [ -f "$STATE_FILE" ]; then
  LAST_RUN="$(sed -n 's/.*"lastRunAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE_FILE" | sed -n '1p')"
fi

if [ -n "$LAST_RUN" ] && [ -f "$STATE_FILE" ]; then
  MODIFIED_FILES=$(find "$WORK_DIR" -name "*.md" -newer "$STATE_FILE" -type f 2>/dev/null | sort)
  MODE="incremental"
else
  MODIFIED_FILES=$(find "$WORK_DIR" -name "*.md" -type f 2>/dev/null | sort)
  LAST_RUN="never"
  MODE="full"
fi

# Orphans: Work/ root + legacy type folders (excluding Reviews, which is a valid fallback)
ORPHAN_FILES=$(find "$WORK_DIR" -maxdepth 1 -name "*.md" -type f 2>/dev/null | sort)
for dir in PRDs Research Decisions Strategy Measurements; do
  if [ -d "$WORK_DIR/$dir" ]; then
    ORPHAN_FILES="$ORPHAN_FILES
$(find "$WORK_DIR/$dir" -name "*.md" -type f 2>/dev/null | sort)"
  fi
done

# Escape a raw string for safe embedding in a JSON string value (a file path may
# contain `"` or `\`, which are legal on disk but break unescaped JSON).
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  printf '%s' "$s"
}

json_encode_file() {
  local filepath="$1"
  local mod_date dirname
  # GNU stat first (-c), then BSD stat (-f). Ordering matters: the BSD form run
  # against GNU stat on Linux does NOT fail cleanly — it emits filesystem info
  # with embedded control characters, which broke the JSON. Normalize to a bare
  # date and strip any stray control chars defensively.
  mod_date=$(stat -c '%y' "$filepath" 2>/dev/null || stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' "$filepath" 2>/dev/null || echo 'unknown')
  mod_date=$(printf '%s' "$mod_date" | cut -d'.' -f1 | tr -d '\000-\037')
  dirname=$(dirname "$filepath" | sed "s|^${WORK_DIR}/||")
  [ "$dirname" = "$WORK_DIR" ] && dirname="root"
  printf '{"path":"%s","modified":"%s","category":"%s"}' "$(json_escape "$filepath")" "$(json_escape "$mod_date")" "$(json_escape "$dirname")"
}

build_list() {
  local list="$1"
  local out="["
  local first=1
  while IFS= read -r filepath; do
    [ -z "$filepath" ] && continue
    [ "$first" = "1" ] && first=0 || out="${out},"
    out="${out}$(json_encode_file "$filepath")"
  done <<< "$list"
  out="${out}]"
  echo "$out"
}

MODIFIED_JSON=$(build_list "$MODIFIED_FILES")
ORPHANS_JSON=$(build_list "$ORPHAN_FILES")

count_nonempty_lines() {
  printf '%s\n' "$1" | awk 'NF{n++} END{print n+0}'
}
MODIFIED_COUNT=$(count_nonempty_lines "$MODIFIED_FILES")
ORPHAN_COUNT=$(count_nonempty_lines "$ORPHAN_FILES")

# ---------------------------------------------------------------------------
# Drift: Context-namespace .md files the canonical-save-guard engine would
# relocate (issue #35). Each entry carries the engine's proposed canonical
# target so the /tidy skill can offer a confirmed move. Also flag the stray
# non-emoji `Context/` twin directory if present.
# ---------------------------------------------------------------------------
ENGINE="$PROJECT_ROOT/bin/memory/relocate-into-canonical.sh"
DRIFT_JSON="[]"
DRIFT_COUNT=0
STRAY_CONTEXT="false"
if [ -f "$ENGINE" ]; then
  DRIFT_CANDIDATES=$(find "$WORK_DIR" -name "*.md" -type f 2>/dev/null | sort)
  if [ -d "Context" ]; then
    STRAY_CONTEXT="true"
    DRIFT_CANDIDATES="$DRIFT_CANDIDATES
$(find "Context" -name "*.md" -type f 2>/dev/null | sort)"
  fi
  drift_out="["
  dfirst=1
  while IFS= read -r dcand; do
    [ -z "$dcand" ] && continue
    eo=$(bash "$ENGINE" --root "$PROJECT_ROOT" --path "$dcand" --detect --json 2>/dev/null || true)
    case "$eo" in
      *'"status":"would_relocate"'*) ;;
      *) continue ;;
    esac
    # dto/dbr come from the engine's already-escaped JSON, so they re-emit safely.
    # dcand is a raw path from `find` and must be escaped here.
    dto=$(printf '%s' "$eo" | sed -n 's/.*"to":"\(.*\)","reason".*/\1/p')
    dbr=$(printf '%s' "$eo" | sed -n 's/.*"branch":"\([^"]*\)".*/\1/p')
    [ "$dfirst" = "1" ] && dfirst=0 || drift_out="${drift_out},"
    drift_out="${drift_out}$(printf '{"path":"%s","target":"%s","branch":"%s"}' "$(json_escape "$dcand")" "$dto" "$dbr")"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
  done <<< "$DRIFT_CANDIDATES"
  drift_out="${drift_out}]"
  DRIFT_JSON="$drift_out"
fi

# Current project slug (if any)
CURRENT_PROJECT=""
if [ -f "$WORK_DIR/.current" ]; then
  IFS= read -r CURRENT_PROJECT < "$WORK_DIR/.current" || CURRENT_PROJECT=""
  CURRENT_PROJECT="${CURRENT_PROJECT//[[:space:]]/}"
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat <<REPORT
{
  "scan_time": "$NOW",
  "last_run": "$LAST_RUN",
  "mode": "$MODE",
  "current_project": "$CURRENT_PROJECT",
  "total_modified": $MODIFIED_COUNT,
  "total_orphans": $ORPHAN_COUNT,
  "total_drift": $DRIFT_COUNT,
  "stray_context_dir": $STRAY_CONTEXT,
  "modified_files": $MODIFIED_JSON,
  "orphans": $ORPHANS_JSON,
  "drift": $DRIFT_JSON
}
REPORT
