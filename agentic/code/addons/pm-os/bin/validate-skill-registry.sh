#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$(cd -P "$2" && pwd)"; shift 2 ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT"

REGISTRY="registry/skills.json"
ERRORS=()

add_error() {
  ERRORS+=("$*")
}

json_field() {
  local line="$1"
  local field="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
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

frontmatter_field() {
  local file="$1"
  local field="$2"
  awk -v field="$field" '
    $0 ~ "^" field ":[[:space:]]*>-?[[:space:]]*$" {
      capture = 1
      next
    }
    capture {
      if ($0 == "---" || $0 ~ /^[A-Za-z_][A-Za-z0-9_-]*:/) {
        gsub(/[[:space:]]+$/, "", value)
        print value
        exit
      }
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

[ -f "$REGISTRY" ] || { echo "ERROR: $REGISTRY missing" >&2; exit 1; }

seen_ids="$(mktemp)"
seen_slugs="$(mktemp)"
trap 'rm -f "$seen_ids" "$seen_slugs"' EXIT
count=0

while IFS= read -r entry; do
  skill_id="$(json_field "$entry" skill_id)"
  slug="$(json_field "$entry" slug)"
  name="$(json_field "$entry" name)"
  path="$(json_field "$entry" path)"
  description="$(json_field "$entry" description)"
  provenance="$(json_field "$entry" provenance)"
  count=$((count + 1))

  [ -n "$skill_id" ] || add_error "entry missing skill_id: $entry"
  [ -n "$slug" ] || add_error "entry missing slug: $entry"
  [ -n "$path" ] || add_error "skill $slug missing path"
  case "$provenance" in pm-os|external) ;; *) add_error "skill $slug has invalid provenance: $provenance" ;; esac
  [ -f "$path" ] || add_error "skill $slug path missing: $path"
  if [ "$provenance" = "pm-os" ]; then
    [ -n "$name" ] || add_error "skill $slug missing name"
    [ -n "$description" ] || add_error "skill $slug missing description"
  fi
  if [ "$provenance" = "pm-os" ]; then
    case "$description" in
      ">"|"") add_error "skill $slug PM OS description is not normalized" ;;
    esac
    case "$entry" in
      *"Category:"*) add_error "skill $slug PM OS description contains Category suffix" ;;
      *"🌱"*|*"💾"*|*"🗣️"*|*"🔍"*|*"🎨"*|*"⛳"*|*"📊"*|*"🎯"*|*"🤔"*|*"🤝"*|*"📅"*|*"💡"*|*"🔧"*) add_error "skill $slug PM OS description contains category emoji" ;;
    esac
    case "$entry" in
      *"Use when"*) ;;
      *) add_error "skill $slug PM OS description missing Use when trigger" ;;
    esac
    # Backticked sibling pointers (`` `Not for ... (`slug`)` ``) must resolve
    # to a real skill directory. Extracted from $entry, not $description —
    # json_field's [^"]* capture truncates at the first literal `"` inside a
    # description (present in ~35 of 240 today), which would silently drop
    # the trailing "Not for" clause. Tokens containing /, ., or a space are
    # workflow commands (`` `/measure` ``) or prose, not sibling slugs.
    tokens="$(printf '%s' "$entry" | grep -o '`[^`]*`' | tr -d '`' || true)"
    while IFS= read -r token; do
      [ -n "$token" ] || continue
      case "$token" in
        */*|*.*|*' '*) continue ;;
      esac
      case "$token" in
        [a-z0-9]*) ;;
        *) continue ;;
      esac
      [ -d "skills/$token" ] \
        || add_error "skill $slug description points at unknown sibling: \`$token\`"
    done < <(printf '%s\n' "$tokens")
  fi

  if grep -qxF "$skill_id" "$seen_ids"; then
    add_error "duplicate skill_id: $skill_id"
  fi
  printf '%s\n' "$skill_id" >> "$seen_ids"

  if grep -qxF "$slug" "$seen_slugs"; then
    add_error "duplicate slug: $slug"
  fi
  printf '%s\n' "$slug" >> "$seen_slugs"

  if [ -f "$path" ]; then
    actual_name="$(frontmatter_field "$path" name)"
    actual_desc="$(frontmatter_field "$path" description)"
    if [ "$provenance" = "pm-os" ]; then
      [ -n "$actual_name" ] || add_error "skill $slug SKILL.md missing frontmatter name"
      [ -n "$actual_desc" ] || add_error "skill $slug SKILL.md missing frontmatter description"
    fi
    if [ "$provenance" = "pm-os" ] && [ -n "$actual_name" ] && [ "$actual_name" != "$name" ]; then
      add_error "skill $slug registry name differs from SKILL.md: $name != $actual_name"
    fi
  fi
done < <(registry_entries "$REGISTRY")

disk_count="$(find skills -mindepth 2 -maxdepth 2 -name SKILL.md -type f | wc -l | tr -d '[:space:]')"
[ "$count" = "$disk_count" ] || add_error "registry count $count does not match disk skill count $disk_count"

if [ "${#ERRORS[@]}" -gt 0 ]; then
  echo "ERROR: skill registry validation failed" >&2
  for error in "${ERRORS[@]}"; do
    echo "- $error" >&2
  done
  exit 1
fi

echo "OK: $count skills validated"
