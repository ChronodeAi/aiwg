#!/usr/bin/env bash
# list-active-projects.sh
#
# Read 📂 Context/Work/.current and emit every active project the file lists.
# Each non-blank, non-comment trimmed line is treated as a project slug.
#
# Output (JSON): {"status":"ok","count":N,"projects":[{"slug":"a","project_path":"…","status":"ok"}, …]}
#
# Status values per entry mirror resolve-project.sh: ok, missing_project, archived_project,
# invalid_target. Overall status is "ok" if at least one entry is ok, "missing_current"
# when .current is absent, "empty" when .current has no usable lines, "all_invalid" when
# every entry failed to resolve, or "partial" when some entries resolved and others did not.

set -euo pipefail

TOOL_ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ROOT="$TOOL_ROOT"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"
WORK_DIR="$ROOT/📂 Context/Work"
CURRENT_FILE="$WORK_DIR/.current"

emit() {
  printf '{"status":"%s","count":%s,"projects":[%s]}\n' "$1" "$2" "$3"
}

if [ ! -f "$CURRENT_FILE" ]; then
  emit "missing_current" "0" ""
  exit 0
fi

entries=""
ok_count=0
err_count=0
total=0
seen=$'\n'

while IFS= read -r raw_line || [ -n "$raw_line" ]; do
  line="${raw_line#"${raw_line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  case "$line" in
    \#*) continue ;;
  esac
  if [[ "$seen" == *$'\n'"$line"$'\n'* ]]; then
    continue
  fi
  seen+="$line"$'\n'
  total=$((total + 1))

  resolve_out="$(bash "$TOOL_ROOT/bin/memory/resolve-project.sh" --root "$ROOT" --project "$line" --json 2>/dev/null || true)"
  entry_status="$(printf '%s\n' "$resolve_out" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  entry_path="$(printf '%s\n' "$resolve_out" | sed -n 's/.*"project_path":"\([^"]*\)".*/\1/p')"
  [ -n "$entry_status" ] || entry_status="invalid_target"

  case "$entry_status" in
    ok) ok_count=$((ok_count + 1)) ;;
    *) err_count=$((err_count + 1)) ;;
  esac

  [ -z "$entries" ] || entries+=","
  entries+="$(printf '{"slug":"%s","project_path":"%s","status":"%s"}' "$line" "$entry_path" "$entry_status")"
done < "$CURRENT_FILE"

if [ "$total" -eq 0 ]; then
  emit "empty" "0" ""
  exit 0
fi

overall="partial"
if [ "$err_count" -eq 0 ]; then
  overall="ok"
elif [ "$ok_count" -eq 0 ]; then
  overall="all_invalid"
fi

emit "$overall" "$total" "$entries"
