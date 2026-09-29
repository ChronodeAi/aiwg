#!/usr/bin/env bash
# Guard: user-facing install docs must not contain hardcoded semver strings.
#
# Why this exists:
#   Customer-facing install instructions referenced specific filenames like
#   `pm-os-claude-code-2.1.0-beta.1.zip`. Versions cut every few weeks, but
#   nobody remembers to sweep five `.md` files on each release, so the docs
#   drifted out of sync with what the access link actually offered. Customers
#   then either hit "file not found" looking for last release's filename, or
#   followed a clone command pointing at a private repo. Both happened.
#
# What it scans:
#   README.md and docs/install-*.md only. These are the front-door install
#   surfaces — the ones a customer hits first. Other docs that legitimately
#   reference specific versions (CHANGELOG.md, upgrade.md migration notes,
#   plugin.json, marketplace.json) are intentionally not scanned.
#
# What it flags:
#   Any semver-shaped string `\d+\.\d+\.\d+` with an optional `-suffix`.
#   Single-component numbers like `2024`, `5 minutes`, or `13 system skills`
#   don't match — only the triple-dot semver shape that real version strings
#   take. This is the right grain: it catches the actual rot pattern without
#   false-positive churn on prose.
#
# How to fix when it fails:
#   Replace the literal version with `<version>` (placeholder customers can
#   substitute) or rephrase to "from your access link" / "the latest release
#   page" so the docs stay version-agnostic. If you genuinely need to mention
#   a specific version, put it in CHANGELOG.md instead and link to it from
#   the install doc.
#
# Exit codes:
#   0 — no hardcoded semver strings found in scanned files
#   1 — one or more matches found (printed to stderr)
#   2 — environment problem (not in a git repo, etc.)

set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FILES=("README.md")

if [ -d docs ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && FILES+=("$f")
  done < <(find docs -maxdepth 1 -name 'install-*.md' -type f 2>/dev/null | sort)
fi

PATTERN='[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?'

HITS=""
HITS_COUNT=0

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    HITS_COUNT=$((HITS_COUNT + 1))
    HITS+="  ${f}:${match}"$'\n'
  done < <(grep -nE "$PATTERN" "$f" 2>/dev/null || true)
done

if [ "$HITS_COUNT" -eq 0 ]; then
  echo "OK: no hardcoded semver strings in ${#FILES[@]} user-facing install doc(s)"
  exit 0
fi

cat >&2 <<MSG
ERROR: $HITS_COUNT hardcoded semver reference(s) in user-facing install docs.

$HITS
Fix: replace the literal version with \`<version>\`, or rephrase the line to
reference "your access link" / "the latest release page" so the doc stays
version-agnostic. Version-specific information belongs in CHANGELOG.md.

Files scanned: ${FILES[*]}
MSG
exit 1
