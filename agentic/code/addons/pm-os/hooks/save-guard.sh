#!/usr/bin/env bash
# save-guard.sh — PreToolUse hook (Write tool) for Claude Code.
#
# Issue #35, phase 3. When the agent is about to Write a document into the
# Context namespace at a non-canonical path, this hook rewrites the path to the
# canonical project folder BEFORE the write happens (via
# hookSpecificOutput.updatedInput.file_path) and tells the agent the path it
# actually used (additionalContext). The decision is delegated to the shared
# engine bin/memory/relocate-into-canonical.sh in --compute mode (no filesystem
# mutation — the file has not been written yet).
#
# Posture: best-effort and fail-open. If anything is missing or uncertain the
# hook emits nothing and exits 0, so the write proceeds unchanged; any residual
# drift is caught later by the /tidy sweep. It NEVER blocks a write.
#
# Registered for the Write matcher only (Edit/MultiEdit operate on an existing
# path and must not be redirected mid-edit).

set -euo pipefail

# jq is required to safely parse the (untrusted) tool payload and to emit JSON
# whose string values may contain quotes, spaces, or the 📂 emoji. No jq → no-op.
command -v jq >/dev/null 2>&1 || exit 0

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
ENGINE="$PROJECT_ROOT/bin/memory/relocate-into-canonical.sh"
[ -f "$ENGINE" ] || exit 0

payload="$(cat)"
[ -n "$payload" ] || exit 0

tool="$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null || true)"
[ "$tool" = "Write" ] || exit 0

file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
[ -n "$file_path" ] || exit 0

engine_out="$(bash "$ENGINE" --root "$PROJECT_ROOT" --path "$file_path" --compute --json 2>/dev/null || true)"
[ -n "$engine_out" ] || exit 0

status="$(printf '%s' "$engine_out" | jq -r '.status // empty' 2>/dev/null || true)"
to="$(printf '%s' "$engine_out" | jq -r '.to // empty' 2>/dev/null || true)"

# Only act on a verified redirect to a canonical Work path (S11). Anything else
# (allowed / out_of_scope / error / empty target) → leave the write untouched.
[ "$status" = "redirect" ] || exit 0
[ -n "$to" ] || exit 0
case "$to" in
  *"/📂 Context/Work/"*) ;;
  *) exit 0 ;;
esac

# Ensure the canonical destination directory exists before redirecting the write
# there. The engine's --compute mode never creates directories, so a quarantine
# redirect points at `.inbox/` — which is gitignored and absent on clean
# installs — and the Write would otherwise fail for lack of a parent dir. Refuse
# a symlinked destination dir; on any failure, fail open and leave the write
# untouched.
dest_dir="$(dirname "$to")"
[ -L "$dest_dir" ] && exit 0
( umask 077; mkdir -p "$dest_dir" ) 2>/dev/null || exit 0

# Preserve the original tool_input and override only file_path, so the file
# contents (and any other fields) are not dropped regardless of whether the
# runtime merges or replaces tool_input.
msg="[SAVE-GUARD] Redirected this save to its canonical project folder: ${to}. Use that path for any further edits to this document."

printf '%s' "$payload" | jq -c \
  --arg to "$to" \
  --arg msg "$msg" \
  '{
     hookSpecificOutput: {
       hookEventName: "PreToolUse",
       updatedInput: (.tool_input + { file_path: $to }),
       additionalContext: $msg
     }
   }'

exit 0
