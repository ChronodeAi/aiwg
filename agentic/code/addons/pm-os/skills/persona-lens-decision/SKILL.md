---
name: persona-lens-decision
description: >-
  Use when a specific decision or topic needs assessing for how one
  particular user segment would react — reaction, fit, adoption barriers,
  and communication angle, from a third-person analytical lens. Optionally
  takes a `create-empathy-maps` output as input. Not for interactively
  play-acting one customer's first-person voice across arbitrary questions
  (`icp-roleplay`), or general audience psychology not tied to one decision
  (`create-empathy-maps`).
---

# View one decision through a segment's lens

## Step 1 — Take the segment and the decision

Get the user segment (behaviors, goals, workflows, obstacles, vocabulary) and the specific decision or topic to assess. Use a `create-empathy-maps` output if one exists.

Done when the segment is described in behavioral terms (not a demographic label) and the decision is stated specifically.

## Step 2 — Assess reaction, fit, and barriers

For this segment: their likely initial reaction, how the decision fits or conflicts with their daily goals and workflows, what would block adoption, and what would make it land better.

Done when reaction, fit, barriers, and at least one adaptation are all stated, each grounded in a specific behavior or workflow detail from Step 1, not a generic assumption.

## Step 3 — Frame the communication

State how this decision should be presented to this segment specifically — the angle, vocabulary, and channel that would actually resonate.

Done when the communication framing is specific to this segment's vocabulary and channel, not a generic announcement.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-persona-lens-{decision-slug}.md`. Never hand-build the path.

The doc holds: the segment, the reaction/fit/barrier assessment with adaptation, and the communication framing.
