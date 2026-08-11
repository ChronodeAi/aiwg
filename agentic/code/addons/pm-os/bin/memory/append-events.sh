#!/usr/bin/env bash
set -euo pipefail

TOOL_ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ROOT="$TOOL_ROOT"
PROJECT=""
CANDIDATE_FILE=""
CONFIRMED_EVENT_IDS=""
PREVIEW_DIGEST=""
CONFIRMED=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --candidate-file) CANDIDATE_FILE="$2"; shift 2 ;;
    --confirmed-event-ids) CONFIRMED_EVENT_IDS="$2"; shift 2 ;;
    --preview-digest) PREVIEW_DIGEST="$2"; shift 2 ;;
    --confirm-current-preview) CONFIRMED=1; shift ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"

json() {
  printf '{"status":"%s","events_path":"%s","message":"%s"}\n' "$1" "${2:-}" "${3:-}"
}

if [ "$CONFIRMED" != "1" ] || [ -z "$CONFIRMED_EVENT_IDS" ] || [ -z "$PREVIEW_DIGEST" ]; then
  json "confirmation_required" "" "confirmed event ids and current preview confirmation are required"
  exit 4
fi

[ -f "$CANDIDATE_FILE" ] || { json "validation_failed" "" "candidate file missing"; exit 1; }

resolve_output="$(bash "$TOOL_ROOT/bin/memory/resolve-project.sh" --root "$ROOT" --project "$PROJECT" --json 2>/dev/null || true)"
case "$resolve_output" in
  *'"status":"ok"'*) ;;
  *) printf '%s\n' "$resolve_output"; exit 2 ;;
esac

PROJECT_DIR="$(printf '%s\n' "$resolve_output" | sed -n 's/.*"project_path":"\([^"]*\)".*/\1/p')"
EVENTS_FILE="$PROJECT_DIR/events.jsonl"
LOCK_DIR="$PROJECT_DIR/events.jsonl.lock"
TMP_COMBINED=""
TMP_SELECTED=""
TMP_VALIDATE_OUT=""
TMP_VALIDATE_ERR=""
LOCK_ACQUIRED=0

cleanup() {
  [ -n "$TMP_COMBINED" ] && [ -f "$TMP_COMBINED" ] && rm -f "$TMP_COMBINED"
  [ -n "$TMP_SELECTED" ] && [ -f "$TMP_SELECTED" ] && rm -f "$TMP_SELECTED"
  [ -n "$TMP_VALIDATE_OUT" ] && [ -f "$TMP_VALIDATE_OUT" ] && rm -f "$TMP_VALIDATE_OUT"
  [ -n "$TMP_VALIDATE_ERR" ] && [ -f "$TMP_VALIDATE_ERR" ] && rm -f "$TMP_VALIDATE_ERR"
  [ "$LOCK_ACQUIRED" = "1" ] && [ -d "$LOCK_DIR" ] && rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  json "append_locked" "$EVENTS_FILE" "memory append already in progress"
  exit 1
fi
LOCK_ACQUIRED=1

TMP_SELECTED="$(mktemp "$PROJECT_DIR/.candidate-events.tmp.XXXXXX")"
TMP_VALIDATE_OUT="$(mktemp "$PROJECT_DIR/.validate-events.out.XXXXXX")"
TMP_VALIDATE_ERR="$(mktemp "$PROJECT_DIR/.validate-events.err.XXXXXX")"

selected_count=0
IFS=',' read -r -a confirmed_ids <<EOF
$CONFIRMED_EVENT_IDS
EOF

while IFS= read -r line || [ -n "$line" ]; do
  event_id="$(printf '%s\n' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  include=0
  for confirmed_id in "${confirmed_ids[@]}"; do
    confirmed_id="${confirmed_id#"${confirmed_id%%[![:space:]]*}"}"
    confirmed_id="${confirmed_id%"${confirmed_id##*[![:space:]]}"}"
    if [ "$event_id" = "$confirmed_id" ]; then
      include=1
      selected_count=$((selected_count + 1))
      break
    fi
  done
  [ "$include" = "1" ] && printf '%s\n' "$line" >> "$TMP_SELECTED"
done < "$CANDIDATE_FILE"

for confirmed_id in "${confirmed_ids[@]}"; do
  confirmed_id="${confirmed_id#"${confirmed_id%%[![:space:]]*}"}"
  confirmed_id="${confirmed_id%"${confirmed_id##*[![:space:]]}"}"
  if ! grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$confirmed_id\"" "$TMP_SELECTED"; then
    json "validation_failed" "$EVENTS_FILE" "confirmed event id not found: $confirmed_id"
    exit 1
  fi
done

if [ "$selected_count" -eq 0 ]; then
  json "confirmation_required" "$EVENTS_FILE" "no confirmed candidate events selected"
  exit 4
fi

if [ -f "$EVENTS_FILE" ]; then
  if ! bash "$TOOL_ROOT/bin/validate-events.sh" "$EVENTS_FILE" >"$TMP_VALIDATE_OUT" 2>"$TMP_VALIDATE_ERR"; then
    json "corrupt_existing_log" "$EVENTS_FILE" "$(tr '\n' ';' < "$TMP_VALIDATE_ERR")"
    exit 1
  fi
fi

if ! bash "$TOOL_ROOT/bin/validate-events.sh" "$TMP_SELECTED" >"$TMP_VALIDATE_OUT" 2>"$TMP_VALIDATE_ERR"; then
  json "validation_failed" "$EVENTS_FILE" "$(tr '\n' ';' < "$TMP_VALIDATE_ERR")"
  exit 1
fi

if grep -q '^WARNING:' "$TMP_VALIDATE_ERR"; then
  json "sensitive_confirmation_required" "$EVENTS_FILE" "$(tr '\n' ';' < "$TMP_VALIDATE_ERR")"
  exit 1
fi

TMP_COMBINED="$(mktemp "$PROJECT_DIR/.events.jsonl.tmp.XXXXXX")"
umask 077

if [ -f "$EVENTS_FILE" ]; then
  cat "$EVENTS_FILE" "$TMP_SELECTED" > "$TMP_COMBINED"
else
  cp "$TMP_SELECTED" "$TMP_COMBINED"
fi

if ! bash "$TOOL_ROOT/bin/validate-events.sh" "$TMP_COMBINED" >"$TMP_VALIDATE_OUT" 2>"$TMP_VALIDATE_ERR"; then
  json "validation_failed" "$EVENTS_FILE" "$(tr '\n' ';' < "$TMP_VALIDATE_ERR")"
  exit 1
fi

mv "$TMP_COMBINED" "$EVENTS_FILE"
TMP_COMBINED=""

json "ok" "$EVENTS_FILE" "appended confirmed events"
