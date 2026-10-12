#!/usr/bin/env bash
# tidy-reminder.sh — sessionStart hook for Cursor and Claude Code
#
# Reminds the user to run /tidy when:
#   - /tidy has never been run AND Work/ contains .md files, OR
#   - orphaned files exist (at Work/ root or in legacy type folders), OR
#   - more than 12 hours have passed since last /tidy AND files are modified since.
#
# Outputs JSON with additional_context for the agent to surface.

set -euo pipefail

# Anchor to user's workspace. Prefer Claude Code's CLAUDE_PROJECT_DIR env var
# (set by CC for plugin hooks); fall back to pwd for Cursor / standalone runs.
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_ROOT"

STATE_FILE="📂 Context/Work/.hook-state/tidy.json"
WORK_DIR="📂 Context/Work"
STALE_HOURS=12

if [ ! -d "$WORK_DIR" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Count orphans: files at Work/ root (excluding .current) + legacy type folders
# ---------------------------------------------------------------------------
ORPHAN_COUNT=0
# Files at Work/ root (files only, not subdirs)
ROOT_ORPHANS=$(find "$WORK_DIR" -maxdepth 1 -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
ORPHAN_COUNT=$((ORPHAN_COUNT + ROOT_ORPHANS))
# Legacy type-based folders (Reviews stays as a fallback — not counted as orphan)
for dir in PRDs Research Decisions Strategy Measurements; do
  if [ -d "$WORK_DIR/$dir" ]; then
    COUNT=$(find "$WORK_DIR/$dir" -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
    ORPHAN_COUNT=$((ORPHAN_COUNT + COUNT))
  fi
done

# ---------------------------------------------------------------------------
# Emit a SESSION-START DIRECTIVE that forces the agent to surface /tidy as
# its first user-facing action. Passive phrasing ("Consider running /tidy")
# was being silently absorbed by the LLM as background context — see
# https://github.com/gnurio/pm-os/issues/8.
#
# Args:
#   $1 — the situation summary (what drifted, e.g. "28 files modified")
# ---------------------------------------------------------------------------
emit_directive() {
  local summary="$1"
  printf '{"additional_context": "[SESSION-START DIRECTIVE — /tidy drift] %s. Per the Non-Negotiable Rules in AGENTS.md and before substantively answering the user, your FIRST user-facing action MUST be to ask: \\"Your Context files are out of sync (%s). Want me to run /tidy now? (y/n)\\". If the user says yes, read skills/pm-os-tidy/SKILL.md and execute /tidy before continuing with their original request. If the user declines, acknowledge briefly and proceed — do NOT loop or re-offer /tidy later in this session."}\n' "$summary" "$summary"
}

# ---------------------------------------------------------------------------
# If /tidy has never run, only nudge when there's something to tidy
# ---------------------------------------------------------------------------
if [ ! -f "$STATE_FILE" ]; then
  TOTAL_FILES=$(find "$WORK_DIR" -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$TOTAL_FILES" -gt 0 ]; then
    if [ "$ORPHAN_COUNT" -gt 0 ]; then
      emit_directive "$(printf '%s orphaned file(s) at 📂 Context/Work/ root or in legacy type folders, and /tidy has never run' "$ORPHAN_COUNT")"
    else
      emit_directive "$(printf '%s file(s) in 📂 Context/Work/ and /tidy has never run' "$TOTAL_FILES")"
    fi
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Orphans always warrant a nudge, regardless of last-run time
# ---------------------------------------------------------------------------
if [ "$ORPHAN_COUNT" -gt 0 ]; then
  emit_directive "$(printf '%s orphaned file(s) at 📂 Context/Work/ root or in legacy type folders' "$ORPHAN_COUNT")"
  exit 0
fi

# ---------------------------------------------------------------------------
# Time-based staleness check
# ---------------------------------------------------------------------------
LAST_RUN="$(sed -n 's/.*"lastRunAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE_FILE" | sed -n '1p')"
if [ -z "$LAST_RUN" ]; then
  exit 0
fi

to_epoch() {
  local timestamp="$1"
  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$timestamp" "+%s" 2>/dev/null \
    || date -u -d "$timestamp" "+%s" 2>/dev/null \
    || return 1
}

LAST_EPOCH="$(to_epoch "$LAST_RUN" || true)"
if [ -z "$LAST_EPOCH" ]; then
  exit 0
fi

NOW_EPOCH="$(date -u "+%s")"
HOURS_AGO=$(( (NOW_EPOCH - LAST_EPOCH) / 3600 ))

if [ "$HOURS_AGO" -lt "$STALE_HOURS" ]; then
  exit 0
fi

MODIFIED_COUNT=$(find "$WORK_DIR" -name "*.md" -newer "$STATE_FILE" -type f 2>/dev/null | wc -l | tr -d ' ')

if [ "$MODIFIED_COUNT" -gt 0 ]; then
  emit_directive "$(printf '%s file(s) in 📂 Context/Work/ modified since last /tidy run (%s hours ago)' "$MODIFIED_COUNT" "$HOURS_AGO")"
fi
