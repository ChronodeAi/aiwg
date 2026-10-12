#!/usr/bin/env bash
# upgrade.sh — tool-aware PM OS upgrade
#
# Replaces the older migrate.sh. Detects the user's source workspace tool
# (cursor / claude-code / mixed-v2.0-era), validates it matches THIS distribution's
# tool, then merges new system files into the workspace while preserving user data.
#
# Usage:
#   bash bin/upgrade.sh --in-place /path/to/user/workspace [--dry-run]
#   bash bin/upgrade.sh --in-place ./fixture-ws --src ./fixture-dist --dry-run   # for tests
#
# Exit codes:
#   0 — upgrade succeeded (or dry-run completed)
#   1 — usage error
#   2 — wrong-ZIP mismatch (friendly message printed)
#   3 — source workspace is not a PM OS install
#   4 — distribution itself is malformed
#   5 — Codex/AIWG lifecycle required (no files modified)
#
# Zero external dependencies beyond bash 3.2+, cp, rm, find, mkdir, mktemp.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
DRY_RUN=false
USER_WS=""
DIST_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
RELEASE_URL_BASE="https://github.com/gnurio/pm-os/releases/latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in-place) USER_WS="${2:-}"; shift 2 ;;
    --src)      DIST_ROOT="$(cd -P "$2" && pwd)"; shift 2 ;;
    --dry-run)  DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$USER_WS" ] || { echo "ERROR: --in-place <workspace-path> is required" >&2; exit 1; }
[ -d "$USER_WS" ] || { echo "ERROR: workspace path does not exist: $USER_WS" >&2; exit 1; }
USER_WS="$(cd -P "$USER_WS" && pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "  $*"; }
info() { echo "▸ $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ! $*" >&2; }

run() {
  if $DRY_RUN; then
    echo "  [DRY] $*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Detect tool fingerprint of a directory
#   cursor          — has .cursor/ but no .claude-plugin/
#   claude-code     — has .claude-plugin/ (and possibly plugins/) but no .cursor/
#   mixed-v2.0-era  — has both .cursor/ and .claude-plugin/
#   codex-aiwg       — has an AIWG project config and Codex/AIWG bootstrap
#   unknown         — has neither (not a PM OS install)
# ---------------------------------------------------------------------------
detect_tool() {
  local dir="$1"
  local has_cursor=0 has_cc=0
  if [ -f "$dir/.aiwg/aiwg.config" ] && {
    [ -d "$dir/.codex" ] ||
      { [ -f "$dir/AGENTS.md" ] && grep -q '<!-- aiwg-managed -->' "$dir/AGENTS.md"; }
  }; then
    echo "codex-aiwg"
    return
  fi
  [ -d "$dir/.cursor" ]        && has_cursor=1
  [ -d "$dir/.claude-plugin" ] && has_cc=1
  if [ "$has_cursor" = "1" ] && [ "$has_cc" = "1" ]; then echo "mixed-v2.0-era"; return; fi
  if [ "$has_cursor" = "1" ]; then echo "cursor"; return; fi
  if [ "$has_cc" = "1" ];     then echo "claude-code"; return; fi
  echo "unknown"
}

# ---------------------------------------------------------------------------
# Detect distribution tool — same fingerprint, applied to THIS distro.
# The Claude-Code-native distro has .claude-plugin/ but no .cursor/.
# The Cursor-native distro has .cursor/ but no .claude-plugin/.
# (A mixed v2.0-era distro would be malformed at v2.1+.)
# ---------------------------------------------------------------------------
SOURCE_TOOL=$(detect_tool "$USER_WS")
DIST_TOOL=$(detect_tool "$DIST_ROOT")

# Codex installations are deployed by AIWG. The legacy ZIP merger replaces
# whole system directories with rm -rf, so it must never operate on an AIWG
# workspace. This branch is intentionally reached before distribution matching
# and before any write.
if [ "$DIST_TOOL" = "codex-aiwg" ] || [ "$SOURCE_TOOL" = "codex-aiwg" ]; then
  cat >&2 <<EOF

PM OS detected a Codex/AIWG installation.

The legacy ZIP merger is disabled for this workspace, and no files were modified.
Use the AIWG-managed lifecycle instead:

  cd "$USER_WS"
  aiwg doctor --project-local
  aiwg use pm-os --provider codex --dry-run
  aiwg use pm-os --provider codex

Then reload the Codex task so its skill and agent registries are refreshed.
See docs/install-codex.md for migration and verification details.

EOF
  exit 5
fi

case "$DIST_TOOL" in
  claude-code|cursor) : ;;
  *) echo "ERROR: distribution at $DIST_ROOT is malformed (detected: $DIST_TOOL)" >&2; exit 4 ;;
esac

# ---------------------------------------------------------------------------
# Validate source/distribution match; print friendly errors for mismatch.
# ---------------------------------------------------------------------------
friendly_mismatch() {
  local source_tool="$1" dist_tool="$2"
  cat >&2 <<EOF

ERROR: You downloaded the wrong PM OS ZIP.

  Your workspace is set up for: $source_tool
  This distribution is for:     $dist_tool

  → Download pm-os-${source_tool}-X.Y.Z.zip instead from:
    $RELEASE_URL_BASE

  No files were modified.

EOF
  exit 2
}

case "$DIST_TOOL:$SOURCE_TOOL" in
  claude-code:claude-code|claude-code:mixed-v2.0-era) MERGE_MODE="cc" ;;
  cursor:cursor|cursor:mixed-v2.0-era)                MERGE_MODE="cursor" ;;
  claude-code:cursor)                                 friendly_mismatch "cursor"      "claude-code" ;;
  cursor:claude-code)                                 friendly_mismatch "claude-code" "cursor" ;;
  *:unknown)
    echo "ERROR: $USER_WS does not look like a PM OS workspace (no .cursor/ or .claude-plugin/)." >&2
    echo "       If this is a fresh install, just unzip the distribution there — no /upgrade needed." >&2
    exit 3 ;;
  *) echo "ERROR: unhandled combination dist=$DIST_TOOL source=$SOURCE_TOOL" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
