#!/usr/bin/env bash
# bin/check-skill-counts.sh — library counts in shipped copy must match the registry.
#
# Why this exists: every skill retirement has to be hand-propagated to a dozen
# files that state the library size in prose — README, CONTRIBUTING, the two
# plugin manifests, the build scripts, the install docs. Nothing gated them, so
# they drifted apart. During the #114 sweep four consecutive PRs each had to
# hand-correct the same class of bug, and at one point README carried 236, 234,
# and 221 in three different places while the manifests said 210 and 209.
#
# The registry is the source of truth. This derives the four counts from it and
# fails if any shipped file disagrees.
#
#   total     = registry/skills.json
#   workflows = registry/workflows.json
#   system    = bin/skill-categories.json, "PM OS System & Operations"
#   reusable  = total - workflows - system
#
# Scope is deliberately narrow: only files that state a library-wide count.
# {AGENTS,CLAUDE}.md are excluded because their per-workflow
# counts ("4 skills — crux to value chain") are a different quantity, and
# _internal/tests/ is excluded because its floors are lower bounds by design.
#
# Wired into CI (.github/workflows/ci.yml). Run locally: bash bin/check-skill-counts.sh
#
# Requirements: jq

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required. Install: brew install jq (macOS) or apt install jq (Linux)" >&2
  exit 1
fi

REGISTRY="registry/skills.json"
WORKFLOWS="registry/workflows.json"
CATEGORIES="bin/skill-categories.json"
SYSTEM_CATEGORY="PM OS System & Operations"

for f in "$REGISTRY" "$WORKFLOWS" "$CATEGORIES"; do
  [ -s "$f" ] || { echo "FATAL: $f missing or empty. Restore from git." >&2; exit 1; }
  jq -e '.' "$f" >/dev/null 2>&1 || { echo "FATAL: $f is not valid JSON." >&2; exit 1; }
done

total=$(jq 'length' "$REGISTRY")
workflows=$(jq 'length' "$WORKFLOWS")
system=$(jq --arg c "$SYSTEM_CATEGORY" '[to_entries[] | select(.value == $c)] | length' "$CATEGORIES")
reusable=$((total - workflows - system))

if [ "$reusable" -lt 1 ]; then
  echo "FATAL: derived reusable count is $reusable (total $total - workflows $workflows - system $system)." >&2
  echo "  One of the three registries is out of sync. Regenerate before trusting this check." >&2
  exit 1
fi

FILES="
README.md
CONTRIBUTING.md
.claude-plugin/marketplace.json
.claude-plugin/plugin.json
bin/build-cowork-zip.sh
bin/build-cursor-zip.sh
bin/validate-workflow-registry.sh
docs/install-claude-code.md
docs/install-cowork.md
docs/install-cursor.md
"

FINDINGS="$(mktemp)"
trap 'rm -f "$FINDINGS"' EXIT

# scan <regex> <expected> <label>
# grep -nEo emits LINENO:MATCH; the leading integer of MATCH is the claim.
scan() {
  local regex="$1" expected="$2" label="$3"
  local f hit lineno text num
  for f in $FILES; do
    [ -f "$f" ] || continue
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      lineno="${hit%%:*}"
      text="${hit#*:}"
      num="${text%% *}"
      [ "$num" = "$expected" ] || printf '%s:%s  %s says %s, registry says %s  ("%s")\n' \
        "$f" "$lineno" "$label" "$num" "$expected" "$text" >> "$FINDINGS"
    done < <(grep -nEo "$regex" "$f" 2>/dev/null)
  done
}

scan '[0-9]+ (PM )?skills'                         "$total"     "total"
scan '[0-9]+ reusable'                             "$reusable"  "reusable"
scan '[0-9]+ system'                               "$system"    "system"
scan '[0-9]+ (sequenced )?workflows?( skills)?'    "$workflows" "workflows"

if [ -s "$FINDINGS" ]; then
  echo "ERROR: shipped skill counts disagree with the registry" >&2
  sort -u "$FINDINGS" | sed 's/^/  /' >&2
  echo "" >&2
  echo "  Registry: $total total = $system system + $workflows workflows + $reusable reusable" >&2
  echo "  Fix the prose to match. The registry is the source of truth, not the other way round." >&2
  exit 1
fi

echo "OK: shipped skill counts match the registry — $total total = $system system + $workflows workflows + $reusable reusable"
