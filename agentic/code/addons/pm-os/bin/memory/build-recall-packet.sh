#!/usr/bin/env bash
set -euo pipefail

TOOL_ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ROOT="$TOOL_ROOT"
PROJECT=""
LIMIT=5
CASCADE=auto

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --cascade)
      case "${2:-}" in
        auto|on|off) CASCADE="$2"; shift 2 ;;
        ""|--*) echo "ERROR: --cascade requires a value (auto|on|off)" >&2; exit 2 ;;
        *) echo "ERROR: --cascade value must be auto|on|off (got: $2)" >&2; exit 2 ;;
      esac
      ;;
    --no-cascade) CASCADE=off; shift ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"
WORK_DIR="$ROOT/📂 Context/Work"

json_escape() {
  sed 's/\\/\\\\/g; s/"/\\"/g' <<EOF
$1
EOF
}

field() {
  local line="$1"
  local key="$2"
  awk -v key="$key" '
    {
      pattern = "\"" key "\"[ \t]*:[ \t]*\""
      if (match($0, pattern)) {
        pos = RSTART + RLENGTH
        out = ""
        esc = 0
        for (i = pos; i <= length($0); i++) {
          c = substr($0, i, 1)
          if (esc) {
            out = out "\\" c
            esc = 0
          } else if (c == "\\") {
            esc = 1
          } else if (c == "\"") {
            print out
            exit
          } else {
            out = out c
          }
        }
      }
    }
  ' <<EOF
$line
EOF
}

bool_field() {
  local line="$1"
  local key="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\(true\\|false\\).*/\\1/p"
}

array_field_raw() {
  local line="$1"
  local key="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\[\\([^]]*\\)\\].*/\\1/p"
}

reverse_file() {
  local f="$1"
  if command -v tac >/dev/null 2>&1; then
    tac "$f"
  else
    awk '{ lines[NR] = $0 } END { for (i = NR; i >= 1; i--) print lines[i] }' "$f"
  fi
}

emit_skip() {
  printf '{"project":"","cascade_parents":[],"decisions":[],"risks":[],"open_questions":[],"constraints":[],"recent_sources":[],"source_refs":[],"memory_status":{"lookup_status":"skipped","reason":"%s","events_loaded":0,"decision_log_found":false,"cascade_loaded":[]}}\n' "$1"
}

resolve_output="$(bash "$TOOL_ROOT/bin/memory/resolve-project.sh" --root "$ROOT" ${PROJECT:+--project "$PROJECT"} --json 2>/dev/null || true)"
case "$resolve_output" in
  *'"status":"ok"'*) ;;
  *'"status":"missing_current"'*) emit_skip "missing_current"; exit 0 ;;
  *'"status":"missing_project"'*) emit_skip "missing_project"; exit 0 ;;
  *'"status":"archived_project"'*) emit_skip "archived_project"; exit 0 ;;
  *) emit_skip "invalid_target"; exit 0 ;;
esac

PROJECT="$(printf '%s\n' "$resolve_output" | sed -n 's/.*"project":"\([^"]*\)".*/\1/p')"
PROJECT_DIR="$(printf '%s\n' "$resolve_output" | sed -n 's/.*"project_path":"\([^"]*\)".*/\1/p')"
EVENTS_FILE="$PROJECT_DIR/events.jsonl"
DECISION_LOG="$PROJECT_DIR/DECISION-LOG.md"

PARENTS=()
case "$CASCADE" in
  off) : ;;
  on|auto)
    case "$PROJECT" in
      */*)
        cascade_walker="${PROJECT%/*}"
        while [ -n "$cascade_walker" ] && [ "$cascade_walker" != "$PROJECT" ]; do
          PARENTS+=("$cascade_walker")
          case "$cascade_walker" in
            */*) cascade_walker="${cascade_walker%/*}" ;;
            *) cascade_walker="" ;;
          esac
        done
        ;;
    esac
    ;;
esac

EVENT_FILES=()
if [ -f "$EVENTS_FILE" ]; then
  EVENT_FILES+=("$EVENTS_FILE")
fi

