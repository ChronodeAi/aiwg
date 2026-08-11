#!/usr/bin/env bash
# drip-reminder.sh — sessionStart hook for Cursor and Claude Code
#
# Surfaces /daily-drip via an imperative [SESSION-START DIRECTIVE] payload,
# matching the pattern proven in tidy-reminder.sh (PR #10, fix #8).
#
# Behavior:
#   - Defers to tidy-reminder: only one nudge directive per session.
#   - Cold-start: state file missing + Context Guard satisfied → introduce /daily-drip.
#   - Stuck states: pending_answer ≥12h since last activity → re-surface; answered_unfiled → file now.
#   - Idle cadence (tapering): tier threshold gated by filed_count, hours since last_activity_at.
#
# The hook never mutates state. bin/memory/daily-drip-state.sh is the only writer.

set -euo pipefail

# Anchor to user's workspace. Prefer Claude Code's CLAUDE_PROJECT_DIR env var
# (set by CC for plugin hooks); fall back to pwd for Cursor / standalone runs.
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# Tunable thresholds (named constants for easy adjustment)
# ---------------------------------------------------------------------------
EARLY_MAX=4              # filed_count 0..EARLY_MAX → ~daily tier
WEEKLY_MAX=14            # filed_count EARLY_MAX+1..WEEKLY_MAX → weekly tier; >WEEKLY_MAX → fortnightly
EARLY_HOURS=20           # ~daily (under 24 so the nudge actually catches the day)
WEEKLY_HOURS=144         # 6 days (under 7)
FORTNIGHTLY_HOURS=312    # 13 days (under 14)
PENDING_REMINDER_HOURS=12

STATE_FILE="📂 Context/Work/.hook-state/daily-drip.json"
COMPANY_FILE="📂 Context/COMPANY.md"
PRODUCTS_FILE="📂 Context/PRODUCTS.md"

# ---------------------------------------------------------------------------
# Tidy back-off — if tidy-reminder.sh would emit a directive this session,
# stay silent. Two competing "FIRST user-facing action" directives is exactly
# the failure mode the imperative pattern is designed to avoid.
# ---------------------------------------------------------------------------
# Sibling hook (CLAUDE_PLUGIN_ROOT points at plugins/core when launched by CC)
HOOK_DIR="$(cd -P "$(dirname "$0")" && pwd)"
TIDY_HOOK="$HOOK_DIR/tidy-reminder.sh"
if [ -x "$TIDY_HOOK" ]; then
  TIDY_OUT="$(bash "$TIDY_HOOK" 2>/dev/null || true)"
  if [ -n "$TIDY_OUT" ]; then
    # Tidy will fire its own directive directly via the hook runner — exit
    # silently so we don't compete for "FIRST user-facing action".
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
state_field() {
  local field="$1"
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$STATE_FILE" | sed -n '1p'
}

state_int_field() {
  local field="$1"
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$STATE_FILE" | sed -n '1p'
}

enabled_value() {
  [ -f "$STATE_FILE" ] || { echo true; return; }
  if grep -q '"enabled"[[:space:]]*:[[:space:]]*false' "$STATE_FILE"; then
    echo false
  else
    echo true
  fi
}

to_epoch() {
  local timestamp="$1"
  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$timestamp" "+%s" 2>/dev/null \
    || date -u -d "$timestamp" "+%s" 2>/dev/null \
    || return 1
}

hours_since() {
  local ts="$1"
  [ -n "$ts" ] || { echo 999999; return; }
  local epoch
  epoch="$(to_epoch "$ts" || true)"
  [ -n "$epoch" ] || { echo 999999; return; }
  local now
  now="$(date -u "+%s")"
  echo $(( (now - epoch) / 3600 ))
}

snooze_still_active() {
  local until="$1"
  [ -n "$until" ] || return 1
  local until_epoch
  until_epoch="$(to_epoch "$until" || true)"
  [ -n "$until_epoch" ] || return 1
  local now
  now="$(date -u "+%s")"
  [ "$now" -lt "$until_epoch" ]
}

tier_threshold_hours() {
  local count="$1"
  if [ "$count" -le "$EARLY_MAX" ]; then
    echo "$EARLY_HOURS"
  elif [ "$count" -le "$WEEKLY_MAX" ]; then
    echo "$WEEKLY_HOURS"
  else
    echo "$FORTNIGHTLY_HOURS"
  fi
}

