#!/usr/bin/env bash
# Report whether a PR branch is synced with main for merge readiness (#2654).
#
# Usage: pr-base-sync.sh [--main-ref <ref>] [--repo <dir>]
# Output (stdout): status/head/main/merge_base/main_ref/ready lines.
# Exit 0 when the report was produced; exit 2 on usage or git errors.
# Statuses: up-to-date (main is an ancestor of HEAD), behind (cleanly
# rebaseable/mergeable), conflict (sync would conflict). Only up-to-date
# (after re-running the project's required verification) is ready.

set -euo pipefail

MAIN_REF=""
REPO="."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --main-ref) MAIN_REF="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "FAIL: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "FAIL: $1" >&2; exit 2; }

[[ -n "$MAIN_REF" ]] || MAIN_REF="origin/main"
if ! git -C "$REPO" rev-parse --verify --quiet "$MAIN_REF" >/dev/null; then
  if [[ "$MAIN_REF" == "origin/main" ]] && git -C "$REPO" rev-parse --verify --quiet main >/dev/null; then
    MAIN_REF="main"
  else
    fail "main ref '$MAIN_REF' does not resolve (fetch first, e.g. git fetch origin)"
  fi
fi

HEAD_SHA="$(git -C "$REPO" rev-parse --verify HEAD 2>/dev/null)" || fail "cannot resolve HEAD"
MAIN_SHA="$(git -C "$REPO" rev-parse --verify "$MAIN_REF" 2>/dev/null)" || fail "cannot resolve $MAIN_REF"
BASE_SHA="$(git -C "$REPO" merge-base HEAD "$MAIN_REF" 2>/dev/null)" || fail "cannot compute merge-base"

STATUS="behind"
READY="false"
if [[ "$MAIN_SHA" == "$BASE_SHA" ]]; then
  STATUS="up-to-date"
  READY="true"
elif git -C "$REPO" merge-tree "$BASE_SHA" HEAD "$MAIN_REF" 2>/dev/null | grep -q '<<<<<<< '; then
  STATUS="conflict"
fi

echo "status=$STATUS"
echo "head=$HEAD_SHA"
echo "main=$MAIN_SHA"
echo "merge_base=$BASE_SHA"
echo "main_ref=$MAIN_REF"
echo "ready=$READY"

if [[ "$STATUS" == "behind" ]]; then
  echo "next=fetch latest main, then sync with the project-approved method (default: git rebase <main-ref>), then re-run the required verification" >&2
elif [[ "$STATUS" == "conflict" ]]; then
  echo "next=sync would conflict: resolve conflicts locally, then re-run the required verification; readiness is blocked until conflict-free, synced and re-verified" >&2
fi
