---
name: motivation-journal
description: >-
  Use when a PM wants to track what actually energizes them at work versus
  what they think "should" motivate them, entry over entry, to find the
  real pattern. Takes a new entry, and prior entries if this is a recurring
  practice. Not for one-time ADHD task motivation (`adhd-motivation`), a
  life-satisfaction pattern across years (`life-design-mapping-exercise`),
  or a founder's execution plan (`founder-focus`).
---

# Separate genuine energy from perceived "shoulds"

## Step 1 — Take the new entry

Get the new journal entry, and any prior entries if this is a recurring practice.

Done when the new entry is in hand, and prior entries are either included or confirmed absent.

## Step 2 — Separate signal from noise

In the entry, identify: what activities are mentioned, the actual emotional response to each, any stated "should" or expectation, and which moments show genuine enthusiasm versus drain.

Done when every activity in the entry is tagged as genuine energy, drain, or a "should" with no real feeling behind it.

## Step 3 — Compare against prior entries

If prior entries exist, note what's consistent, what's changed, and any pattern in what genuinely energizes this person over time.

Done when a pattern is named across entries, or the entry is confirmed as the first with no pattern yet available.

## Step 4 — Ask reflection questions

Pose 2-3 questions specific to what Steps 2-3 surfaced, not generic journaling prompts.

Done when 2-3 questions are asked, each tied to a specific finding from this entry.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-motivation-journal.md`, appending to the existing file if one exists for this recurring practice. Never hand-build the path.

The doc holds: the entry's signal/noise breakdown, the cross-entry pattern, and the reflection questions.
