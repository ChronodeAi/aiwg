#!/usr/bin/env bash
# validate-skill-cross-references.sh — fail on dangling references to renamed skills.
#
# Scans tracked .md and .json files for `skills/<slug>/` paths
# and verifies each <slug> resolves to a real skill directory under
# skills/. Catches the rename-broke-a-cross-reference class of
# bug that requires manual grep today (and was exactly what cost ~5 minutes
# during the v2.1.0-beta.3 rename PR).
#
# Excludes auto-generated registries (which are projections OF the slug set,
# not user-written references) and CHANGELOG.md (historical names are valid
# records, not references).
#
# Usage:
#   bash bin/validate-skill-cross-references.sh
#   bash bin/validate-skill-cross-references.sh --root /path/to/repo
#
# Exit codes:
#   0 — every reference resolves
#   1 — at least one reference is dangling

set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$ROOT_DEFAULT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$(cd -P "$2" && pwd)"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT"

SKILLS_HOME="skills"
[ -d "$SKILLS_HOME" ] || { echo "ERROR: $SKILLS_HOME missing under $ROOT" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Build the canonical slug set from on-disk skill directories.
# ---------------------------------------------------------------------------
known_slugs_file="$(mktemp)"
trap 'rm -f "$known_slugs_file"' EXIT
find "$SKILLS_HOME" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; \
  | sort -u > "$known_slugs_file"
skill_count="$(wc -l < "$known_slugs_file" | tr -d ' ')"

is_known_slug() {
  grep -qxF "$1" "$known_slugs_file"
}

# ---------------------------------------------------------------------------
# Files to scan. Path filtering only — content filtering happens in the grep.
# ---------------------------------------------------------------------------
is_excluded() {
  case "$1" in
    registry/skills.json) return 0 ;;
    registry/SKILLS.md) return 0 ;;
    registry/CAPABILITIES.md) return 0 ;;
    _internal/SYSTEM-BREADBOARD.md) return 0 ;;
    CHANGELOG.md) return 0 ;;
    .github/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Use git ls-files when in a git tree; fall back to find otherwise (tests).
list_candidate_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -- '*.md' '*.json'
  else
    find . -type f \( -name '*.md' -o -name '*.json' \) | sed 's|^\./||'
  fi
}

# ---------------------------------------------------------------------------
# Scan + dedupe + check.
# ---------------------------------------------------------------------------
hits_file="$(mktemp)"
trap 'rm -f "$known_slugs_file" "$hits_file"' EXIT

while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  is_excluded "$f" && continue
  # grep -oH emits `<file>:<match>` for each match.
  grep -oH 'skills/[A-Za-z0-9_-]\+/' "$f" 2>/dev/null || true
done < <(list_candidate_files) | sort -u > "$hits_file"

dangling_file="$(mktemp)"
trap 'rm -f "$known_slugs_file" "$hits_file" "$dangling_file"' EXIT

while IFS= read -r line; do
  [ -n "$line" ] || continue
  # line is `<file>:skills/<slug>/`
  file="${line%%:*}"
  rest="${line#*:}"
  slug="${rest#skills/}"
  slug="${slug%%/*}"
  [ -n "$slug" ] || continue
  if ! is_known_slug "$slug"; then
    printf '%s\t%s\n' "$file" "$slug" >> "$dangling_file"
  fi
done < "$hits_file"

dangling_count="$(wc -l < "$dangling_file" | tr -d ' ')"
if [ "$dangling_count" -gt 0 ]; then
  echo "ERROR: $dangling_count dangling skill cross-reference(s):" >&2
  while IFS=$'\t' read -r file slug; do
    printf '  %s → skills/%s/ (slug does not exist)\n' "$file" "$slug" >&2
  done < "$dangling_file"
  exit 1
fi

ref_count="$(wc -l < "$hits_file" | tr -d ' ')"
echo "OK: $ref_count skill path reference(s) resolved across $skill_count skill(s) on disk"