CASCADE_LOADED_JSON=""
if [ "${#PARENTS[@]}" -gt 0 ]; then
  for parent_slug in "${PARENTS[@]}"; do
    [ -n "$parent_slug" ] || continue
    parent_resolve="$(bash "$TOOL_ROOT/bin/memory/resolve-project.sh" --root "$ROOT" --project "$parent_slug" --json 2>/dev/null || true)"
    case "$parent_resolve" in
      *'"status":"ok"'*)
        parent_dir="$(printf '%s\n' "$parent_resolve" | sed -n 's/.*"project_path":"\([^"]*\)".*/\1/p')"
        parent_events="$parent_dir/events.jsonl"
        loaded="false"
        if [ -f "$parent_events" ]; then
          if bash "$TOOL_ROOT/bin/validate-events.sh" "$parent_events" >/tmp/pm-os-recall-parent.out 2>/tmp/pm-os-recall-parent.err; then
            EVENT_FILES+=("$parent_events")
            loaded="true"
          fi
        fi
        [ -z "$CASCADE_LOADED_JSON" ] || CASCADE_LOADED_JSON+=","
        CASCADE_LOADED_JSON+="$(printf '{"slug":"%s","events_loaded":%s}' "$parent_slug" "$loaded")"
        ;;
      *)
        [ -z "$CASCADE_LOADED_JSON" ] || CASCADE_LOADED_JSON+=","
        CASCADE_LOADED_JSON+="$(printf '{"slug":"%s","events_loaded":false}' "$parent_slug")"
        ;;
    esac
  done
fi

cascade_parents_json=""
if [ "${#PARENTS[@]}" -gt 0 ]; then
  for parent_slug in "${PARENTS[@]}"; do
    [ -n "$parent_slug" ] || continue
    [ -z "$cascade_parents_json" ] || cascade_parents_json+=","
    cascade_parents_json+="\"$parent_slug\""
  done
fi

if [ "${#EVENT_FILES[@]}" -eq 0 ]; then
  printf '{"project":"%s","cascade_parents":[%s],"decisions":[],"risks":[],"open_questions":[],"constraints":[],"recent_sources":[],"source_refs":[],"memory_status":{"lookup_status":"missing","events_loaded":0,"decision_log_found":%s,"cascade_loaded":[%s]}}\n' \
    "$PROJECT" "$cascade_parents_json" "$([ -f "$DECISION_LOG" ] && echo true || echo false)" "$CASCADE_LOADED_JSON"
  exit 0
fi

CHILD_INVALID=false
if [ -f "$EVENTS_FILE" ] && ! bash "$TOOL_ROOT/bin/validate-events.sh" "$EVENTS_FILE" >/tmp/pm-os-recall-validate.out 2>/tmp/pm-os-recall-validate.err; then
  CHILD_INVALID=true
  # Drop the invalid child events file but keep any validated parent files.
  new_event_files=()
  for f in "${EVENT_FILES[@]}"; do
    [ "$f" = "$EVENTS_FILE" ] || new_event_files+=("$f")
  done
  EVENT_FILES=(${new_event_files[@]+"${new_event_files[@]}"})
  if [ "${#EVENT_FILES[@]}" -eq 0 ]; then
    printf '{"project":"%s","cascade_parents":[%s],"decisions":[],"risks":[],"open_questions":[],"constraints":[],"recent_sources":[],"source_refs":[],"memory_status":{"lookup_status":"invalid","events_loaded":0,"decision_log_found":%s,"cascade_loaded":[%s]}}\n' \
      "$PROJECT" "$cascade_parents_json" "$([ -f "$DECISION_LOG" ] && echo true || echo false)" "$CASCADE_LOADED_JSON"
    exit 0
  fi
fi

event_count=0
for f in "${EVENT_FILES[@]}"; do
  c="$(wc -l < "$f" | tr -d '[:space:]')"
  event_count=$((event_count + c))
done

emit_items() {
  local type="$1"
  local f
  {
    for f in "${EVENT_FILES[@]}"; do
      reverse_file "$f"
    done
  } | {
    local emitted=0
    local first=1
    local line sensitivity redaction_status contains_personal_data
    local title summary id confidence source_refs
    while IFS= read -r line || [ -n "$line" ]; do
      [ "$(field "$line" type)" = "$type" ] || continue
      sensitivity="$(field "$line" sensitivity)"
      redaction_status="$(field "$line" redaction_status)"
      contains_personal_data="$(bool_field "$line" contains_personal_data)"
      if [ "$sensitivity" = "confidential" ] || [ "$redaction_status" = "needs_review" ] || [ "$contains_personal_data" = "true" ]; then
        continue
      fi
      if [ "$emitted" -ge "$LIMIT" ]; then
        continue
      fi
      title="$(json_escape "$(field "$line" title)")"
      summary="$(json_escape "$(field "$line" summary)")"
      id="$(json_escape "$(field "$line" id)")"
      confidence="$(json_escape "$(field "$line" confidence)")"
      source_refs="$(array_field_raw "$line" source_refs)"
      [ -n "$source_refs" ] || source_refs=""
      [ "$first" = "1" ] || printf ','
      first=0
      printf '{"id":"%s","title":"%s","summary":"%s","confidence":"%s","source_refs":[%s]}' "$id" "$title" "$summary" "$confidence" "$source_refs"
      emitted=$((emitted + 1))
    done
  }
}

decision_log_found=false
[ -f "$DECISION_LOG" ] && decision_log_found=true

printf '{"project":"%s","cascade_parents":[%s],' "$PROJECT" "$cascade_parents_json"
printf '"decisions":['
emit_items "decision"
printf '],"risks":['
emit_items "risk"
printf '],"open_questions":['
emit_items "open_question"
printf '],"constraints":['
emit_items "assumption"
printf '],"recent_sources":['
emit_items "source_added"
lookup_status="ok"
[ "$CHILD_INVALID" = "true" ] && lookup_status="partial_invalid"
printf '],"source_refs":[],"recommended_next_workflow":null,"memory_status":{"lookup_status":"%s","events_loaded":%s,"decision_log_found":%s,"cascade_loaded":[%s]}}\n' "$lookup_status" "$event_count" "$decision_log_found" "$CASCADE_LOADED_JSON"
