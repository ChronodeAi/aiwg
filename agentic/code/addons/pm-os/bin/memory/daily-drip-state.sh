#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")/../.." && pwd)"
ACTION=""
QUESTION_FILE=""
ANSWER_FILE=""
DESTINATION=""
REASON=""
FILED_EVENT_ID=""
SNOOZE_UNTIL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --status) ACTION="status"; shift ;;
    --ask) ACTION="ask"; shift ;;
    --answer) ACTION="answer"; shift ;;
    --filed) ACTION="filed"; shift ;;
    --skip) ACTION="skip"; shift ;;
    --snooze)
      ACTION="snooze"
      if [ "$#" -lt 2 ] || [[ "${2:-}" == --* ]]; then
        SNOOZE_UNTIL=""
        shift
      else
        SNOOZE_UNTIL="$2"
        shift 2
      fi
      ;;
    --stop) ACTION="stop"; shift ;;
    --question-file) QUESTION_FILE="$2"; shift 2 ;;
    --answer-file) ANSWER_FILE="$2"; shift 2 ;;
    --destination) DESTINATION="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --filed-event-id) FILED_EVENT_ID="$2"; shift 2 ;;
    --json) shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$ROOT" && pwd)"
STATE_DIR="$ROOT/📂 Context/Work/.hook-state"
STATE_FILE="$STATE_DIR/daily-drip.json"
mkdir -p "$STATE_DIR"

now_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

json_escape() {
  awk '
    BEGIN { ORS = "" }
    {
      if (NR > 1) printf "\\n"
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "\\") printf "\\\\"
        else if (c == "\"") printf "\\\""
        else if (c == "\t") printf "\\t"
        else printf "%s", c
      }
    }
  ' <<EOF
$1
EOF
}

state_field() {
  local field="$1"
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$STATE_FILE" | sed -n '1p'
}

state_int_field() {
  local field="$1"
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$STATE_FILE" | sed -n '1p'
}

enabled_value() {
  [ -f "$STATE_FILE" ] || { echo true; return; }
  if grep -q '"enabled"[[:space:]]*:[[:space:]]*false' "$STATE_FILE"; then
    echo false
  else
    echo true
  fi
}

write_state() {
  local enabled="$1"
  local status="$2"
  local pending_question="$3"
  local asked_at="$4"
  local answered_at="$5"
  local answer_summary="$6"
  local destination="$7"
  local filed_event_id="$8"
  local skip_reason="$9"
  local snooze_until="${10}"
  local last_filed_event_id="${11}"
  local filed_count="${12:-0}"
  local last_activity_at="${13:-}"

  tmp="$(mktemp "$STATE_DIR/.daily-drip.tmp.XXXXXX")"
  {
    printf '{'
    printf '"enabled":%s,' "$enabled"
    printf '"status":"%s",' "$status"
    if [ -n "$pending_question" ]; then printf '"pending_question":"%s",' "$(json_escape "$pending_question")"; else printf '"pending_question":null,'; fi
    if [ -n "$asked_at" ]; then printf '"asked_at":"%s",' "$asked_at"; else printf '"asked_at":null,'; fi
    if [ -n "$answered_at" ]; then printf '"answered_at":"%s",' "$answered_at"; else printf '"answered_at":null,'; fi
    if [ -n "$answer_summary" ]; then printf '"answer_summary":"%s",' "$(json_escape "$answer_summary")"; else printf '"answer_summary":null,'; fi
    if [ -n "$destination" ]; then printf '"destination":"%s",' "$destination"; else printf '"destination":null,'; fi
    if [ -n "$filed_event_id" ]; then printf '"filed_event_id":"%s",' "$filed_event_id"; else printf '"filed_event_id":null,'; fi
    if [ -n "$skip_reason" ]; then printf '"skip_reason":"%s",' "$(json_escape "$skip_reason")"; else printf '"skip_reason":null,'; fi
    if [ -n "$snooze_until" ]; then printf '"snooze_until":"%s",' "$snooze_until"; else printf '"snooze_until":null,'; fi
    if [ -n "$last_filed_event_id" ]; then printf '"last_filed_event_id":"%s",' "$last_filed_event_id"; else printf '"last_filed_event_id":null,'; fi
    printf '"filed_count":%s,' "$filed_count"
    if [ -n "$last_activity_at" ]; then printf '"last_activity_at":"%s"' "$last_activity_at"; else printf '"last_activity_at":null'; fi
    printf '}\n'
  } > "$tmp"
  mv "$tmp" "$STATE_FILE"
  cat "$STATE_FILE"
}

