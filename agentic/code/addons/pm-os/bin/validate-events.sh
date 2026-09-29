#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: bin/validate-events.sh <events.jsonl>" >&2
  exit 2
fi

EVENTS_FILE="$1"

if [ ! -f "$EVENTS_FILE" ]; then
  echo "ERROR: $EVENTS_FILE does not exist" >&2
  exit 1
fi

shopt -s nocasematch

ERRORS=()
WARNINGS=()
SEEN_IDS=$'\n'
LINE_COUNT=0
REQUIRED_FIELDS=(id ts project type source title summary confidence)

add_error() {
  ERRORS+=("$*")
}

add_warning() {
  WARNINGS+=("$*")
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

string_field() {
  local line="$1"
  local field="$2"
  local regex="\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""

  if [[ "$line" =~ $regex ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  fi
}

has_field() {
  local line="$1"
  local field="$2"
  local regex="\"$field\"[[:space:]]*:"

  [[ "$line" =~ $regex ]]
}

is_allowed_type() {
  case "$1" in
    observation|decision|assumption|risk|open_question|source_added|todo|recommendation_changed|artifact_delta) return 0 ;;
    *) return 1 ;;
  esac
}

is_allowed_confidence() {
  case "$1" in
    low|medium|high) return 0 ;;
    *) return 1 ;;
  esac
}

looks_like_timestamp() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(Z|[+-][0-9]{2}:[0-9]{2})$ ]]
}