# Truncate to max chars, then escape backslashes and double quotes for embedding
# in a JSON string. Output goes to stdout.
truncate_for_json() {
  local s="$1"
  local max="${2:-80}"
  if [ "${#s}" -gt "$max" ]; then
    s="${s:0:$max}…"
  fi
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

context_guard_ready() {
  [ -f "$COMPANY_FILE" ] || return 1
  [ -f "$PRODUCTS_FILE" ] || return 1
  if grep -qF "[Company name]" "$COMPANY_FILE" 2>/dev/null; then return 1; fi
  if grep -qF "[Product Name]" "$PRODUCTS_FILE" 2>/dev/null; then return 1; fi
  return 0
}

# ---------------------------------------------------------------------------
# Directive emitters. Four variants, all tagged daily-drip:<scenario> so the
# agent can disambiguate from the tidy directive in logs.
# ---------------------------------------------------------------------------
emit_cold_start() {
  printf '{"additional_context": "[SESSION-START DIRECTIVE — daily-drip:cold-start] Per the Non-Negotiable Rules in AGENTS.md and before substantively answering the user, your FIRST user-facing action MUST be to ask: \\"You haven'"'"'t tried /daily-drip yet — it'"'"'s a slow-memory feature that asks one quick context question per session and gradually fills your PM profile. It runs ~daily early on, then weekly, then fortnightly as the profile fills out. Want me to ask the first question now? (y / n / never)\\". On yes: read skills/pm-os-daily-drip/SKILL.md and execute /daily-drip ask. On never: execute /daily-drip stop to silence this prompt permanently. On no: acknowledge briefly and proceed — do NOT loop or re-offer /daily-drip later in this session."}\n'
}

emit_idle_due() {
  printf '{"additional_context": "[SESSION-START DIRECTIVE — daily-drip:idle-due] Per the Non-Negotiable Rules in AGENTS.md and before substantively answering the user, your FIRST user-facing action MUST be to ask: \\"Mind a quick /daily-drip context-gathering question? (y/n)\\". On yes: read skills/pm-os-daily-drip/SKILL.md and execute /daily-drip ask before continuing with the user'"'"'s original request. On no: acknowledge briefly and proceed — do NOT loop or re-offer /daily-drip later in this session."}\n'
}

emit_pending() {
  local hours="$1"
  local question_excerpt="$2"
  printf '{"additional_context": "[SESSION-START DIRECTIVE — daily-drip:pending] Per the Non-Negotiable Rules in AGENTS.md and before substantively answering the user, your FIRST user-facing action MUST be to ask: \\"You have a /daily-drip question pending from %s hours ago: \\\\\\"%s\\\\\\". Want to answer now, skip, or snooze? (answer/skip/snooze)\\". Read skills/pm-os-daily-drip/SKILL.md to handle whichever choice the user makes (answer → /daily-drip answer; skip → /daily-drip skip; snooze → /daily-drip snooze). Execute that subcommand before continuing with the user'"'"'s original request. Do NOT loop or re-offer /daily-drip later in this session."}\n' "$hours" "$question_excerpt"
}

emit_unfiled() {
  printf '{"additional_context": "[SESSION-START DIRECTIVE — daily-drip:unfiled] Per the Non-Negotiable Rules in AGENTS.md and before substantively answering the user, your FIRST user-facing action MUST be to ask: \\"Your last /daily-drip answer is captured but not yet filed. File it now? (y/n)\\". On yes: read skills/pm-os-daily-drip/SKILL.md and execute /daily-drip filed before continuing with the user'"'"'s original request. On no: acknowledge briefly and proceed — do NOT loop or re-offer /daily-drip later in this session."}\n'
}

# ---------------------------------------------------------------------------
# Decision tree
# ---------------------------------------------------------------------------

# Cold start: state file missing entirely.
if [ ! -f "$STATE_FILE" ]; then
  if context_guard_ready; then
    emit_cold_start
  fi
  # If COMPANY.md / PRODUCTS.md still have placeholders, Context Guard owns
  # the session — let /start finish first.
  exit 0
fi

ENABLED="$(enabled_value)"
[ "$ENABLED" = "true" ] || exit 0

STATUS="$(state_field status)"
[ -n "$STATUS" ] || STATUS="idle"

case "$STATUS" in
  stopped)
    exit 0
    ;;
  snoozed)
    SNOOZE_UNTIL="$(state_field snooze_until)"
    if snooze_still_active "$SNOOZE_UNTIL"; then
      exit 0
    fi
    # Snooze elapsed → fall through to the idle branch (no distinct payload).
    STATUS="idle"
    ;;
esac

LAST_ACTIVITY="$(state_field last_activity_at)"
HOURS_SINCE="$(hours_since "$LAST_ACTIVITY")"

case "$STATUS" in
  pending_answer)
    if [ "$HOURS_SINCE" -ge "$PENDING_REMINDER_HOURS" ]; then
      RAW_Q="$(state_field pending_question)"
      Q_EXCERPT="$(truncate_for_json "$RAW_Q" 80)"
      emit_pending "$HOURS_SINCE" "$Q_EXCERPT"
    fi
    exit 0
    ;;
  answered_unfiled)
    emit_unfiled
    exit 0
    ;;
  idle)
    FILED_COUNT="$(state_int_field filed_count)"
    [ -n "$FILED_COUNT" ] || FILED_COUNT=0
    THRESHOLD="$(tier_threshold_hours "$FILED_COUNT")"
    if [ "$HOURS_SINCE" -ge "$THRESHOLD" ]; then
      emit_idle_due
    fi
    exit 0
    ;;
esac

exit 0
