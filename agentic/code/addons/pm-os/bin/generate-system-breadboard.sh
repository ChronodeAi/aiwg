#!/usr/bin/env bash
# generate-system-breadboard.sh — regenerate _internal/SYSTEM-BREADBOARD.md
# from the canonical pm-os registry (registry/*.json, .mcp.json,
# hooks.json, plugin.json, marketplace.json).
#
# The hand-edited block between <!-- BEGIN HAND-EDITED --> and
# <!-- END HAND-EDITED --> is preserved across regenerations; everything else
# is overwritten.
#
# Usage:
#   bash bin/generate-system-breadboard.sh           # regenerate the file
#   bash bin/generate-system-breadboard.sh --check   # exit non-zero on drift
#
# Optional environment overrides (used by tests):
#   BREADBOARD_ROOT          override the resolved repo root
#   BREADBOARD_OUTPUT        override the output file path
#   BREADBOARD_COMMANDS, BREADBOARD_WORKFLOWS, BREADBOARD_SKILLS,
#   BREADBOARD_AGENTS, BREADBOARD_MCP, BREADBOARD_HOOKS,
#   BREADBOARD_PLUGIN_MANIFEST, BREADBOARD_MARKETPLACE
#     override individual input paths

set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${BREADBOARD_ROOT:-$ROOT_DEFAULT}"
cd "$ROOT"

OUTPUT="${BREADBOARD_OUTPUT:-_internal/SYSTEM-BREADBOARD.md}"
COMMANDS="${BREADBOARD_COMMANDS:-registry/commands.json}"
WORKFLOWS="${BREADBOARD_WORKFLOWS:-registry/workflows.json}"
SKILLS="${BREADBOARD_SKILLS:-registry/skills.json}"
AGENTS="${BREADBOARD_AGENTS:-registry/agents.json}"
MCP_CONFIG="${BREADBOARD_MCP:-.mcp.json}"
HOOKS_CONFIG="${BREADBOARD_HOOKS:-hooks/hooks.json}"
PLUGIN_MANIFEST="${BREADBOARD_PLUGIN_MANIFEST:-.claude-plugin/plugin.json}"
MARKETPLACE="${BREADBOARD_MARKETPLACE:-.claude-plugin/marketplace.json}"

CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
fi

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------
for f in "$COMMANDS" "$WORKFLOWS" "$SKILLS" "$AGENTS" "$MCP_CONFIG" "$HOOKS_CONFIG" "$PLUGIN_MANIFEST" "$MARKETPLACE"; do
  [ -f "$f" ] || { echo "ERROR: missing input $f" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# JSON helpers (sed/awk — no jq dependency, matches generate-capability-inventory.sh)
# ---------------------------------------------------------------------------
json_field() {
  local line="$1"
  local field="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

json_bool() {
  local line="$1"
  local field="$2"
  if printf '%s\n' "$line" | grep -q "\"$field\"[[:space:]]*:[[:space:]]*true"; then
    printf 'true'
  elif printf '%s\n' "$line" | grep -q "\"$field\"[[:space:]]*:[[:space:]]*false"; then
    printf 'false'
  fi
}

# Iterate top-level array objects. Works for flat JSON arrays of {...} entries
# where each object can contain nested arrays of scalars (e.g. "skills": [...]).
registry_entries() {
  local path="$1"
  awk '
    /\{/ { in_obj = 1; obj = "" }
    in_obj {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      obj = obj " " $0
    }
    /\}/ && in_obj {
      print obj
      in_obj = 0
    }
  ' "$path"
}

# Extract the bracketed string contents of `"field": [ "a", "b", ... ]` from a
# flattened entry. One string per line, quotes stripped. Returns 0 with no
# output when the field is missing or its array is empty.
json_array_strings() {
  local entry="$1"
  local field="$2"
  local bracketed
  bracketed="$(printf '%s' "$entry" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p")"
  [ -n "$bracketed" ] || return 0
  printf '%s\n' "$bracketed" | grep -oE '"[^"]+"' | sed 's/^"//; s/"$//' || true
}

# ---------------------------------------------------------------------------
# Slash distribution mapping
# ---------------------------------------------------------------------------
slash_cc()     { printf '/pm-os:%s' "$1"; }
slash_cowork() { printf '/%s' "$1"; }
slash_cursor() {
  case "$1" in
    pm-os-*) printf '/%s' "${1#pm-os-}" ;;
    *)       printf '/%s' "$1" ;;
  esac
}

