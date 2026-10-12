#!/usr/bin/env bash
# check-skill-contract.sh — burn-down ratchet for the skill quality pass 2 contract.
#
# Why this exists: the registry validator only checked that a description
# *contained* "Use when" anywhere, so 174+ skills drifted from the modern
# contract while CI stayed green. This measures conformance and fails CI if
# it gets WORSE, while the "skill quality pass 2" GitHub issues burn it down
# to zero. Sibling-slug *resolution* (do the pointers point at real skills)
# is a hard invariant, not ratcheted — see bin/validate-skill-registry.sh.
#
# What it counts, per pm-os-provenance skill in registry/skills.json:
#   USE_WHEN_PREFIX  — description does not start with "Use when " (skipped
#                       for slugs in bin/skill-contract-exempt-full.txt)
#   SIBLING_POINTERS — description lacks a well-formed 2-4 `` `slug` ``
#                       "Not for ..." pointer block (skipped for slugs listed
#                       in bin/skill-contract-exempt.txt or
#                       bin/skill-contract-exempt-full.txt — workflow
#                       orchestrators and pm-os-* system skills have no peer
#                       to point at)
#   DONE_WHEN        — SKILL.md body has no "Done when" step criterion
#                       (skipped for slugs in bin/skill-contract-exempt-full.txt)
#
# How to fix when it fails:
#   Rewrite the named skill(s) to the pass-2 contract (see the
#   writing-great-skills framework), regenerate the registry
#   (bin/generate-skill-registry.sh), then rerun this script. If the count
#   went down, lock it in: bash bin/check-skill-contract.sh --update
#   and commit bin/skill-contract-baseline.txt.
#
# Usage:
#   bash bin/check-skill-contract.sh              # check against baseline
#   bash bin/check-skill-contract.sh --update      # rewrite baseline to current counts
#   bash bin/check-skill-contract.sh --root <dir>  # for tests
#
# Exit codes:
#   0 — no rule regressed (or --update succeeded)
#   1 — at least one rule's failing-count exceeds its baseline

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPDATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$(cd -P "$2" && pwd)"; shift 2 ;;
    --update) UPDATE=1; shift ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT"

REGISTRY="registry/skills.json"
BASELINE="bin/skill-contract-baseline.txt"
EXEMPT="bin/skill-contract-exempt.txt"
EXEMPT_FULL="bin/skill-contract-exempt-full.txt"

[ -f "$REGISTRY" ] || { echo "ERROR: $REGISTRY missing" >&2; exit 1; }

json_field() {
  local line="$1" field="$2"
  printf '%s\n' "$line" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

registry_entries() {
  awk '
    /{/ { in_obj = 1; obj = "" }
    in_obj {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      obj = obj " " $0
    }
    /}/ && in_obj {
      print obj
      in_obj = 0
    }
  ' "$1"
}

is_full_exempt() {
  local slug="$1"
  [ -f "$EXEMPT_FULL" ] || return 1
  grep -qxF "$slug" "$EXEMPT_FULL" 2>/dev/null
}

is_exempt() {
  local slug="$1"
  is_full_exempt "$slug" && return 0
  [ -f "$EXEMPT" ] || return 1
  grep -qxF "$slug" "$EXEMPT" 2>/dev/null
}

fail_use_when=0
fail_pointers=0
fail_done_when=0
off_use_when=()
off_pointers=()
off_done_when=()

while IFS= read -r entry; do
  slug="$(json_field "$entry" slug)"
  provenance="$(json_field "$entry" provenance)"
  path="$(json_field "$entry" path)"
  [ "$provenance" = "pm-os" ] || continue

  # Rule 1: description starts with "Use when ". Pattern-matched against the
  # whole entry line, never json_field's captured $description — json_field's
  # [^"]* capture truncates at the first literal `"` inside the description
  # (35 of 240 today), which would silently cut off the "Not for" tail too.
  if ! is_full_exempt "$slug"; then
    case "$entry" in
      *'"description":"Use when '*) ;;
      *) fail_use_when=$((fail_use_when + 1)); off_use_when+=("$slug") ;;
    esac
  fi

  # Rule 2: 2-4 backticked sibling pointers after the LAST "Not for " —
  # anchoring on the last occurrence (not a sentence split) matters because
  # some descriptions end a prior sentence with a literal `."`.
  if ! is_exempt "$slug"; then
    case "$entry" in
      *"Not for "*)
        tail="${entry##*Not for }"
        n="$(printf '%s' "$tail" | grep -o '`[a-z0-9][a-z0-9-]*`' | wc -l | tr -d '[:space:]')"
        if [ "$n" -lt 2 ] || [ "$n" -gt 4 ]; then
          fail_pointers=$((fail_pointers + 1)); off_pointers+=("$slug")
        fi
        ;;
      *) fail_pointers=$((fail_pointers + 1)); off_pointers+=("$slug") ;;
    esac
  fi

  # Rule 3: body has a "Done when" step criterion.
  if ! is_full_exempt "$slug"; then
    if [ -n "$path" ] && [ -f "$path" ] && grep -Fq "Done when" "$path"; then
      :
    else
      fail_done_when=$((fail_done_when + 1)); off_done_when+=("$slug")
    fi
  fi
