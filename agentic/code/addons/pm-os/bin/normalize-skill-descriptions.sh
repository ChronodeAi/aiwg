#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

is_external() {
  local slug="$1"
  grep -q "\"dest\"[[:space:]]*:[[:space:]]*\"$slug\"" external-skills/registry.json 2>/dev/null
}

frontmatter_field() {
  local file="$1"
  local field="$2"
  awk -v field="$field" '
    $0 ~ "^" field ":[[:space:]]*>-?[[:space:]]*$" { capture = 1; next }
    capture {
      if ($0 == "---") { gsub(/[[:space:]]+$/, "", value); print value; exit }
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (line != "") value = value line " "
      next
    }
    $0 ~ "^" field ":" {
      value = $0
      sub("^" field ":[[:space:]]*", "", value)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$file"
}

json_escape_for_yaml() {
  sed 's/\\/\\\\/g; s/"/\\"/g' <<EOF
$1
EOF
}

clean_description() {
  local current="$1"
  local slug="$2"
  local desc
  desc="$current"
  desc="${desc%% Category:*}"
  desc="${desc%% category:*}"
  case "$desc" in
    *"Use this skill"*|*"Trigger on:"*|*"Triggers on:"*|*"Also trigger"*)
      desc="${desc%% Use when the user needs to *}"
      ;;
  esac
  desc="$(printf '%s\n' "$desc" | sed 's/Use this skill whenever/Use when/g; s/Use this skill when/Use when/g; s/Use this skill even when/Use when/g; s/This skill should be used when/Use when/g')"
  desc="$(printf '%s\n' "$desc" | sed 's/[[:space:]]*$//')"
  [ -n "$desc" ] && [ "$desc" != ">" ] || desc="$(printf '%s' "$slug" | tr '-' ' ')"
  case "$desc" in
    *".") ;;
    *) desc="${desc}." ;;
  esac
  case "$desc" in
    *"Use when"*) printf '%s\n' "$desc" ;;
    *) printf '%s Use when the user needs to %s.\n' "$desc" "$(printf '%s' "$desc" | sed 's/\.$//' | tr '[:upper:]' '[:lower:]')" ;;
  esac
}

rewrite_description() {
  local file="$1"
  local new_desc="$2"
  awk -v replacement="$new_desc" '
    function print_replacement(    n, parts, i) {
      print "description: >-"
      n = split(replacement, parts, /\\n/)
      for (i = 1; i <= n; i++) print "  " parts[i]
    }
    BEGIN { done = 0 }
    /^description:[[:space:]]*>-?[[:space:]]*$/ {
      print_replacement()
      skip = 1
      done = 1
      next
    }
    skip && /^---$/ {
      skip = 0
      print
      next
    }
    skip { next }
    /^description:/ && !done {
      print_replacement()
      done = 1
      next
    }
    { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

changed=0
while IFS= read -r file; do
  slug="$(basename "$(dirname "$file")")"
  is_external "$slug" && continue
  current="$(frontmatter_field "$file" description)"
  normalized="$(clean_description "$current" "$slug")"
  if [ "$current" != "$normalized" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      printf 'would normalize %s\n' "$file"
    else
      rewrite_description "$file" "$normalized"
    fi
    changed=$((changed + 1))
  fi
done < <(find skills -mindepth 2 -maxdepth 2 -name SKILL.md -type f | sort)

printf 'OK: %s PM OS-owned skill description(s) %s\n' "$changed" "$([ "$DRY_RUN" = "1" ] && echo "would change" || echo "normalized")"