json_subset_is_valid() {
  awk '
    function skip_ws() {
      while (pos <= len && substr(s, pos, 1) ~ /[ \t\r\n]/) pos++
    }

    function parse_string(    c, esc, hex) {
      if (substr(s, pos, 1) != "\"") return 0
      pos++
      esc = 0
      while (pos <= len) {
        c = substr(s, pos, 1)
        if (esc) {
          if (c == "u") {
            hex = substr(s, pos + 1, 4)
            if (hex !~ /^[0-9A-Fa-f]{4}$/) return 0
            pos += 5
          } else if (c ~ /^["\\\/bfnrt]$/) {
            pos++
          } else {
            return 0
          }
          esc = 0
        } else if (c == "\\") {
          esc = 1
          pos++
        } else if (c == "\"") {
          pos++
          return 1
        } else {
          pos++
        }
      }
      return 0
    }

    function parse_literal(lit) {
      if (substr(s, pos, length(lit)) == lit) {
        pos += length(lit)
        return 1
      }
      return 0
    }

    function parse_array() {
      if (substr(s, pos, 1) != "[") return 0
      pos++
      skip_ws()
      if (substr(s, pos, 1) == "]") {
        pos++
        return 1
      }
      while (1) {
        skip_ws()
        if (!parse_string()) return 0
        skip_ws()
        if (substr(s, pos, 1) == "]") {
          pos++
          return 1
        }
        if (substr(s, pos, 1) != ",") return 0
        pos++
      }
    }

    function parse_value() {
      skip_ws()
      if (substr(s, pos, 1) == "\"") return parse_string()
      if (substr(s, pos, 1) == "[") return parse_array()
      if (parse_literal("true")) return 1
      if (parse_literal("false")) return 1
      if (parse_literal("null")) return 1
      return 0
    }

    function parse_object() {
      skip_ws()
      if (substr(s, pos, 1) != "{") return 0
      pos++
      skip_ws()
      if (substr(s, pos, 1) == "}") {
        pos++
        skip_ws()
        return pos > len
      }
      while (1) {
        skip_ws()
        if (!parse_string()) return 0
        skip_ws()
        if (substr(s, pos, 1) != ":") return 0
        pos++
        if (!parse_value()) return 0
        skip_ws()
        if (substr(s, pos, 1) == "}") {
          pos++
          skip_ws()
          return pos > len
        }
        if (substr(s, pos, 1) != ",") return 0
        pos++
      }
    }

    {
      s = $0
      len = length(s)
      pos = 1
      if (parse_object()) exit 0
      exit 1
    }
  ' <<EOF
$1
EOF
}

while IFS= read -r raw_line || [ -n "$raw_line" ]; do
  LINE_COUNT=$((LINE_COUNT + 1))
  line="$(trim "$raw_line")"

  if [ -z "$line" ]; then
    add_error "line $LINE_COUNT: blank lines are not allowed"
    continue
  fi

  if [[ "$line" != \{*\} ]]; then
    add_error "line $LINE_COUNT: event must be a single-line JSON object"
    continue
  fi

  if ! json_subset_is_valid "$line"; then
    add_error "line $LINE_COUNT: invalid JSON for supported event subset"
    continue
  fi

  for field in "${REQUIRED_FIELDS[@]}"; do
    if ! has_field "$line" "$field"; then
      add_error "line $LINE_COUNT: missing required field: $field"
    fi
  done

  event_id="$(string_field "$line" id)"
  if [ -z "$event_id" ]; then
    add_error "line $LINE_COUNT: id must be a non-empty string"
  elif [[ "$SEEN_IDS" == *$'\n'"$event_id"$'\n'* ]]; then
    add_error "line $LINE_COUNT: duplicate id: $event_id"
  else
    SEEN_IDS+="$event_id"$'\n'
  fi

  if [ -n "$event_id" ] && [[ "$event_id" != evt_* ]]; then
    add_warning "line $LINE_COUNT: id should use evt_ prefix: $event_id"
  fi

  timestamp="$(string_field "$line" ts)"
  if [ -z "$timestamp" ] || ! looks_like_timestamp "$timestamp"; then
    add_error "line $LINE_COUNT: invalid ts: timestamp must look like 2026-05-09T03:43:00Z"
  fi

  event_type="$(string_field "$line" type)"
  if ! is_allowed_type "$event_type"; then
    add_error "line $LINE_COUNT: unsupported type: $event_type"
  fi

  confidence="$(string_field "$line" confidence)"
  if ! is_allowed_confidence "$confidence"; then
    add_error "line $LINE_COUNT: unsupported confidence: $confidence"
  fi

  lifecycle_status="$(string_field "$line" lifecycle_status)"
  if [ -n "$lifecycle_status" ]; then
    case "$lifecycle_status" in
      candidate|accepted|superseded|rejected|promoted) ;;
      *) add_error "line $LINE_COUNT: unsupported lifecycle_status: $lifecycle_status" ;;
    esac
  fi

  visibility="$(string_field "$line" visibility)"
  if [ -n "$visibility" ]; then
    case "$visibility" in
      local_only|shareable_internal|public_safe) ;;
      *) add_error "line $LINE_COUNT: unsupported visibility: $visibility" ;;
    esac
  fi

  sensitivity="$(string_field "$line" sensitivity)"
  if [ -n "$sensitivity" ]; then
    case "$sensitivity" in
      public|internal|confidential) ;;
      *) add_error "line $LINE_COUNT: unsupported sensitivity: $sensitivity" ;;
    esac
  fi

  redaction_status="$(string_field "$line" redaction_status)"
  if [ -n "$redaction_status" ]; then
    case "$redaction_status" in
      not_needed|redacted|needs_review) ;;
      *) add_error "line $LINE_COUNT: unsupported redaction_status: $redaction_status" ;;
    esac
  fi

  source_digest="$(string_field "$line" source_digest)"
  if [ -n "$source_digest" ] && [[ ! "$source_digest" =~ ^sha256:[0-9A-Fa-f]{64}$ ]]; then
    add_error "line $LINE_COUNT: source_digest must look like sha256:<64 hex characters>"
  fi

  for field in project source title summary; do
    value="$(string_field "$line" "$field")"
    if [ -z "$value" ]; then
      add_error "line $LINE_COUNT: $field must be a non-empty string"
    fi
  done

  if [[ "$line" =~ sk-[A-Za-z0-9_-]{20,} ]] \
    || [[ "$line" =~ ghp_[A-Za-z0-9_]{20,} ]] \
    || [[ "$line" =~ xox[baprs]-[A-Za-z0-9-]{20,} ]] \
    || [[ "$line" =~ AKIA[0-9A-Z]{16} ]] \
    || [[ "$line" == *"-----BEGIN "*PRIVATE\ KEY-----* ]] \
    || [[ "$line" =~ \"(password|passwd|api[_-]?key|secret|token)\"[[:space:]]*: ]] \
    || [[ "$line" =~ (password|passwd|api[_-]?key|secret|token)[[:space:]]*[:=][[:space:]]*[^[:space:],}\"]+ ]]; then
    add_error "line $LINE_COUNT: possible secret detected"
  fi

  if [[ "$line" =~ ignore[[:space:]]+previous[[:space:]]+instructions ]] \
    || [[ "$line" =~ PM-OS:DECISION-LOG:GENERATED ]] \
    || [[ "$line" =~ javascript:|data:|file: ]] \
    || [[ "$line" =~ \<\!--|--\> ]]; then
    add_error "line $LINE_COUNT: unsafe prompt-visible content detected"
  fi

  if [[ "$line" =~ [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,} ]]; then
    add_warning "line $LINE_COUNT: possible email present; review before sharing"
  fi

  if [[ "$line" =~ (\+?[0-9]{1,3}[[:space:].-]?)?(\(?[0-9]{3}\)?[[:space:].-]?)?[0-9]{3}[[:space:].-]?[0-9]{4} ]]; then
    add_warning "line $LINE_COUNT: possible phone present; review before sharing"
  fi

  if [[ "$line" =~ confidential|do[[:space:]]+not[[:space:]]+share|internal[[:space:]]+only ]]; then
    add_warning "line $LINE_COUNT: possible confidential-label present; review before sharing"
  fi
done < "$EVENTS_FILE"

if [ "${#ERRORS[@]}" -gt 0 ]; then
  for error in "${ERRORS[@]}"; do
    echo "ERROR: $error" >&2
  done
  if [ "${#WARNINGS[@]}" -gt 0 ]; then
    for warning in "${WARNINGS[@]}"; do
      echo "WARNING: $warning" >&2
    done
  fi
  exit 1
fi

if [ "${#WARNINGS[@]}" -gt 0 ]; then
  for warning in "${WARNINGS[@]}"; do
    echo "WARNING: $warning" >&2
  done
fi

echo "OK: $EVENTS_FILE ($LINE_COUNT events)"