current_status="$(state_field status)"
[ -n "$current_status" ] || current_status="idle"
enabled="$(enabled_value)"
[ -n "$enabled" ] || enabled=true
last_filed="$(state_field last_filed_event_id)"
filed_count="$(state_int_field filed_count)"
[ -n "$filed_count" ] || filed_count=0

NOW="$(now_utc)"

case "${ACTION:-status}" in
  status)
    if [ -f "$STATE_FILE" ]; then
      cat "$STATE_FILE"
    else
      write_state true idle "" "" "" "" "" "" "" "" "" 0 "$NOW"
    fi
    ;;
  ask)
    [ "$enabled" = "true" ] || { write_state false stopped "" "" "" "" "" "" "" "" "$last_filed" "$filed_count" "$NOW"; exit 1; }
    if [ "$current_status" = "snoozed" ]; then
      cat "$STATE_FILE"
      exit 1
    fi
    if [ "$current_status" = "pending_answer" ] || [ "$current_status" = "answered_unfiled" ]; then
      cat "$STATE_FILE"
      exit 1
    fi
    [ -f "$QUESTION_FILE" ] || { echo '{"status":"error","message":"question_file_missing"}'; exit 2; }
    question="$(sed -n '1,$p' "$QUESTION_FILE")"
    [ -n "$DESTINATION" ] || DESTINATION="user_profile"
    write_state true pending_answer "$question" "$NOW" "" "" "$DESTINATION" "" "" "" "$last_filed" "$filed_count" "$NOW"
    ;;
  answer)
    if [ "$current_status" != "pending_answer" ]; then
      if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
      else
        write_state true idle "" "" "" "" "" "" "" "" "$last_filed" "$filed_count" "$NOW"
      fi
      exit 1
    fi
    [ -f "$ANSWER_FILE" ] || { echo '{"status":"error","message":"answer_file_missing"}'; exit 2; }
    write_state "$enabled" answered_unfiled "" "$(state_field asked_at)" "$NOW" "" "$(state_field destination)" "" "" "" "$last_filed" "$filed_count" "$NOW"
    ;;
  filed)
    if [ "$current_status" = "answered_unfiled" ] && [ -z "$FILED_EVENT_ID" ]; then
      cat "$STATE_FILE"
      exit 1
    fi
    [ -n "$FILED_EVENT_ID" ] || FILED_EVENT_ID="$(state_field filed_event_id)"
    new_filed_count=$((filed_count + 1))
    write_state "$enabled" idle "" "" "" "" "" "" "" "" "$FILED_EVENT_ID" "$new_filed_count" "$NOW"
    ;;
  skip)
    [ -n "$REASON" ] || REASON="skipped"
    write_state "$enabled" idle "" "" "" "" "" "" "$REASON" "" "$last_filed" "$filed_count" "$NOW"
    ;;
  snooze)
    [ -n "$SNOOZE_UNTIL" ] || { echo '{"status":"error","message":"snooze_until_missing"}'; exit 2; }
    write_state "$enabled" snoozed "" "" "" "" "" "" "" "$SNOOZE_UNTIL" "$last_filed" "$filed_count" "$NOW"
    ;;
  stop)
    write_state false stopped "" "" "" "" "" "" "" "" "$last_filed" "$filed_count" "$NOW"
    ;;
  *)
    echo "ERROR: no action provided" >&2
    exit 2
    ;;
esac
