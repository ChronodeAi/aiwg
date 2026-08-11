---
name: slack-signal
description: >-
  Use when a long, meandering Slack thread needs to become a clear summary — the decisions, the action items with owners, and what's still open — read for *signal* against the reader's role and why they're catching up. Not for an IDEAS-format meeting summary (`meeting-summary`), reconstructing a work conversation's flow (`transcript-insights`), or pulling structured requirements from a discussion (`requirements-from-talk`).
---

# Extract signal from a Slack thread

## Step 1 — Frame the read

Get the thread plus why they're reading it and their role in it — decision-maker, contributor, or FYI. The purpose decides what counts as signal for this reader.

Done when the thread, the reader's reason for reading, and their role are known.

## Step 2 — Pull the decisions

List what was decided: the outcome, who decided, and whether it's locked or still being debated. A "maybe" or an unresolved debate is not a decision — mark it open.

Done when every decision names its outcome and decider and is marked locked or still-debated.

## Step 3 — Pull the action items

List each action as a checklist item with an owner and a deadline. Flag any that are unassigned or undated — including implied ones ("someone should…") that no one picked up.

Done when every action has an owner and deadline or is explicitly flagged unassigned/undated.

## Step 4 — Open questions and hanging concerns

List the questions raised but never answered, and the concerns raised — noting for each whether it got addressed or is still hanging.

Done when every unanswered question and unaddressed concern is listed, with who raised it.

## Step 5 — TL;DR and the reader's next step

Write a 2–3 sentence bottom-line-up-front. Then, given the reader's role, name the one thing they need to do — weigh in, own an action, decide — or state plainly that they only need to stay informed.

Done when the TL;DR is 2–3 sentences and the reader's next step (or "informed only") is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-slack-signal-{topic-slug}.md`. Never hand-build the path.

The doc holds: the TL;DR, the decisions (locked or debated), the action items with owners, the open questions and hanging concerns, and the reader's next step.
