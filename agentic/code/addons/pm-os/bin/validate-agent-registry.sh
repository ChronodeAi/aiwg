#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="registry/agents.json"
ERRORS=()

add_error() {
  ERRORS+=("$*")
}

json_field() {
  local line="$1"
  local field="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

json_bool() {
  local line="$1"
  local field="$2"
  if printf '%s\n' "$line" | grep -q "\"$field\"[[:space:]]*:[[:space:]]*true"; then
    echo true
  elif printf '%s\n' "$line" | grep -q "\"$field\"[[:space:]]*:[[:space:]]*false"; then
    echo false
  fi
}

registry_entries() {
  local path="$1"
  awk '
    /{/ { in_obj = 1; obj = "" }
    in_obj { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); obj = obj " " $0 }
    /}/ && in_obj { print obj; in_obj = 0 }
  ' "$path"
}

frontmatter_field() {
  local file="$1"
  local field="$2"
  awk -v field="$field" '
    NR == 1 && $0 == "---" { in_fm = 1; next }
    in_fm && $0 == "---" { exit }
    in_fm && index($0, field ":") == 1 {
      value = substr($0, length(field) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$file"
}

validate_agent_file() {
  local agent_id="$1"
  local file="$2"
  local canonical="$3"
  [ -f "$file" ] || { add_error "$agent_id missing file: $file"; return; }
  actual_name="$(frontmatter_field "$file" name)"
  [ "$actual_name" = "$agent_id" ] || add_error "$file name should be $agent_id, got $actual_name"
  desc="$(frontmatter_field "$file" description)"
  [ -n "$desc" ] || add_error "$file missing description"
  grep -q "## Contract" "$file" || add_error "$file missing ## Contract"
  grep -q "STATUS: done | partial | blocked" "$file" || add_error "$file missing STATUS output contract"
  if [ -n "$canonical" ] && [ "$file" != "$canonical" ]; then
    grep -q "Canonical source: $canonical" "$file" || add_error "$file missing canonical-source comment"
  fi
}

[ -f "$REGISTRY" ] || { echo "ERROR: missing $REGISTRY" >&2; exit 1; }

seen="$(mktemp)"
trap 'rm -f "$seen"' EXIT
count=0

while IFS= read -r entry; do
  agent_id="$(json_field "$entry" agent_id)"
  canonical="$(json_field "$entry" canonical_file)"
  cursor="$(json_field "$entry" cursor_file)"
  claude="$(json_field "$entry" claude_file)"
  readonly="$(json_bool "$entry" readonly)"
  writes_allowed="$(json_bool "$entry" writes_allowed)"
  status="$(json_field "$entry" status)"
  count=$((count + 1))

  [ -n "$agent_id" ] || add_error "agent entry missing agent_id: $entry"
  [ -n "$canonical" ] || add_error "$agent_id missing canonical_file"
  [ -n "$cursor" ] || add_error "$agent_id missing cursor_file"
  [ -n "$claude" ] || add_error "$agent_id missing claude_file"
  [ -n "$readonly" ] || add_error "$agent_id missing readonly"
  [ -n "$writes_allowed" ] || add_error "$agent_id missing writes_allowed"
  case "$status" in active|candidate|deferred|retired) ;; *) add_error "$agent_id invalid status: $status" ;; esac
  if grep -qxF "$agent_id" "$seen"; then
    add_error "duplicate agent_id: $agent_id"
  fi
  printf '%s\n' "$agent_id" >> "$seen"

  [ "$status" = "active" ] || continue
  # Only the canonical file is checked. In the Claude-stack canonical
  # layout (v2.1+), there is one source under agents/;
  # cursor_file and claude_file are distribution-time targets produced
  # by bin/build-cursor-zip.sh / bin/build-claude-code-zip.sh and do
  # not exist in the dev tree. The registry retains those fields as
  # documentation of where each agent lands per distribution.
  validate_agent_file "$agent_id" "$canonical" ""
done < <(registry_entries "$REGISTRY")

if [ "${#ERRORS[@]}" -gt 0 ]; then
  echo "ERROR: agent registry validation failed" >&2
  for error in "${ERRORS[@]}"; do
    echo "- $error" >&2
  done
  exit 1
fi

echo "OK: $count agents validated"
