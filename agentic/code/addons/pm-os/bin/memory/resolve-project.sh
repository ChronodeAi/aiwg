#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
PROJECT=""
JSON=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"
WORK_DIR="$ROOT/📂 Context/Work"

json() {
  printf '{"status":"%s","project":"%s","project_path":"%s"}\n' "$1" "${2:-}" "${3:-}"
}

is_valid_segment() {
  case "$1" in
    ""|"."|".."|.*) return 1 ;;
  esac
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$ ]]
}

is_valid_slug() {
  local input="$1"
  case "$input" in
    "") return 1 ;;
    *\\*|*[\;\&\|\<\>\`\$\(\)\{\}\[\]\*\?\!\'\"]*) return 1 ;;
    *" "*|*$'\t'*) return 1 ;;
    /*|*/) return 1 ;;
    *//*) return 1 ;;
  esac
  local first_segment="${input%%/*}"
  case "$first_segment" in
    .archive|.current|.inbox|Coaching|Drills|Reviews) return 1 ;;
  esac
  local saved_ifs="$IFS"
  local IFS='/'
  local seg
  for seg in $input; do
    IFS="$saved_ifs"
    if ! is_valid_segment "$seg"; then
      return 1
    fi
    IFS='/'
  done
  IFS="$saved_ifs"
  return 0
}

if [ -z "$PROJECT" ]; then
  if [ ! -f "$WORK_DIR/.current" ]; then
    json "missing_current"
    exit 2
  fi
  PROJECT=""
  while IFS= read -r raw_line || [ -n "$raw_line" ]; do
    trimmed="${raw_line#"${raw_line%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    [ -z "$trimmed" ] && continue
    case "$trimmed" in
      \#*) continue ;;
    esac
    PROJECT="$trimmed"
    break
  done < "$WORK_DIR/.current"
fi

if ! is_valid_slug "$PROJECT"; then
  json "invalid_target" "$PROJECT"
  exit 2
fi

PROJECT_DIR="$WORK_DIR/$PROJECT"
ARCHIVE_DIR="$WORK_DIR/.archive/$PROJECT"

if [ -d "$ARCHIVE_DIR" ] && [ ! -d "$PROJECT_DIR" ]; then
  json "archived_project" "$PROJECT" "$ARCHIVE_DIR"
  exit 2
fi

if [ ! -d "$PROJECT_DIR" ]; then
  json "missing_project" "$PROJECT" "$PROJECT_DIR"
  exit 2
fi

if [ -L "$PROJECT_DIR" ]; then
  json "invalid_target" "$PROJECT" "$PROJECT_DIR"
  exit 2
fi

WORK_PHYSICAL="$(cd -P "$WORK_DIR" && pwd)"
PROJECT_PHYSICAL="$(cd -P "$PROJECT_DIR" && pwd)"

case "$PROJECT_PHYSICAL" in
  "$WORK_PHYSICAL"/*) ;;
  *) json "invalid_target" "$PROJECT" "$PROJECT_PHYSICAL"; exit 2 ;;
esac

if [ -L "$PROJECT_DIR/events.jsonl" ] || [ -L "$PROJECT_DIR/DECISION-LOG.md" ]; then
  json "invalid_target" "$PROJECT" "$PROJECT_PHYSICAL"
  exit 2
fi

json "ok" "$PROJECT" "$PROJECT_PHYSICAL"
