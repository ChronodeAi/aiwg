#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_JSON="registry/skills.json"
OUT_MD="registry/SKILLS.md"
CHECK=0

if [ "${1:-}" = "--check" ]; then
  CHECK=1
fi

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

json_escape() {
  sed 's/\\/\\\\/g; s/"/\\"/g' <<EOF
$1
EOF
}

registry_provenance() {
  local slug="$1"
  if grep -q "\"dest\"[[:space:]]*:[[:space:]]*\"$slug\"" external-skills/registry.json 2>/dev/null; then
    printf 'external'
  else
    printf 'pm-os'
  fi
}

tmp_json="$(mktemp)"
tmp_md="$(mktemp)"
trap 'rm -f "$tmp_json" "$tmp_md"' EXIT

{
  printf '[\n'
  first=1
  find skills -mindepth 2 -maxdepth 2 -name SKILL.md -type f | sort | while IFS= read -r path; do
    slug="$(basename "$(dirname "$path")")"
    name="$(frontmatter_field "$path" name)"
    description="$(frontmatter_field "$path" description)"
    provenance="$(registry_provenance "$slug")"
    [ -n "$name" ] || name="$slug"
    [ "$first" = "1" ] || printf ',\n'
    first=0
    printf '  {"skill_id":"skill:%s","slug":"%s","name":"%s","path":"%s","description":"%s","provenance":"%s","status":"active"}' \
      "$(json_escape "$slug")" \
      "$(json_escape "$slug")" \
      "$(json_escape "$name")" \
      "$(json_escape "$path")" \
      "$(json_escape "$description")" \
      "$provenance"
  done
  printf '\n]\n'
} > "$tmp_json"

{
  printf '# PM OS Skill Inventory\n\n'
  printf 'Generated from `skills/*/SKILL.md`.\n\n'
  printf 'Do not edit skill facts here by hand. Update skill files or `external-skills/registry.json`, then run:\n\n'
  printf '```bash\nbash bin/generate-skill-registry.sh\n```\n\n'
  printf '| Skill | Provenance | Path | Description |\n'
  printf '| --- | --- | --- | --- |\n'
  find skills -mindepth 2 -maxdepth 2 -name SKILL.md -type f | sort | while IFS= read -r path; do
    slug="$(basename "$(dirname "$path")")"
    description="$(frontmatter_field "$path" description)"
    provenance="$(registry_provenance "$slug")"
    printf '| %s | %s | `%s` | %s |\n' "$slug" "$provenance" "$path" "$description"
  done
} > "$tmp_md"

if [ "$CHECK" = "1" ]; then
  [ -f "$OUT_JSON" ] || { echo "ERROR: $OUT_JSON missing" >&2; exit 1; }
  [ -f "$OUT_MD" ] || { echo "ERROR: $OUT_MD missing" >&2; exit 1; }
  cmp -s "$tmp_json" "$OUT_JSON" || { echo "ERROR: $OUT_JSON is stale. Run: bash bin/generate-skill-registry.sh" >&2; exit 1; }
  cmp -s "$tmp_md" "$OUT_MD" || { echo "ERROR: $OUT_MD is stale. Run: bash bin/generate-skill-registry.sh" >&2; exit 1; }
  echo "OK: skill registry is current"
else
  mkdir -p "$(dirname "$OUT_JSON")"
  mv "$tmp_json" "$OUT_JSON"
  mv "$tmp_md" "$OUT_MD"
  trap - EXIT
  echo "OK: wrote $OUT_JSON and $OUT_MD"
fi
