#!/usr/bin/env bash
# sync-claude-md.sh — validate provider startup-file ownership
#
# In the Codex/AIWG distribution, AGENTS.md is generated and owned by AIWG while
# CLAUDE.md remains the legacy Claude compatibility surface. They are
# intentionally different. In legacy distributions, AGENTS.md remains the
# canonical source and CLAUDE.md is still a byte-for-byte release copy.
#
# Run this before release, or any time you edit AGENTS.md.
#
# Usage:
#   bash bin/sync-claude-md.sh          # validate AIWG ownership, or sync legacy copies
#   bash bin/sync-claude-md.sh --check  # validate without writing (CI gate)
#   bash bin/sync-claude-md.sh --legacy-copy # force the legacy copy behavior

set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"

LEGACY_PAIRS=(
  "$REPO_ROOT/AGENTS.md|$REPO_ROOT/CLAUDE.md"
  "$REPO_ROOT/AGENTS.md|$REPO_ROOT/CLAUDE.md"
)

CHECK_ONLY=false
FORCE_LEGACY=false
case "${1:-}" in
  "") ;;
  --check) CHECK_ONLY=true ;;
  --legacy-copy) FORCE_LEGACY=true ;;
  *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
esac

is_aiwg_layout() {
  [ -f "$REPO_ROOT/.aiwg/aiwg.config" ] &&
    [ -f "$REPO_ROOT/AGENTS.md" ] &&
    grep -q '<!-- aiwg-managed -->' "$REPO_ROOT/AGENTS.md"
}

validate_aiwg_layout() {
  local violations=0 required rel
  local required_files=(
    "AGENTS.md"
    "WORKSPACE.md"
    "AIWG.md"
    "CLAUDE.md"
    "CLAUDE.md"
  )

  for rel in "${required_files[@]}"; do
    required="$REPO_ROOT/$rel"
    if [ ! -f "$required" ]; then
      echo "  ✗ missing provider context: $rel" >&2
      violations=$((violations + 1))
    fi
  done

  if [ -f "$REPO_ROOT/AGENTS.md" ]; then
    grep -q '<!-- aiwg-managed -->' "$REPO_ROOT/AGENTS.md" || {
      echo "  ✗ AGENTS.md is not marked as AIWG-managed" >&2
      violations=$((violations + 1))
    }
    grep -q 'WORKSPACE.md' "$REPO_ROOT/AGENTS.md" || {
      echo "  ✗ AGENTS.md does not route Codex to WORKSPACE.md" >&2
      violations=$((violations + 1))
    }
    grep -q 'AIWG.md' "$REPO_ROOT/AGENTS.md" || {
      echo "  ✗ AGENTS.md does not route Codex to AIWG.md" >&2
      violations=$((violations + 1))
    }
  fi

  if [ "$violations" -gt 0 ]; then
    return 1
  fi

  $CHECK_ONLY || echo "  ✓ AIWG owns AGENTS.md; legacy CLAUDE.md files remain separate"
}

if ! $FORCE_LEGACY && is_aiwg_layout; then
  validate_aiwg_layout
  exit $?
fi

violations=0

for pair in "${LEGACY_PAIRS[@]}"; do
  agents="${pair%|*}"
  claude="${pair#*|}"
  [ -f "$agents" ] || { echo "  ✗ missing source: $agents" >&2; violations=$((violations + 1)); continue; }
  if [ -L "$claude" ]; then
    if $CHECK_ONLY; then
      echo "  ✗ $claude is a symlink (release ZIPs need a real file)" >&2
      violations=$((violations + 1))
      continue
    fi
    rm "$claude"
    cp "$agents" "$claude"
    echo "  ✓ replaced symlink with copy: ${claude#$REPO_ROOT/}"
    continue
  fi
  if [ ! -f "$claude" ] || ! cmp -s "$agents" "$claude"; then
    if $CHECK_ONLY; then
      echo "  ✗ out of sync: ${claude#$REPO_ROOT/} (run 'bash bin/sync-claude-md.sh' to fix)" >&2
      violations=$((violations + 1))
    else
      cp "$agents" "$claude"
      echo "  ✓ synced: ${claude#$REPO_ROOT/}"
    fi
  else
    $CHECK_ONLY || echo "  · in sync: ${claude#$REPO_ROOT/}"
  fi
done

if [ "$violations" -gt 0 ]; then
  exit 1
fi
