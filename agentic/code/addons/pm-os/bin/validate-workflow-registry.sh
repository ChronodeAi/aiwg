#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMMANDS="registry/commands.json"
WORKFLOWS="registry/workflows.json"
AGENTS="registry/agents.json"
ERRORS=()

add_error() {
  ERRORS+=("$*")
}

json_field() {
  local line="$1"
  local field="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

json_array_raw() {
  local line="$1"
  local field="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p"
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

contains_registry_file() {
  local registry="$1"
  local path="$2"
  # Tolerate both compact (`"key":"val"`) and pretty-printed (`"key": "val"`) JSON.
  grep -Eq "\"canonical_file\":[[:space:]]*\"$path\"" "$registry"
}

validate_command() {
  local line="$1"
  local slug type canonical cursor_stub claude_skill claude_slug owner
  slug="$(json_field "$line" slug)"
  type="$(json_field "$line" type)"
  owner="$(json_field "$line" owner_plugin)"
  canonical="$(json_field "$line" canonical_file)"
  cursor_stub="$(json_field "$line" cursor_stub)"
  claude_skill="$(json_field "$line" claude_skill)"
  claude_slug="$(json_field "$line" claude_slug)"

  [ -n "$slug" ] || add_error "command entry missing slug: $line"
  [ -n "$type" ] || add_error "command $slug missing type"
  [ -n "$owner" ] || add_error "command $slug missing owner_plugin"
  [ -f "$canonical" ] || add_error "command $slug canonical file missing: $canonical"

  # Cursor stub and Claude skill mirrors are optional in the Claude-stack canonical.
  # CC discovers commands directly from plugins/<plugin>/commands/. Cursor uses its
  # own transform at release time. Only validate mirrors if they exist on disk.
  if [ -n "$cursor_stub" ] && [ -f "$cursor_stub" ]; then
    if ! grep -q "$canonical" "$cursor_stub"; then
      add_error "command $slug Cursor stub does not route to $canonical"
    fi
  fi

  if [ -n "$claude_skill" ] && [ -f "$claude_skill" ]; then
    if ! grep -q "name: \"$claude_slug\"" "$claude_skill"; then
      add_error "command $slug Claude skill name should be $claude_slug"
    fi
    if ! grep -q "$canonical" "$claude_skill"; then
      add_error "command $slug Claude skill does not route to $canonical"
    fi
  fi
}

validate_workflow() {
  local line="$1"
  local workflow_id command canonical output memory skills subagents
  workflow_id="$(json_field "$line" workflow_id)"
  command="$(json_field "$line" command)"
  canonical="$(json_field "$line" canonical_file)"
  output="$(json_field "$line" output_destination)"
  memory="$(json_field "$line" memory_preflight)"
  skills="$(json_array_raw "$line" skills)"
  subagents="$(json_array_raw "$line" subagents)"

  [ -n "$workflow_id" ] || add_error "workflow entry missing workflow_id: $line"
  [ -n "$command" ] || add_error "workflow $workflow_id missing command"
  [ -f "$canonical" ] || add_error "workflow $workflow_id canonical file missing: $canonical"
  [ -n "$output" ] || add_error "workflow $workflow_id missing output_destination"
  [ -n "$memory" ] || add_error "workflow $workflow_id missing memory_preflight"
  grep -Eq "\"slug\":[[:space:]]*\"$command\"" "$COMMANDS" || add_error "workflow $workflow_id command not declared in commands registry: $command"

  if [ -n "$skills" ]; then
    registry_skills_file="/tmp/pm-os-registry-skills.$$"
    workflow_skills_file="/tmp/pm-os-workflow-skills.$$"
    : > "$registry_skills_file"
    : > "$workflow_skills_file"

    printf '%s\n' "$skills" | tr ',' '\n' | while IFS= read -r raw_skill; do
      skill="$(printf '%s\n' "$raw_skill" | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')"
      [ -z "$skill" ] && continue
      printf '%s\n' "$skill" >> "$registry_skills_file"
      [ -f "$skill" ] || printf 'MISSING_SKILL:%s\n' "$skill"
    done > /tmp/pm-os-registry-missing-skills.$$
    while IFS= read -r missing; do
      case "$missing" in
        MISSING_SKILL:*) add_error "workflow $workflow_id skill missing: ${missing#MISSING_SKILL:}" ;;
      esac
    done < /tmp/pm-os-registry-missing-skills.$$
    rm -f /tmp/pm-os-registry-missing-skills.$$

    sed -n 's/.*\*\*Folder:\*\* `\([^`]*\)`.*/\1/p' "$canonical" > "$workflow_skills_file"

    sort "$registry_skills_file" > "$registry_skills_file.sorted"
    sort "$workflow_skills_file" > "$workflow_skills_file.sorted"
    if ! cmp -s "$registry_skills_file.sorted" "$workflow_skills_file.sorted"; then
      add_error "workflow $workflow_id registry skills do not match **Folder:** refs in $canonical"
    fi
    rm -f "$registry_skills_file" "$workflow_skills_file" "$registry_skills_file.sorted" "$workflow_skills_file.sorted"
  else
    workflow_skill_count="$(sed -n 's/.*\*\*Folder:\*\* `\([^`]*\)`.*/\1/p' "$canonical" | wc -l | tr -d '[:space:]')"
    if [ "$workflow_skill_count" -gt 0 ]; then
      add_error "workflow $workflow_id has **Folder:** skill refs but registry skills is empty"
    fi
  fi

  if [ -n "$subagents" ]; then
    printf '%s\n' "$subagents" | tr ',' '\n' | while IFS= read -r raw_agent; do
      agent="$(printf '%s\n' "$raw_agent" | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')"
      [ -z "$agent" ] && continue
      agent_entry="$(grep "\"agent_id\":\"$agent\"" "$AGENTS" 2>/dev/null || true)"
      [ -n "$agent_entry" ] || { printf 'MISSING_AGENT:%s\n' "$agent"; continue; }
      printf '%s\n' "$agent_entry" | grep -q '"status":"active"' || printf 'INACTIVE_AGENT:%s\n' "$agent"
      printf '%s\n' "$agent_entry" | grep -q "\"used_by\":\\[[^]]*\"$workflow_id\"" || printf 'AGENT_NOT_USED_BY:%s\n' "$agent"
      # Verify the subagent exists in its plugin's canonical agents/ dir.
      # Legacy .cursor/agents/ and .claude/agents/ mirrors are no longer
      # required — CC discovers agents natively from plugins/<plugin>/agents/.
      [ -f "agents/$agent.md" ] || printf 'MISSING_AGENT:%s\n' "$agent"
    done > /tmp/pm-os-registry-missing-agents.$$
    while IFS= read -r missing; do
      case "$missing" in
        MISSING_AGENT:*) add_error "workflow $workflow_id subagent missing: ${missing#MISSING_AGENT:}" ;;
        MISSING_CLAUDE_AGENT:*) add_error "workflow $workflow_id Claude subagent missing: ${missing#MISSING_CLAUDE_AGENT:}" ;;
        INACTIVE_AGENT:*) add_error "workflow $workflow_id subagent is not active: ${missing#INACTIVE_AGENT:}" ;;
        AGENT_NOT_USED_BY:*) add_error "workflow $workflow_id subagent does not declare used_by: ${missing#AGENT_NOT_USED_BY:}" ;;
      esac
    done < /tmp/pm-os-registry-missing-agents.$$
    rm -f /tmp/pm-os-registry-missing-agents.$$
  fi
}

