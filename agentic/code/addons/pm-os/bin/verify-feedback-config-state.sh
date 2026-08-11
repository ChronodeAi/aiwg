#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBHOOK_URL="https://script.google.com/macros/s/AKfycbw7sDP_QG-DdPPsoMWTaGJkqqvEBrXlw2EbhHbW1iWzguD2I5_H069bJaTnBl5Oba3rHg/exec"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local text="$2"
  local contents
  contents="$(<"$file")"
  [[ "$contents" == *"$text"* ]] || fail "$file does not contain expected text: $text"
}

assert_not_contains() {
  local file="$1"
  local text="$2"
  local contents
  contents="$(<"$file")"
  [[ "$contents" != *"$text"* ]] || fail "$file contains forbidden text: $text"
}

assert_missing() {
  local file="$1"
  [[ ! -e "$file" ]] || fail "$file should not exist"
}

feedback_config="$ROOT/feedback-config.md"
[[ -f "$feedback_config" ]] || fail "feedback-config.md is missing"

assert_contains "$feedback_config" "webhook_url: $WEBHOOK_URL"
assert_contains "$feedback_config" "Google Apps Script endpoint — writes directly to the owner's Google Sheet."
assert_contains "$feedback_config" "The URL is the secret. No additional auth needed."
assert_contains "$feedback_config" "*This file is committed to the repo. Purchasers can see it — that's fine for a private repo.*"
assert_not_contains "$feedback_config" 'webhook_url: ""'
assert_not_contains "$feedback_config" "feedback-config.local.md"

assert_missing "$ROOT/feedback-config.local.md"
assert_missing "$ROOT/_internal/feedback-config.md"

assert_not_contains "$ROOT/.gitignore" "feedback-config.local.md"

for file in \
  "$ROOT/skills/pm-os-feedback/SKILL.md" \
  "$ROOT/skills/pm-os-testimonial/SKILL.md" \
  "$ROOT/skills/pm-os-start/SKILL.md"
do
  assert_not_contains "$file" "feedback-config.local.md"
  assert_not_contains "$file" "blank, missing, or placeholder-only"
done

assert_contains "$ROOT/skills/pm-os-feedback/SKILL.md" 'Read `feedback-config.md` to get `webhook_url`.'
assert_contains "$ROOT/skills/pm-os-testimonial/SKILL.md" 'Read `feedback-config.md` to get `webhook_url`.'

# pm-os-start's phase-by-phase telemetry pings live partly in SKILL.md (the
# entry-menu import ping, always inline) and partly in its disclosed
# references/onboarding-phases.md (the 4 per-phase pings — progressive
# disclosure, #114 skill-contract sweep) — count across both.
start_reads=0
needle='Read `feedback-config.md` to get `webhook_url`.'
for f in \
  "$ROOT/skills/pm-os-start/SKILL.md" \
  "$ROOT/skills/pm-os-start/references/onboarding-phases.md"
do
  text="$(<"$f")"
  while [[ "$text" == *"$needle"* ]]; do
    start_reads=$((start_reads + 1))
    text="${text#*"$needle"}"
  done
done

[[ "$start_reads" == "5" ]] || fail "pm-os-start should read feedback-config.md in 5 setup phases across SKILL.md + references/; got $start_reads"

echo "OK: feedback config matches original telemetry-enabled state"
