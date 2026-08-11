---
name: use-case-map
description: >-
  Use when a problem needs a business-level view before product development
  starts — who has it, what they do instead today, how often, why they'd
  switch, and how long they'd deliberate. Reforge's use-case-map method, a
  market/positioning lens distinct from product-development specs. Not for
  actor-goal-scenario specs for engineering (`use-cases`), or a single
  narrative problem frame (`problem-framing-canvas`).
---

# Map use cases across business dimensions

## Step 1 — Find each distinct use case

From whatever's given — an idea, research, a market — identify each distinct scenario worth its own map. One input can produce several use cases; don't force them into one just for convenience.

Done when every distinct scenario is named as its own use case.

## Step 2 — Map each use case across the six dimensions

For each use case, fill: **Problem** (in the user's own words), **Persona** (specifically, not "users"), **Alternatives** (what they'd do without this product — direct and indirect), **Frequency** (how often, with a real cadence), **Why** (the actual reason they'd pick this over the alternatives), **Consideration Time** (how long they'd deliberate before choosing).

Done when every use case has all six dimensions filled with specifics, none left as placeholders.

## Step 3 — Flag the weakest "why"

Across the set, name whichever use case has the least differentiated "why" against its alternatives — that's the one most likely not to convert, and worth resolving before building.

Done when one use case is named weakest-why with the reasoning stated.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-use-case-map-{project-slug}.md`. Never hand-build the path.

The doc holds: every use case mapped across the six dimensions, and the weakest-why flag.
