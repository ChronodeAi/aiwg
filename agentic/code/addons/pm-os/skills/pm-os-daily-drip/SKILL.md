---
name: pm-os-daily-drip
description: >-
  Use when the user wants to run the opt-in daily context question loop,
  answer a pending question, or says '/daily-drip'. Not for explicit
  one-off capture of a decision or update (`pm-os-capture-memory`) or
  one-time bulk import from another AI assistant (`import-ai-memory`).
---

# /daily-drip

**Drip.** Run the manual daily context drip loop.

Daily drip is a slow-memory feature. Its job is to ask one high-signal question at a time, learn a little useful context, and route the answer to the right memory layer after confirmation.

It is not a scheduler, cron job, notification system, or automatic personal-data collector.

Done when the pending question has been filed to its destination, skipped, or discarded — never left pending while a new one is asked.

## Usage

| Form | What it does |
| --- | --- |
| `/daily-drip` or `/daily-drip ask` | Generate one high-signal question if no answer is pending |
| `/daily-drip answer [text]` | Process the pending question's answer |
| `/daily-drip skip [reason]` | Skip the current/pending question |
| `/daily-drip snooze [date]` | Snooze drip until a future date |
| `/daily-drip stop` | Disable daily drip locally |
| `/daily-drip status` | Show local drip state |

## State

State lives at:

` 📂 Context/Work/.hook-state/daily-drip.json`

Use:

```bash
bash bin/memory/daily-drip-state.sh --status --json
```

No new question may be asked while state is `pending_answer` or `answered_unfiled`.

## Ask Flow

1. Read current daily drip state.
2. If disabled, say it is stopped and explain `/daily-drip` will not ask until re-enabled in a future version.
3. If `pending_answer`, show the pending question again. Do not generate a new one.
4. If `answered_unfiled`, process/file the answer first. Do not generate a new one.
5. Read existing context:
   - `📂 Context/COMPANY.md`
   - `📂 Context/PRODUCTS.md`
   - `📂 Context/GOALS.md`
   - `📂 Context/TEAM.md`
   - `📂 Context/CONSTRAINTS.md`
   - `📂 Context/STAKEHOLDERS.md` if present
   - `📂 Context/MY_STYLE.md` if present
   - `📂 Context/Work/.hook-state/user-memory.md` if present
   - active project recall packet if a current project exists
6. Find one useful gap.
7. Ask exactly one question.
8. Save the pending question to local state:
   ```bash
   bash bin/memory/daily-drip-state.sh --ask --question-file "<tmp-question>" --destination "<destination>" --json
   ```

## Question Quality

Good questions:

- Follow from existing context.
- Ask one concrete thing.
- Improve future PM OS behavior.
- Help with working style, stakeholder context, project constraints, recurring preferences, or active goals.

Bad questions:

- Generic preferences with no product value.
- Multiple questions at once.
- Sensitive personal questions without prior signal.
- Filler asked only because a day passed.

If there is no good question, offer one good-PM principle instead (below) — or skip the day entirely if even that would be noise.

## Principle Drip

Read `📂 Context/Work/.hook-state/coaching-settings.json` first (missing → treat as `soft`). If `intensity` is `off`, skip this entirely — no principle, no mention of it being skipped.

Otherwise, when the ask flow finds no useful context gap, surface exactly one *Principle* line from the catalog in `skills/good-pm-bad-pm/SKILL.md`, chosen for relevance to the user's active project or recent work — variety over repetition, no rotation index, no state change. One line, no lecture, then proceed with the user's request. Optionally do the same after filing an answer that clearly touches a catalog theme (e.g. a goal filed with no success metric → the follow-up principle).

## Answer Processing

When the user answers:

1. Read the pending question and destination from state.
2. Summarize the answer minimally.
3. Decide the destination:
   - stable working preference or small personal fact → `📂 Context/Work/.hook-state/user-memory.md`
   - project-specific decision/risk/assumption/open question → `/capture-memory` candidate event
   - uncertain/sensitive answer → ask before saving or skip
4. Do not ask a new question until the answer is filed, skipped, or discarded.
5. After filing, clear state:
   ```bash
   bash bin/memory/daily-drip-state.sh --filed --filed-event-id "<id-or-profile-update>" --json
   ```

## Safety Rules

- No automatic persistence of sensitive answers.
- No raw transcript or raw chat capture.
- No network calls.
- No scheduler in Phase 3.
- No new question while an answer is pending or unfiled.
- Prefer skipping over asking generic filler.
