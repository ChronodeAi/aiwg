#!/usr/bin/env bash
# Quality Gate Watcher — PR-level gate check
#
# Environment variables:
#   HOOK_EVENT         — "on_pr_open"
#   PROJECT_ROOT       — Project root directory (falls back to AIWG_PROJECT_DIR, then .)
#   AIWG_PROJECT_DIR   — Project root set by the OpenClaw runner
#   BASE_REF           — Base ref for the code-shape gates (default: origin/main)
#
# Exit: 1 when the code-shape gates fail or cannot run; artifact checks only warn.

set -euo pipefail

PROJECT="${PROJECT_ROOT:-${AIWG_PROJECT_DIR:-.}}"
BASE="${BASE_REF:-origin/main}"
FAIL=0

echo "quality-gate-watcher: PR gate check"

ISSUES=0

# Check test coverage
if [ -f "$PROJECT/coverage/coverage-summary.json" ]; then
  echo "  [PASS] Test coverage report exists"
else
  echo "  [WARN] No coverage report found"
  ISSUES=$((ISSUES + 1))
fi

# Check for required SDLC artifacts
for artifact in requirements architecture; do
  if ls "$PROJECT/.aiwg/${artifact}/"*.md 1>/dev/null 2>&1; then
    echo "  [PASS] ${artifact} artifacts present"
  else
    echo "  [WARN] Missing ${artifact} artifacts"
    ISSUES=$((ISSUES + 1))
  fi
done

# Code-shape gates: judged by the config at the base ref, so deleting gate.json cannot SKIP.
if git -C "$PROJECT" cat-file -e "$BASE:.aiwg/quality/gate.json" 2>/dev/null || [ -f "$PROJECT/.aiwg/quality/gate.json" ]; then
  if ! command -v aiwg >/dev/null; then
    echo "  [ERROR] code-shape gates: aiwg not on PATH"
    FAIL=1
  else
    rc=0
    (cd "$PROJECT" && aiwg run skill codebase-health -- --base "$BASE" --architecture --meta --ci) || rc=$?
    case $rc in
      0) echo "  [PASS] code-shape gates" ;;
      1) echo "  [FAIL] code-shape gates"; FAIL=1 ;;
      *) echo "  [ERROR] code-shape gates (exit $rc)"; FAIL=1 ;;
    esac
  fi
else
  echo "  [SKIP] code-shape gates (no .aiwg/quality/gate.json at $BASE or HEAD)"
fi

echo ""
echo "quality-gate-watcher: PR check complete (${ISSUES} issues)"
exit "$FAIL"
