#!/usr/bin/env bash
set -euo pipefail

TOOL_ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ROOT="$TOOL_ROOT"
PROJECT=""
APPLY=0
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"
START_MARKER="<!-- PM-OS:DECISION-LOG:GENERATED:START -->"
END_MARKER="<!-- PM-OS:DECISION-LOG:GENERATED:END -->"

json() {
  printf '{"status":"%s","decision_log_path":"%s","message":"%s"}\n' "$1" "${2:-}" "${3:-}"
}

field() {
  local line="$1"
  local key="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

resolve_output="$(bash "$TOOL_ROOT/bin/memory/resolve-project.sh" --root "$ROOT" --project "$PROJECT" --json 2>/dev/null || true)"
case "$resolve_output" in
  *'"status":"ok"'*) ;;
  *) printf '%s\n' "$resolve_output"; exit 2 ;;
esac

PROJECT_DIR="$(printf '%s\n' "$resolve_output" | sed -n 's/.*"project_path":"\([^"]*\)".*/\1/p')"
EVENTS_FILE="$PROJECT_DIR/events.jsonl"
DECISION_LOG="$PROJECT_DIR/DECISION-LOG.md"

[ -f "$EVENTS_FILE" ] || { json "missing_events" "$DECISION_LOG" "events.jsonl is missing"; exit 1; }

if ! bash "$TOOL_ROOT/bin/validate-events.sh" "$EVENTS_FILE" >/tmp/pm-os-project-events.out 2>/tmp/pm-os-project-events.err; then
  json "corrupt_existing_log" "$DECISION_LOG" "$(tr '\n' ';' < /tmp/pm-os-project-events.err)"
  exit 1
fi

section_file="$(mktemp "$PROJECT_DIR/.decision-log-section.tmp.XXXXXX")"
tmp_file=""
trap 'rm -f "$section_file" "$tmp_file" 2>/dev/null || true' EXIT INT TERM

{
  printf '%s\n' "$START_MARKER"
  printf '\n'
  printf '## Generated From Project Memory\n\n'
  while IFS= read -r line || [ -n "$line" ]; do
    id="$(field "$line" id)"
    type="$(field "$line" type)"
    title="$(field "$line" title)"
    summary="$(field "$line" summary)"
    confidence="$(field "$line" confidence)"
    printf '### %s\n\n' "$title"
    printf '%s\n' "- Event: \`$id\`"
    printf '%s\n' "- Type: \`$type\`"
    printf '%s\n' "- Confidence: \`$confidence\`"
    printf '\n%s\n\n' "$summary"
  done < "$EVENTS_FILE"
  printf '%s\n' "$END_MARKER"
} > "$section_file"

if [ ! -f "$DECISION_LOG" ]; then
  tmp_file="$(mktemp "$PROJECT_DIR/.DECISION-LOG.tmp.XXXXXX")"
  {
    printf '# Decision Log\n\n'
    cat "$section_file"
    printf '\n'
  } > "$tmp_file"
elif ! grep -qF "$START_MARKER" "$DECISION_LOG" || ! grep -qF "$END_MARKER" "$DECISION_LOG"; then
  json "markers_missing" "$DECISION_LOG" "generated markers are missing"
  exit 5
else
  start_count="$(grep -cF "$START_MARKER" "$DECISION_LOG")"
  end_count="$(grep -cF "$END_MARKER" "$DECISION_LOG")"
  if [ "$start_count" != "1" ] || [ "$end_count" != "1" ]; then
    json "projection_marker_conflict" "$DECISION_LOG" "generated markers are duplicated or malformed"
    exit 5
  fi

  start_line="$(grep -nF "$START_MARKER" "$DECISION_LOG" | sed -n 's/:.*//p' | sed -n '1p')"
  end_line="$(grep -nF "$END_MARKER" "$DECISION_LOG" | sed -n 's/:.*//p' | sed -n '1p')"
  if [ "$start_line" -ge "$end_line" ]; then
    json "projection_marker_conflict" "$DECISION_LOG" "generated markers are reversed or malformed"
    exit 5
  fi

  tmp_file="$(mktemp "$PROJECT_DIR/.DECISION-LOG.tmp.XXXXXX")"
  awk -v start="$START_MARKER" -v end="$END_MARKER" -v section="$section_file" '
    function print_section(    line) {
      while ((getline line < section) > 0) print line
      close(section)
    }
    $0 == start { print_section(); skip = 1; next }
    $0 == end { skip = 0; next }
    skip { next }
    { print }
  ' "$DECISION_LOG" > "$tmp_file"
fi

if [ "$APPLY" = "1" ]; then
  mv "$tmp_file" "$DECISION_LOG"
  tmp_file=""
  json "ok" "$DECISION_LOG" "projection refreshed"
else
  cat "$tmp_file"
  json "dry_run" "$DECISION_LOG" "projection generated"
fi