# Escape markdown table cell contents — only the pipe character matters.
md_escape() {
  printf '%s' "$1" | sed 's/|/\\|/g'
}

# Pre-computed slug → claude_slug map for commands. Used to render workflow
# rows with the actual Claude Code command (e.g. /pm-os:pm-review for the
# multi-perspective-review workflow whose registered command is "review").
build_command_slug_map() {
  local s c
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    s="$(json_field "$entry" slug)"
    c="$(json_field "$entry" claude_slug)"
    [ -n "$s" ] && [ -n "$c" ] && printf '%s\t%s\n' "$s" "$c"
  done < <(registry_entries "$COMMANDS")
}

claude_slug_for_command() {
  local slug="$1"
  local result
  result="$(printf '%s\n' "$COMMAND_SLUG_MAP" | awk -v s="$slug" -F'\t' '$1 == s { print $2; exit }')"
  [ -n "$result" ] && printf '%s' "$result" || printf '%s' "$slug"
}

# ---------------------------------------------------------------------------
# MCP server parser (object-of-objects under mcpServers)
# Emits tab-separated: name<TAB>type<TAB>url per server
# ---------------------------------------------------------------------------
parse_mcp_servers() {
  awk '
    BEGIN { in_servers = 0; depth = 0; name = ""; type = ""; url = ""; TAB = "\t" }
    /"mcpServers"[[:space:]]*:[[:space:]]*\{/ { in_servers = 1; next }
    !in_servers { next }
    {
      if (depth == 0 && match($0, /"[^"]+"[[:space:]]*:[[:space:]]*\{/)) {
        s = substr($0, RSTART, RLENGTH)
        sub(/[[:space:]]*:[[:space:]]*\{.*$/, "", s)
        gsub(/^"|"$/, "", s)
        name = s
        type = ""; url = ""
        depth = 1
        next
      }
      if (depth > 0 && match($0, /"type"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        s = substr($0, RSTART, RLENGTH)
        sub(/.*:[[:space:]]*"/, "", s); sub(/"$/, "", s)
        type = s
      }
      if (depth > 0 && match($0, /"url"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        s = substr($0, RSTART, RLENGTH)
        sub(/.*:[[:space:]]*"/, "", s); sub(/"$/, "", s)
        url = s
      }
      if (depth > 0) {
        opens = gsub(/\{/, "&")
        closes = gsub(/\}/, "&")
        depth = depth + opens - closes
        if (depth <= 0 && name != "") {
          printf "%s%s%s%s%s\n", name, TAB, type, TAB, url
          name = ""; depth = 0
        }
      }
    }
  ' "$1"
}

# ---------------------------------------------------------------------------
# Hook parser. Emits tab-separated: name<TAB>event<TAB>matcher<TAB>path
# per hook command. Recognises SessionStart-style hooks; resolves
# ${CLAUDE_PLUGIN_ROOT}/hooks/X.sh to hooks/X.sh.
# ---------------------------------------------------------------------------
parse_hooks() {
  awk '
    BEGIN { event = ""; matcher = ""; TAB = "\t" }
    match($0, /"(SessionStart|PreToolUse|PostToolUse|UserPromptSubmit|Stop|SubagentStop|Notification|PreCompact)"[[:space:]]*:[[:space:]]*\[/) {
      e = substr($0, RSTART, RLENGTH)
      sub(/^[[:space:]]*"/, "", e); sub(/".*/, "", e)
      event = e
    }
    match($0, /"matcher"[[:space:]]*:[[:space:]]*"[^"]+"/) {
      s = substr($0, RSTART, RLENGTH)
      sub(/.*:[[:space:]]*"/, "", s); sub(/"$/, "", s)
      matcher = s
    }
    match($0, /\/hooks\/[A-Za-z0-9_.-]+\.sh/) {
      path = substr($0, RSTART, RLENGTH)
      sub(/^\//, "", path)
      hook_name = path
      sub(/.*\//, "", hook_name)
      sub(/\.sh$/, "", hook_name)
      printf "%s%s%s%s%s%s%s\n", hook_name, TAB, event, TAB, matcher, TAB, path
    }
  ' "$1"
}

# ---------------------------------------------------------------------------
# Counts + manifest values
# ---------------------------------------------------------------------------
COMMAND_SLUG_MAP="$(build_command_slug_map)"

plugin_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PLUGIN_MANIFEST" | head -1)"
marketplace_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MARKETPLACE" | head -1)"

skill_count="$(grep -c '"skill_id"' "$SKILLS" || true)"
agent_count="$(grep -c '"agent_id"' "$AGENTS" || true)"
command_count="$(registry_entries "$COMMANDS" | grep -c . || true)"
workflow_count="$(grep -c '"workflow_id"' "$WORKFLOWS" || true)"
mcp_count="$(parse_mcp_servers "$MCP_CONFIG" | grep -c . || true)"
hook_count="$(parse_hooks "$HOOKS_CONFIG" | grep -c . || true)"

# ---------------------------------------------------------------------------
# Preserve hand-edited block from the existing file (if any)
# ---------------------------------------------------------------------------
HAND_BEGIN='<!-- BEGIN HAND-EDITED -->'
HAND_END='<!-- END HAND-EDITED -->'

default_hand_block() {
  cat <<'EOF'
<!-- BEGIN HAND-EDITED -->

## Architectural Notes

> This block is preserved across regenerations. Use it for the architectural
> narrative — the "why" behind the layout, key design tradeoffs, ASCII flow
> diagrams, distribution boundary commentary, and anything else not derivable
> from `registry/`.

(empty — fill in as needed)

<!-- END HAND-EDITED -->
EOF
}

extract_hand_block() {
  local file="$1"
  awk -v begin="$HAND_BEGIN" -v end="$HAND_END" '
    $0 == begin { capture = 1 }
    capture { print }
    $0 == end && capture { exit }
  ' "$file"
}

preserved_block=""
if [ -f "$OUTPUT" ]; then
  preserved_block="$(extract_hand_block "$OUTPUT")"
fi
if [ -z "$preserved_block" ]; then
  preserved_block="$(default_hand_block)"
fi

# ---------------------------------------------------------------------------
# Emit the regenerated breadboard to a temp file
# ---------------------------------------------------------------------------
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  # Header
  printf '# pm-os System Breadboard\n\n'
  printf '<!-- breadboard-format-version: 1 -->\n\n'
  printf '> AUTO-GENERATED by `bin/generate-system-breadboard.sh` from the canonical pm-os registry.\n'
  printf '>\n'
  printf '> Generated sections are overwritten on regeneration. Only the block between\n'
  printf '> `<!-- BEGIN HAND-EDITED -->` and `<!-- END HAND-EDITED -->` is preserved across runs.\n'
  printf '>\n'
  printf '> Refresh: `bash bin/generate-system-breadboard.sh`\n'
  printf '> CI gate: `bash bin/generate-system-breadboard.sh --check`\n\n'
  printf '| Field | Value |\n'
  printf '| --- | --- |\n'
  printf '| Plugin manifest | `%s` |\n' "$PLUGIN_MANIFEST"
  printf '| Plugin version | `%s` |\n' "$plugin_version"
  printf '| Marketplace version | `%s` |\n' "$marketplace_version"
  printf '| Skills | %s |\n' "$skill_count"
  printf '| Commands | %s |\n' "$command_count"
  printf '| Workflows | %s |\n' "$workflow_count"
  printf '| Agents | %s |\n' "$agent_count"
  printf '| MCP servers | %s |\n' "$mcp_count"
  printf '| Hooks | %s |\n' "$hook_count"
  printf '\n---\n\n'

  # Components Inventory
  printf '## Components Inventory\n\n'

  printf '### Plugin layout\n\n'
  printf '| Component | Canonical path |\n'
  printf '| --- | --- |\n'
  printf '| Plugin manifest | `%s` |\n' "$PLUGIN_MANIFEST"
  printf '| Skills home | `skills/` |\n'
  printf '| Agents home | `agents/` |\n'
  printf '| Hooks home | `hooks/` |\n'
  printf '| MCP config | `%s` |\n' "$MCP_CONFIG"
  printf '| Registry | `registry/` |\n'
  printf '| Marketplace | `%s` |\n' "$MARKETPLACE"
  printf '\n'

  printf '### Agents (%s)\n\n' "$agent_count"
  printf '| Agent | Status | Canonical | Read-only | Used by |\n'
  printf '| --- | --- | --- | --- | --- |\n'
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    agent_id="$(json_field "$entry" agent_id)"
    status="$(json_field "$entry" status)"
    canonical="$(json_field "$entry" canonical_file)"
    readonly_flag="$(json_bool "$entry" readonly)"
    used_by_csv="$(json_array_strings "$entry" used_by | paste -sd ',' -)"
    [ -n "$used_by_csv" ] || used_by_csv='—'
    printf '| `%s` | %s | `%s` | %s | %s |\n' \
      "$agent_id" "$status" "$canonical" "$readonly_flag" "$used_by_csv"
  done < <(registry_entries "$AGENTS")
  printf '\n'

  printf '### MCP servers (%s)\n\n' "$mcp_count"
  printf '| Server | Transport | URL | Canonical config |\n'
  printf '| --- | --- | --- | --- |\n'
  while IFS=$'\t' read -r name transport url; do
    [ -n "$name" ] || continue
    [ -n "$url" ] || url='—'
    printf '| `%s` | %s | %s | `%s` |\n' \
      "$name" "$transport" "$(md_escape "$url")" "$MCP_CONFIG"
  done < <(parse_mcp_servers "$MCP_CONFIG")
  printf '\n'

  printf '### Hooks (%s)\n\n' "$hook_count"
  printf '| Hook | Event | Matcher | Script |\n'
  printf '| --- | --- | --- | --- |\n'
  while IFS=$'\t' read -r name event matcher path; do
    [ -n "$name" ] || continue
    printf '| `%s` | %s | `%s` | `%s` |\n' \
      "$name" "$event" "$(md_escape "$matcher")" "$path"
  done < <(parse_hooks "$HOOKS_CONFIG")
  printf '\n'

  printf '### Skills (%s)\n\n' "$skill_count"
  printf 'Per-skill inventory lives in `registry/SKILLS.md` (generated by `bin/generate-skill-registry.sh`).\n'
  printf 'Canonical home: `skills/{slug}/SKILL.md`.\n\n'
  printf '%s\n\n' '---'

  # Affordances
  printf '## Affordances — Slash invocations per distribution\n\n'
  printf 'Distribution rule:\n\n'
  printf '%s\n' '- **Claude Code:** `/pm-os:<claude_slug>` — the plugin namespace is always present.'
  printf '%s\n' '- **Cowork:** `/<claude_slug>` — Cowork strips the `pm-os:` namespace; the `pm-os-` directory prefix is what keeps these distinguishable in its dropdown.'
  printf '%s\n\n' '- **Cursor:** `/<claude_slug>` with the `pm-os-` directory prefix stripped where present (build-cursor-zip.sh transform).'
  printf '| Command | Type | Owner | Claude Code | Cowork | Cursor | Argument hint |\n'
  printf '| --- | --- | --- | --- | --- | --- | --- |\n'
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    claude_slug="$(json_field "$entry" claude_slug)"
    type="$(json_field "$entry" type)"
    owner="$(json_field "$entry" owner_plugin)"
    argument_hint="$(json_field "$entry" argument_hint)"
    [ -n "$argument_hint" ] || argument_hint='—'
    printf '| `%s` | %s | %s | `%s` | `%s` | `%s` | %s |\n' \
      "$claude_slug" \
      "$type" \
      "$owner" \
      "$(slash_cc "$claude_slug")" \
      "$(slash_cowork "$claude_slug")" \
      "$(slash_cursor "$claude_slug")" \
      "$argument_hint"
  done < <(registry_entries "$COMMANDS")
  printf '\n---\n\n'

  # Workflow chains
  printf '## Workflow → Skills Chains\n\n'
  printf '| Workflow | Command | Skills | Subagents | Output | Memory preflight |\n'
  printf '| --- | --- | --- | --- | --- | --- |\n'
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    workflow_id="$(json_field "$entry" workflow_id)"
    command="$(json_field "$entry" command)"
    output="$(json_field "$entry" output_destination)"
    memory="$(json_field "$entry" memory_preflight)"
    skill_n="$(json_array_strings "$entry" skills | grep -c . || true)"
    subagent_n="$(json_array_strings "$entry" subagents | grep -c . || true)"
    cs="$(claude_slug_for_command "$command")"
    printf '| `%s` | `%s` | %s | %s | `%s` | `%s` |\n' \
      "$workflow_id" "$(slash_cc "$cs")" "$skill_n" "$subagent_n" "$output" "$memory"
  done < <(registry_entries "$WORKFLOWS")
  printf '\n'

  printf '### Per-workflow skill sequences\n\n'
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    workflow_id="$(json_field "$entry" workflow_id)"
    command="$(json_field "$entry" command)"
    canonical="$(json_field "$entry" canonical_file)"
    cs="$(claude_slug_for_command "$command")"
    printf '#### `%s` → `%s`\n\n' "$workflow_id" "$(slash_cc "$cs")"
    printf 'Canonical: `%s`\n\n' "$canonical"

    subagents_csv="$(json_array_strings "$entry" subagents | paste -sd ',' -)"
    if [ -n "$subagents_csv" ]; then
      printf 'Subagents: %s\n\n' "$subagents_csv"
    fi

    skills_list="$(json_array_strings "$entry" skills)"
    if [ -n "$skills_list" ]; then
      printf 'Skills in sequence:\n\n'
      i=1
      while IFS= read -r path; do
        [ -n "$path" ] || continue
        slug="$(printf '%s' "$path" | sed 's|^skills/||; s|/SKILL.md$||')"
        printf '%s. `%s`\n' "$i" "$slug"
        i=$((i + 1))
      done <<< "$skills_list"
      printf '\n'
    else
      printf 'No sequenced skills — workflow runs inline.\n\n'
    fi
  done < <(registry_entries "$WORKFLOWS")

  printf '%s\n\n' '---'

  # Hand-edited block (preserved verbatim)
  printf '%s\n' "$preserved_block"
} > "$tmp"

# ---------------------------------------------------------------------------
# Write or check
# ---------------------------------------------------------------------------
if [ "$CHECK" = "1" ]; then
  [ -f "$OUTPUT" ] || { echo "ERROR: $OUTPUT missing" >&2; exit 1; }
  if ! cmp -s "$tmp" "$OUTPUT"; then
    echo "ERROR: $OUTPUT is stale. Run: bash bin/generate-system-breadboard.sh" >&2
    exit 1
  fi
  echo "OK: $OUTPUT is current"
else
  mkdir -p "$(dirname "$OUTPUT")"
  mv "$tmp" "$OUTPUT"
  trap - EXIT
  echo "OK: wrote $OUTPUT"
fi
