#!/usr/bin/env bash
# Guard: the three version strings PM OS ships must all agree.
#
# Why this exists:
#   PM OS records its version in three places, but only two were ever bumped:
#     - .claude-plugin/plugin.json  (.version)      — canonical, bumped by hand
#     - .claude-plugin/marketplace.json           (.metadata.version) — bumped by hand
#     - VERSION                                    (plain text)    — nobody remembered it
#   The VERSION file is copied verbatim into the Cursor distribution
#   (bin/build-cursor-zip.sh), so when it drifted to an old value every Cursor
#   download shipped a stale version string while plugin.json said otherwise.
#   It rotted from 2.0.0-alpha.9 forward before anyone noticed. release.sh
#   writes no version files, so nothing reconciled them.
#
# What it checks:
#   All three strings are byte-equal (VERSION compared without its trailing
#   newline / surrounding whitespace). No semver parsing — exact-match is the
#   right grain: any divergence is a bug regardless of which is "ahead".
#
# How to fix when it fails:
#   Bump ALL THREE to the same value when cutting a release:
#     1. .claude-plugin/plugin.json  → .version
#     2. .claude-plugin/marketplace.json           → .metadata.version
#     3. VERSION                                   → the bare version string
#
# Exit codes:
#   0 — all three versions match
#   1 — a mismatch was found (printed to stderr)
#   2 — environment problem (jq missing, file missing, not in a repo)

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not found (brew install jq / apt install jq)" >&2
  exit 2
fi

REPO_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION_FILE="VERSION"
PLUGIN_JSON=".claude-plugin/plugin.json"
MARKETPLACE_JSON=".claude-plugin/marketplace.json"

for f in "$VERSION_FILE" "$PLUGIN_JSON" "$MARKETPLACE_JSON"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: expected version file not found: $f" >&2
    exit 2
  fi
done

# Trim whitespace/newline from the plain-text VERSION file.
version_file="$(tr -d '[:space:]' < "$VERSION_FILE")"
plugin_version="$(jq -r '.version // empty' "$PLUGIN_JSON")"
marketplace_version="$(jq -r '.metadata.version // empty' "$MARKETPLACE_JSON")"

if [ -z "$plugin_version" ]; then
  echo "ERROR: $PLUGIN_JSON has no .version field" >&2
  exit 2
fi
if [ -z "$marketplace_version" ]; then
  echo "ERROR: $MARKETPLACE_JSON has no .metadata.version field" >&2
  exit 2
fi

if [ "$version_file" = "$plugin_version" ] && [ "$plugin_version" = "$marketplace_version" ]; then
  echo "OK: version $plugin_version consistent across VERSION, plugin.json, marketplace.json"
  exit 0
fi

cat >&2 <<MSG
ERROR: PM OS version strings disagree.

  $VERSION_FILE                 = $version_file
  $PLUGIN_JSON   = $plugin_version
  $MARKETPLACE_JSON = $marketplace_version

Bump ALL THREE to the same value:
  1. $PLUGIN_JSON  → .version
  2. $MARKETPLACE_JSON  → .metadata.version
  3. $VERSION_FILE  → the bare version string
MSG
exit 1
