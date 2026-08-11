#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMMANDS="registry/commands.json"
WORKFLOWS="registry/workflows.json"
OUTPUT="registry/CAPABILITIES.md"
CHECK=0

if [ "${1:-}" = "--check" ]; then
  CHECK=1
fi

json_field() {
  local line="$1"
  local field="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

json_bool() {
  local line="$1"
  local field="$2"
  if printf '%s\n' "$line" | grep -q "\"$field\"[[:space:]]*:[[:space:]]*true"; then
    printf 'true\n'
  elif printf '%s\n' "$line" | grep -q "\"$field\"[[:space:]]*:[[:space:]]*false"; then
    printf 'false\n'
  fi
}

registry_entries() {
  local path="$1"
  awk '
    /{/ { in_obj = 1; obj = "" }
    in_obj {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      obj = obj " " $0
    }
    /}/ && in_obj {
      print obj
      in_obj = 0
    }
  ' "$path"
}

[ -f "$COMMANDS" ] || { echo "ERROR: missing $COMMANDS" >&2; exit 1; }
[ -f "$WORKFLOWS" ] || { echo "ERROR: missing $WORKFLOWS" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  printf '# PM OS Capability Inventory\n\n'
  printf 'Generated from:\n\n'
  printf -- '- `%s`\n' "$COMMANDS"
  printf -- '- `%s`\n\n' "$WORKFLOWS"
  printf 'Do not edit command/workflow facts here by hand. Update the registries, then run:\n\n'
  printf '```bash\nbash bin/generate-capability-inventory.sh\n```\n\n'

  printf '## Command Surfaces\n\n'
  printf '| Command | Type | Owner | Cursor | Claude | Writes | Confirmation | Memory | Setup |\n'
  printf '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'

  while IFS= read -r entry; do
    slug="$(json_field "$entry" slug)"
    type="$(json_field "$entry" type)"
    owner="$(json_field "$entry" owner_plugin)"
    cursor_stub="$(json_field "$entry" cursor_stub)"
    claude_slug="$(json_field "$entry" claude_slug)"
    writes="$(json_bool "$entry" writes_files)"
    confirmation="$(json_bool "$entry" requires_confirmation)"
    memory="$(json_field "$entry" uses_memory)"
    setup="$(json_bool "$entry" setup_required)"
    printf '| /%s | %s | %s | `%s` | Claude: `/%s` | `%s` | Requires confirmation: `%s` | Memory: `%s` | `%s` |\n' \
      "$slug" "$type" "$owner" "$cursor_stub" "$claude_slug" "$writes" "$confirmation" "$memory" "$setup"
  done < <(registry_entries "$COMMANDS")

  printf '\n## Workflow Contracts\n\n'
  printf '| Workflow | Command | File | Output | Memory preflight | Checkpoint | Skills | Subagents |\n'
  printf '| --- | --- | --- | --- | --- | --- | --- | --- |\n'

  while IFS= read -r entry; do
    workflow_id="$(json_field "$entry" workflow_id)"
    command="$(json_field "$entry" command)"
    canonical="$(json_field "$entry" canonical_file)"
    output="$(json_field "$entry" output_destination)"
    memory="$(json_field "$entry" memory_preflight)"
    checkpoint="$(json_field "$entry" checkpoint_policy)"
    skill_count="$(printf '%s\n' "$entry" | tr ',' '\n' | grep -c 'skills/' || true)"
    subagent_count="$(printf '%s\n' "$entry" | sed -n 's/.*"subagents"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | grep -c '"' || true)"
    printf '| %s | /%s | `%s` | Output: `%s` | `%s` | Checkpoint: `%s` | %s | %s |\n' \
      "$workflow_id" "$command" "$canonical" "$output" "$memory" "$checkpoint" "$skill_count" "$subagent_count"
  done < <(registry_entries "$WORKFLOWS")
} > "$tmp"

if [ "$CHECK" = "1" ]; then
  if [ ! -f "$OUTPUT" ]; then
    echo "ERROR: $OUTPUT is missing" >&2
    exit 1
  fi
  if ! cmp -s "$tmp" "$OUTPUT"; then
    echo "ERROR: $OUTPUT is stale. Run: bash bin/generate-capability-inventory.sh" >&2
    exit 1
  fi
  echo "OK: capability inventory is current"
else
  mv "$tmp" "$OUTPUT"
  trap - EXIT
  echo "OK: wrote $OUTPUT"
fi
