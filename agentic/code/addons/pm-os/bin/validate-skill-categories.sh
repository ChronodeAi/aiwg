#!/usr/bin/env bash
# bin/validate-skill-categories.sh
#
# Enforces six invariants on the Skill Browser categorization layer:
#   1. taxonomy/theme_consistency — every theme.categories entry is in the
#      top-level taxonomy.categories list.
#   2. taxonomy/theme_coverage    — every top-level taxonomy.categories entry
#      appears in exactly one theme.
#   3. MISSING_CATEGORY — every SKILL.md slug has an entry in
#      bin/skill-categories.json.
#   4. ORPHAN_ENTRY    — every entry in bin/skill-categories.json points to
#      an existing SKILL.md on disk.
#   5. INVALID_CATEGORY — every assigned category is in
#      bin/skill-taxonomy.json's categories list.
#   6. EMPTY_BUCKET    — every category in the taxonomy has ≥1 skill.
#
# Edge-case handling: missing/malformed JSON, empty skills dir, invalid
# slug characters all produce explicit FATAL messages (never a raw jq
# parse error reaching the user).
#
# Wired into CI (.github/workflows/ci.yml) and bin/release.sh pre-flight.
# Run locally: bash bin/validate-skill-categories.sh
#
# Requirements: jq

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAXONOMY="bin/skill-taxonomy.json"
ASSIGNMENTS="bin/skill-categories.json"
SKILLS_DIR="skills"

# ── deps ───────────────────────────────────────────────────────────────────

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required. Install: brew install jq (macOS) or apt install jq (Linux)" >&2
  exit 1
fi

# ── input sanity (edge cases come first) ───────────────────────────────────

fatal() {
  echo "FATAL: $*" >&2
  exit 1
}

[[ -f "$TAXONOMY"    ]] || fatal "$TAXONOMY not found. This file is the canonical category list — restore from git."
[[ -s "$TAXONOMY"    ]] || fatal "$TAXONOMY is empty. Restore from git."
[[ -f "$ASSIGNMENTS" ]] || fatal "$ASSIGNMENTS not found. Run the generator or restore from git."
[[ -s "$ASSIGNMENTS" ]] || fatal "$ASSIGNMENTS is empty. Restore from git."

if ! jq -e '.' "$TAXONOMY" >/dev/null 2>&1; then
  fatal "$TAXONOMY is not valid JSON: $(jq '.' "$TAXONOMY" 2>&1 | head -1)"
fi
if ! jq -e '.' "$ASSIGNMENTS" >/dev/null 2>&1; then
  fatal "$ASSIGNMENTS is not valid JSON: $(jq '.' "$ASSIGNMENTS" 2>&1 | head -1)"
fi

# Empty skills dir is a clean state (useful for testing in isolation).
if [[ ! -d "$SKILLS_DIR" ]]; then
  echo "✓ No skills found (0 of 0 categorized)."
  exit 0
fi

# ── pull data ──────────────────────────────────────────────────────────────

# Slugs discovered on disk (one per line, sorted).
disk_slugs=$(find "$SKILLS_DIR" -mindepth 2 -maxdepth 2 -name SKILL.md -type f \
  | sed "s|^$SKILLS_DIR/\([^/]*\)/SKILL.md\$|\1|" | sort -u)

# Defensive: catch any non-kebab-case slugs before they corrupt later jq lookups.
bad_slugs=$(printf '%s\n' "$disk_slugs" | grep -Ev '^[A-Za-z0-9_-]+$' || true)
if [[ -n "$bad_slugs" ]]; then
  echo "FATAL: invalid slug(s) found (must be kebab-case):" >&2
  printf '  - %s\n' $bad_slugs >&2
  exit 1
fi

# Lists derived from the JSON files.
taxonomy_cats=$(jq -r '.categories[]' "$TAXONOMY" | sort -u)
theme_cats=$(jq -r '.themes[].categories[]' "$TAXONOMY" | sort -u)
registry_slugs=$(jq -r 'keys[]' "$ASSIGNMENTS" | sort -u)
assigned_cats=$(jq -r 'values[]' "$ASSIGNMENTS" | sort -u)

# ── run checks ─────────────────────────────────────────────────────────────

MISSING=()
ORPHAN=()
INVALID=()
EMPTY=()
THEME_INCONSISTENT=()
THEME_UNCOVERED=()

# 1. taxonomy/theme_consistency: theme categories ⊆ taxonomy categories
while IFS= read -r cat; do
  [[ -z "$cat" ]] && continue
  if ! grep -Fxq -- "$cat" <<<"$taxonomy_cats"; then
    THEME_INCONSISTENT+=("$cat")
  fi
done <<<"$theme_cats"

# 2. taxonomy/theme_coverage: every taxonomy category in exactly one theme
while IFS= read -r cat; do
  [[ -z "$cat" ]] && continue
  count=$(jq --arg c "$cat" '[.themes[].categories[] | select(. == $c)] | length' "$TAXONOMY")
  if [[ "$count" -ne 1 ]]; then
    THEME_UNCOVERED+=("$cat (in $count themes)")
  fi
done <<<"$taxonomy_cats"

# 3. MISSING_CATEGORY: disk slugs without assignments
while IFS= read -r slug; do
  [[ -z "$slug" ]] && continue
  if ! grep -Fxq -- "$slug" <<<"$registry_slugs"; then
    MISSING+=("$slug")
  fi
