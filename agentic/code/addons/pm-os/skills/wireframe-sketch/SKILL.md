---
name: wireframe-sketch
description: >-
  Use when a product idea needs full flow sketches — multiple screens, the
  user journey between them, and friction points named at each touchpoint.
  Feeds `clickable-prototype` once a screen needs to be testable. Not for
  the single-screen kickoff sketch (`app-design-foundation`), a testable
  HTML prototype (`clickable-prototype`), or translating PM context into
  design constraints (`pm-to-design`).
---

# Sketch the flow across screens, not one screen

## Step 1 — Take the idea and audience

Get the product idea, the target audience, and the specific use case or journey to sketch.

Done when the idea, audience, and the journey's start and end points are all named.

## Step 2 — Sketch each screen in the flow

For each screen in the journey (3-5 typically), describe: its purpose, the key elements and their placement, and how the user arrived here and where they go next.

Done when every screen in the journey has its elements, placement, and entry/exit points described.

## Step 3 — Name the friction at each touchpoint

Across the full flow, identify where a user is likely to hesitate, get confused, or drop off — and what would reduce that friction.

Done when every screen has a named friction point (or is explicitly confirmed frictionless), each with a proposed reduction.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-wireframe-sketch-{flow-slug}.md`. Never hand-build the path.

The doc holds: the screen-by-screen sketches and the friction points with proposed reductions.
