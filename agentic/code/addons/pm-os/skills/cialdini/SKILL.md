---
name: cialdini
description: >-
  Use when a meeting has multiple attendees who each need a different
  influence approach — a hidden-agenda map (or a single target and goal)
  in, a Cialdini-principle-based strategy out, tailored per attendee to
  their specific motivation. Also `/meeting` Step 2, taking Step 1's hidden
  agenda map as input. Not for surfacing what attendees actually want first
  (`hidden-agendas`), analyzing your own delivery afterward
  (`leadership-presence`), or restructuring what you say for clarity
  (`pyramid-principle`).
---

# Tailor an influence lever to each attendee's real motivation

## Step 1 — Take the attendee motivations

Get the hidden-agenda map (each attendee with their likely underlying motivation, fear, or objective) — or, standalone, a single influence target and goal.

Done when every attendee in scope has a stated motivation, fear, or objective to work from.

## Step 2 — Pick the matching principle per attendee

For each attendee, choose the Cialdini principle(s) — reciprocity, commitment, social proof, authority, liking, scarcity, unity — that fit their specific motivation from Step 1. Not every principle for every person; pick what actually applies.

Done when every attendee has one or two chosen principles, each justified by their specific motivation, not applied generically.

## Step 3 — Draft the tactic

For each attendee, write one specific, ethical tactic using their chosen principle(s) — concrete enough to say or do in the room, not an abstract description of the principle.

Done when every attendee has a specific, sayable tactic, and none of them read as manipulative rather than value-creating.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-cialdini-{meeting-slug}.md`. Never hand-build the path.

The doc holds: the influence strategy per attendee, each with its chosen principle(s) and specific tactic.
