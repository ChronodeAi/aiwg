---
name: meeting-summary
description: >-
  Use when you have a meeting transcript or notes and need a structured, skimmable summary in the *IDEAS* format — Insights, Decisions, Engagements, Actions, Summary — with an owner and a date on every action. Also /meeting Step 3. Not for reconstructing a work conversation's flow and open threads (`transcript-insights`), JTBD analysis of a customer interview (`interview-insights`), or extracting structured requirements (`requirements-from-talk`).
---

# Summarize a meeting with the IDEAS framework

## Step 1 — Insights

List the main realizations or important points raised — what the room now knows that it didn't before. Each must trace to a moment in the transcript, not be inferred to sound smart.

Done when each insight is a real point from the meeting, not an invented takeaway.

## Step 2 — Decisions

List what was actually **decided**. Keep this separate from what was merely discussed — mark anything raised-but-not-resolved as open, so a maybe never reads as settled.

Done when every decision is one the meeting actually reached, and undecided items are marked open rather than listed as decisions.

## Step 3 — Engagements

List the ongoing responsibilities people took on — who owns what going forward. These are commitments (a role, an area), distinct from one-off next steps, and each names a person.

Done when every engagement names a person and is a standing commitment, not a single task.

## Step 4 — Actions

List the immediate next steps. Each carries an **owner and a due date** — an action with no owner is a wish, and one with no date never happens.

Done when every action has a named owner and a due date.

## Step 5 — Summary

Write 2–3 sentences on the meeting's upshot: what it moved and why it matters. No new information — just the through-line.

Done when the summary is 2–3 sentences and introduces nothing not already in the four sections above.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-meeting-summary.md`. Never hand-build the path.

The doc holds the five IDEAS sections: insights and decisions traced to the meeting (open items marked open), engagements with owners, actions with owner and date, and the short summary.