info "PM OS upgrade"
log "Source workspace : $USER_WS  (detected: $SOURCE_TOOL)"
log "Distribution     : $DIST_ROOT  (detected: $DIST_TOOL)"
log "Merge mode       : $MERGE_MODE"
$DRY_RUN && log "Mode             : DRY-RUN (no files will be written)"
echo ""

# ---------------------------------------------------------------------------
# System-owned paths that this distribution replaces in the workspace.
# User-owned paths (preserved by virtue of NOT being in this list):
#   📂 Context/<filled-in files>     — user data
#   📂 Context/Work/                 — user output and project memory
#   📂 Context/Work/.hook-state/    — hook state, gitignored
#   Anything else not in this list.
# ---------------------------------------------------------------------------
if [ "$MERGE_MODE" = "cc" ]; then
  SYSTEM_PATHS=(
    "plugins"
    ".claude-plugin"
    "🧠 Knowledge"
    "📄 Templates"
    "💎 Examples"
    "bin"
    "external-skills"
    "AGENTS.md"
    "CLAUDE.md"
  )
else
  SYSTEM_PATHS=(
    ".cursor"
    ".cursor-plugin"
    "🧠 Knowledge"
    "📄 Templates"
    "💎 Examples"
    "bin"
    "external-skills"
    "AGENTS.md"
    "CLAUDE.md"
  )
fi

info "Replacing system files…"
for p in "${SYSTEM_PATHS[@]}"; do
  src="$DIST_ROOT/$p"
  dst="$USER_WS/$p"
  if [ ! -e "$src" ]; then
    log "skip (not in dist): $p"
    continue
  fi
  if [ -e "$dst" ]; then
    log "replace: $p"
    run rm -rf "$dst"
  else
    log "create:  $p"
  fi
  run cp -R "$src" "$dst"
done

# ---------------------------------------------------------------------------
# Mixed-era transition: strip the OTHER tool's surface so the workspace is
# committed to a single tool going forward.
# ---------------------------------------------------------------------------
if [ "$SOURCE_TOOL" = "mixed-v2.0-era" ]; then
  echo ""
  info "Transition: workspace had both Cursor + Claude Code support; converting to ${MERGE_MODE}-only…"
  if [ "$MERGE_MODE" = "cc" ]; then
    for orphan in ".cursor" ".cursor-plugin"; do
      if [ -e "$USER_WS/$orphan" ]; then
        log "strip: $orphan"
        run rm -rf "$USER_WS/$orphan"
      fi
    done
    echo ""
    warn "Your workspace is now Claude Code only. To keep using Cursor, re-run /upgrade with"
    warn "pm-os-cursor-X.Y.Z.zip instead — your Context and Work data will be preserved."
  else
    for orphan in ".claude" ".claude-plugin" "plugins"; do
      if [ -e "$USER_WS/$orphan" ]; then
        log "strip: $orphan"
        run rm -rf "$USER_WS/$orphan"
      fi
    done
    echo ""
    warn "Your workspace is now Cursor only. To keep using Claude Code, re-run /upgrade with"
    warn "pm-os-claude-code-X.Y.Z.zip instead — your Context and Work data will be preserved."
  fi
fi

# ---------------------------------------------------------------------------
# CC-specific: ensure .claude/settings.json carries the marketplace + plugins
# wiring from the distribution, while preserving any user-added MCP servers
# or other keys. Simple merge: new keys override; mcpServers gets deep-merged.
# ---------------------------------------------------------------------------
if [ "$MERGE_MODE" = "cc" ] && [ -f "$DIST_ROOT/.claude/settings.json" ]; then
  echo ""
  info "Wiring .claude/settings.json (marketplace + enabled plugins)…"
  if [ ! -f "$USER_WS/.claude/settings.json" ]; then
    log "create: .claude/settings.json (no existing file)"
    run mkdir -p "$USER_WS/.claude"
    run cp "$DIST_ROOT/.claude/settings.json" "$USER_WS/.claude/settings.json"
  else
    log "merge:  .claude/settings.json (user customizations preserved where possible)"
    if ! $DRY_RUN; then
      if command -v jq >/dev/null 2>&1; then
        tmp="$(mktemp)"
        # Merge user + dist, then drop obsolete pre-consolidation plugin keys
        # (pm-os-core@pm-os and pm-workflows@pm-os) so v2.0/v2.1-alpha.1 users
        # transitioning to the single-plugin layout don't end up with stale
        # entries pointing at directories that no longer exist.
        jq -s '
          (.[0] * .[1])
          | (.enabledPlugins //= {})
          | .enabledPlugins |= (del(."pm-os-core@pm-os", ."pm-workflows@pm-os"))
        ' "$USER_WS/.claude/settings.json" "$DIST_ROOT/.claude/settings.json" > "$tmp" && mv "$tmp" "$USER_WS/.claude/settings.json"
      else
        warn "jq not installed — overwriting .claude/settings.json with distribution defaults"
        cp "$DIST_ROOT/.claude/settings.json" "$USER_WS/.claude/settings.json"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
ok "Upgrade complete."
log "Preserved: 📂 Context/<your files>, 📂 Context/Work/ (incl. .hook-state/), custom plugins/skills."
if $DRY_RUN; then
  log "(dry-run — no files were actually written.)"
fi
echo ""
