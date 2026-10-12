---
name: presentation-narrative
description: >-
  Use when you need the full narrative prose for a persuasive presentation — a three-arc story built from raw material (transcripts, notes, a brief) that ends in a specific buy-in ask. Not for planning the deck for an audience first (`strategic-deck`), a slide-by-slide outline (`problem-deck`), or scripting a product demo (`demo-narrative`).
---

# Write the narrative before the slides

## Step 1 — Get topic, audience, material, and the ask

Ask in one question for: the topic, who's in the room, the raw material to draw from, and the exact thing you want the room to approve. The ask is the destination every arc bends toward.

Done when all four are answered and the ask is a specific action, not "get alignment."

## Step 2 — Mine the material for the spine

Read the raw material and pull the handful of points, data, and quotes that actually move the argument. Discard the rest. Flag anything the ask needs that the material doesn't support.

Done when you have a short list of load-bearing points and every gap against the ask is named.

## Step 3 — Write the three arcs

Write flowing prose, not bullets:
- **Arc 1 — the problem:** open on a situation the room recognizes, then the tension that makes it untenable.
- **Arc 2 — the approach:** your recommendation and why it answers the tension.
- **Arc 3 — benefits and the ask:** what changes if they say yes, then the buy-in request stated plainly.

Done when each arc reads as continuous prose, builds on the one before, and Arc 3 closes on the exact ask from Step 1.

## Step 4 — Tailor and mark the visuals

Pass through once for the audience: adjust language, swap in examples they'll recognize, cut depth they don't need. Drop `[VISUAL]` markers where a chart or screenshot would carry a point better than words.

Done when the tone matches the audience and every claim that begs for evidence has a `[VISUAL]` marker.

## Step 5 — Size to the deck and hand off

Aim the narrative at roughly 10–15 slides. If it overflows, cut a supporting point rather than compress the arcs. Then hand the prose to the build step to split into slides.

Done when the narrative fits ~10–15 slides and the next build step is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-presentation-narrative-{topic-slug}.md`. Never hand-build the path.

The doc holds: the four inputs, the mined spine and gaps, the three-arc prose with `[VISUAL]` markers, and the buy-in ask.