[ -f "$COMMANDS" ] || { echo "ERROR: $COMMANDS missing" >&2; exit 1; }
[ -f "$WORKFLOWS" ] || { echo "ERROR: $WORKFLOWS missing" >&2; exit 1; }

command_count=0
while IFS= read -r line; do
  validate_command "$line"
  command_count=$((command_count + 1))
done < <(registry_entries "$COMMANDS")

workflow_count=0
while IFS= read -r line; do
  validate_workflow "$line"
  workflow_count=$((workflow_count + 1))
done < <(registry_entries "$WORKFLOWS")

# System surface (migrated from /commands) — each must be in commands.json
# so the registry stays the source of truth for user-invokable entrypoints. The other
# 204 reusable skills are NOT in commands.json — they're model-invoked via description
# matching, not user-typed slashes.
#
# 10 of the 13 carry a pm-os- prefix to self-identify in Cowork's prefix-less dropdown
# (Cowork displays bare skill names without the plugin namespace). The 3 already-prefixed
# slugs (pm-help/pm-status/pm-review) and import-ai-memory stay as-is.
for system_slug in pm-os-capture-memory pm-os-daily-drip pm-os-feedback pm-os-framework \
                   import-ai-memory pm-help pm-status pm-os-project pm-os-skill \
                   pm-os-start pm-os-testimonial pm-os-tidy pm-os-upgrade; do
  command_file="skills/$system_slug/SKILL.md"
  [ -f "$command_file" ] || { add_error "system skill directory missing: $command_file"; continue; }
  contains_registry_file "$COMMANDS" "$command_file" || add_error "system skill missing from commands registry: $command_file"
done

# Workflow skill files (the 10 that orchestrate other skills) — registered in BOTH
# commands.json (as user-invocable surfaces) AND workflows.json (with step sequence).
for workflow_slug in assumptions coaching decisions measure meeting opportunity pm-review research stakeholder strategy; do
  workflow_file="skills/$workflow_slug/SKILL.md"
  [ -f "$workflow_file" ] || continue
  contains_registry_file "$COMMANDS" "$workflow_file" || add_error "workflow skill missing from commands registry: $workflow_file"
  contains_registry_file "$WORKFLOWS" "$workflow_file" || add_error "workflow missing from workflows registry: $workflow_file"
done

if [ "${#ERRORS[@]}" -gt 0 ]; then
  echo "ERROR: workflow registry validation failed" >&2
  for error in "${ERRORS[@]}"; do
    echo "- $error" >&2
  done
  exit 1
fi

echo "OK: $command_count commands and $workflow_count workflows validated"
