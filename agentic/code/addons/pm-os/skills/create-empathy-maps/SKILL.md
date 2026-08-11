---
name: create-empathy-maps
description: >-
  Use when you need a structured empathy map — thinks, feels, says, does,
  sees, hears, pains, goals — for one audience in relation to one topic,
  surfacing motivations and fears the audience wouldn't state outright.
  Feeds `persona-lens-decision`'s reaction analysis. Not for the end-to-end
  experience across stages (`journey-map`), an actionable task-level persona
  (`user-profile`), or building the first persona from research
  (`proto-persona`).
---

# Map what an audience thinks, feels, and does about a topic

## Step 1 — Take the audience and topic

Get the specific audience and the specific topic or product they're relating to.

Done when both the audience and the topic are named specifically enough to reason about, not "users" or "the product."

## Step 2 — Fill each quadrant

For thinks, feels, says, does, sees, hears, pains, and goals: write 3-5 specific insights per quadrant, grounded in cognitive bias, emotional trigger, or social influence — not a restatement of the topic. No quadrant may duplicate another's insight.

Done when every quadrant has 3-5 distinct insights, none surface-level and none repeated across quadrants.

## Step 3 — Name the key takeaway

Across all eight quadrants, name the one or two insights most likely to change how this audience is approached.

Done when the summary points to specific quadrant insights, not a generic restatement of the map.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-empathy-map-{audience-slug}.md`. Never hand-build the path.

The doc holds: the eight-quadrant map and the key-takeaway summary.
