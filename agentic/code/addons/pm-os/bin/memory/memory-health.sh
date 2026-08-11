#!/usr/bin/env bash
set -euo pipefail

TOOL_ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ROOT="$TOOL_ROOT"
PROJECT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"

resolve_output="$(bash "$TOOL_ROOT/bin/memory/resolve-project.sh" --root "$ROOT" ${PROJECT:+--project "$PROJECT"} --json 2>/dev/null || true)"
case "$resolve_output" in
  *'"status":"ok"'*) ;;
  *) printf '%s\n' "$resolve_output"; exit 2 ;;
esac

PROJECT="$(printf '%s\n' "$resolve_output" | sed -n 's/.*"project":"\([^"]*\)".*/\1/p')"
PROJECT_DIR="$(printf '%s\n' "$resolve_output" | sed -n 's/.*"project_path":"\([^"]*\)".*/\1/p')"
EVENTS_FILE="$PROJECT_DIR/events.jsonl"
DECISION_LOG="$PROJECT_DIR/DECISION-LOG.md"
event_count=0
latest_ts=""
event_status="missing"
projection_status="missing"

if [ -f "$EVENTS_FILE" ]; then
  if bash "$TOOL_ROOT/bin/validate-events.sh" "$EVENTS_FILE" >/tmp/pm-os-health-events.out 2>/tmp/pm-os-health-events.err; then
    event_status="ok"
    event_count="$(wc -l < "$EVENTS_FILE" | tr -d '[:space:]')"
    latest_ts="$(sed -n 's/.*"ts"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EVENTS_FILE" | tail -1)"
  else
    event_status="invalid"
  fi
fi

if [ -f "$DECISION_LOG" ]; then
  if grep -q 'PM-OS:DECISION-LOG:GENERATED:START' "$DECISION_LOG" && grep -q 'PM-OS:DECISION-LOG:GENERATED:END' "$DECISION_LOG"; then
    projection_status="fresh"
  else
    projection_status="invalid_markers"
  fi
fi

printf '{"status":"%s","project":"%s","events_path":"%s","event_count":%s,"latest_ts":"%s","projection":{"path":"%s","status":"%s"},"warnings":[]}\n' \
  "$event_status" "$PROJECT" "$EVENTS_FILE" "$event_count" "$latest_ts" "$DECISION_LOG" "$projection_status"