done <<<"$disk_slugs"

# 4. ORPHAN_ENTRY: registry slugs without on-disk SKILL.md
while IFS= read -r slug; do
  [[ -z "$slug" ]] && continue
  if ! grep -Fxq -- "$slug" <<<"$disk_slugs"; then
    cat=$(jq -r --arg s "$slug" '.[$s]' "$ASSIGNMENTS")
    ORPHAN+=("$slug → \"$cat\"")
  fi
done <<<"$registry_slugs"

# 5. INVALID_CATEGORY: assigned categories not in taxonomy
while IFS= read -r cat; do
  [[ -z "$cat" ]] && continue
  if ! grep -Fxq -- "$cat" <<<"$taxonomy_cats"; then
    bad_slugs=$(jq -r --arg c "$cat" 'to_entries[] | select(.value == $c) | .key' "$ASSIGNMENTS")
    while IFS= read -r slug; do
      [[ -z "$slug" ]] && continue
      INVALID+=("$slug → \"$cat\"")
    done <<<"$bad_slugs"
  fi
done <<<"$assigned_cats"

# 6. EMPTY_BUCKET: taxonomy categories with no assignments
while IFS= read -r cat; do
  [[ -z "$cat" ]] && continue
  if ! grep -Fxq -- "$cat" <<<"$assigned_cats"; then
    EMPTY+=("$cat")
  fi
done <<<"$taxonomy_cats"

# ── format output ──────────────────────────────────────────────────────────

total_issues=$((${#MISSING[@]} + ${#ORPHAN[@]} + ${#INVALID[@]} + ${#EMPTY[@]} + ${#THEME_INCONSISTENT[@]} + ${#THEME_UNCOVERED[@]}))
n_skills=$(printf '%s\n' "$disk_slugs" | grep -c . || true)
n_categories=$(printf '%s\n' "$taxonomy_cats" | grep -c . || true)

if [[ $total_issues -eq 0 ]]; then
  echo "✓ Skill categorization clean: $n_skills skills across $n_categories categories."
  exit 0
fi

echo "✗ Skill categorization failed validation ($total_issues issue$([[ $total_issues -eq 1 ]] && echo "" || echo "s"))"
echo

valid_cats_oneline=$(jq -r '.categories | join(" | ")' "$TAXONOMY")

if [[ ${#THEME_INCONSISTENT[@]} -gt 0 ]]; then
  echo "TAXONOMY/THEME_CONSISTENCY (${#THEME_INCONSISTENT[@]})"
  echo "  These category names appear in a theme but not in taxonomy.categories:"
  for cat in "${THEME_INCONSISTENT[@]}"; do echo "    - \"$cat\""; done
  echo
  echo "  Fix: align the names in $TAXONOMY — either add the category to the top-level"
  echo "       list, or remove/rename the theme entry."
  echo
fi

if [[ ${#THEME_UNCOVERED[@]} -gt 0 ]]; then
  echo "TAXONOMY/THEME_COVERAGE (${#THEME_UNCOVERED[@]})"
  echo "  These categories are not in exactly one theme:"
  for entry in "${THEME_UNCOVERED[@]}"; do echo "    - $entry"; done
  echo
  echo "  Fix: edit $TAXONOMY so every category appears in exactly one theme's categories[]."
  echo
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "MISSING_CATEGORY (${#MISSING[@]})"
  echo "  These skills exist on disk but have no entry in $ASSIGNMENTS:"
  for slug in "${MISSING[@]}"; do echo "    - $slug  ($SKILLS_DIR/$slug/SKILL.md)"; done
  echo
  echo "  Fix: add to $ASSIGNMENTS:"
  for slug in "${MISSING[@]}"; do echo "    \"$slug\": \"<category>\","; done
  echo
  echo "  Valid categories: $valid_cats_oneline"
  echo
fi

if [[ ${#ORPHAN[@]} -gt 0 ]]; then
  echo "ORPHAN_ENTRY (${#ORPHAN[@]})"
  echo "  These entries point to skills that no longer exist on disk:"
  for entry in "${ORPHAN[@]}"; do echo "    - $entry"; done
  echo
  echo "  Fix: remove the entries from $ASSIGNMENTS, or restore the corresponding SKILL.md."
  echo
fi

if [[ ${#INVALID[@]} -gt 0 ]]; then
  echo "INVALID_CATEGORY (${#INVALID[@]})"
  echo "  These entries use categories not in $TAXONOMY:"
  for entry in "${INVALID[@]}"; do echo "    - $entry"; done
  echo
  echo "  Fix: edit $ASSIGNMENTS to use one of: $valid_cats_oneline"
  echo
fi

if [[ ${#EMPTY[@]} -gt 0 ]]; then
  echo "EMPTY_BUCKET (${#EMPTY[@]})"
  echo "  These categories exist in the taxonomy but have no skills assigned:"
  for cat in "${EMPTY[@]}"; do echo "    - \"$cat\""; done
  echo
  echo "  Fix: assign at least one skill in $ASSIGNMENTS,"
  echo "       or remove the category from $TAXONOMY (and its theme reference)."
  echo
fi

echo "FAILED: $total_issues issue$([[ $total_issues -eq 1 ]] && echo "" || echo "s")."
exit 1