done < <(registry_entries "$REGISTRY")

if [ "$UPDATE" = 1 ]; then
  {
    echo "# Burn-down baseline for the skill quality pass 2 contract."
    echo "# CI fails if any measured count exceeds its baseline. Counts may only go down."
    echo "# Regenerate after landing a cluster: bash bin/check-skill-contract.sh --update"
    echo "USE_WHEN_PREFIX=$fail_use_when"
    echo "SIBLING_POINTERS=$fail_pointers"
    echo "DONE_WHEN=$fail_done_when"
  } > "$BASELINE"
  echo "OK: baseline updated ($fail_use_when/$fail_pointers/$fail_done_when)"
  exit 0
fi

base_use_when=0
base_pointers=0
base_done_when=0
if [ -f "$BASELINE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      USE_WHEN_PREFIX) base_use_when="$value" ;;
      SIBLING_POINTERS) base_pointers="$value" ;;
      DONE_WHEN) base_done_when="$value" ;;
      \#*|"") ;;
    esac
  done < "$BASELINE"
fi

REGRESSED=0

check_rule() {
  local name="$1" measured="$2" baseline="$3"
  shift 3
  local offenders=("$@")
  if [ "$measured" -gt "$baseline" ]; then
    REGRESSED=1
    echo "- $name: $measured failing, baseline $baseline (+$((measured - baseline)))" >&2
    local shown=0 s
    for s in "${offenders[@]:-}"; do
      [ -n "$s" ] || continue
      shown=$((shown + 1))
      [ "$shown" -le 20 ] && echo "    $s" >&2
    done
    [ "${#offenders[@]}" -gt 20 ] && echo "    … and $(( ${#offenders[@]} - 20 )) more" >&2
  elif [ "$measured" -lt "$baseline" ]; then
    echo "NOTE: $name improved ($baseline -> $measured). Run 'bash bin/check-skill-contract.sh --update' and commit the baseline."
  fi
}

check_rule "USE_WHEN_PREFIX" "$fail_use_when" "$base_use_when" "${off_use_when[@]:-}"
check_rule "SIBLING_POINTERS" "$fail_pointers" "$base_pointers" "${off_pointers[@]:-}"
check_rule "DONE_WHEN" "$fail_done_when" "$base_done_when" "${off_done_when[@]:-}"

if [ "$REGRESSED" = 1 ]; then
  echo "ERROR: skill contract regressed" >&2
  echo "  Fix the regression, or if intentional: bash bin/check-skill-contract.sh --update" >&2
  exit 1
fi

echo "OK: skill contract burn-down — USE_WHEN_PREFIX $fail_use_when/$base_use_when, SIBLING_POINTERS $fail_pointers/$base_pointers, DONE_WHEN $fail_done_when/$base_done_when"
