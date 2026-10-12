---
name: requirements-from-design
description: >-
  Use when you have wireframes, mockups, or a Figma export and need
  requirements reverse-engineered from what's actually shown — every visible
  element, layout, and interaction turned into a requirement with acceptance
  criteria a junior engineer could build from. Also /prd Step 1b, one of
  three input modes. Not for a transcript instead of a design
  (`requirements-from-talk`), Cockburn-style use cases (`use-cases`), or UI
  acceptance criteria on stories that already exist (`ui-acceptance-criteria`).
---

# Extract requirements from a design asset

A design shows what to build without ever stating it as a requirement. This skill inventories what's actually in the image, then writes each item as a requirement with acceptance criteria specific enough to implement without a follow-up question.

Inside `/prd` this is Step 1b. Standalone, gather the design asset and any product context that clarifies what's out of frame.

## Step 1 — Inventory what's shown

Examine the design asset. Note every distinct visual element, layout choice, and implied interaction — real state changes and user actions, not just static appearance.

Done when every distinct element and interaction visible in the asset is inventoried.

## Step 2 — Turn each into a requirement

Write one numbered requirement per inventoried item — actionable, measurable, and phrased as *what* the feature does, not *how* it's rendered.

Done when every inventoried item has exactly one numbered requirement, phrased as behavior, not pixels.

## Step 3 — Write acceptance criteria

For each requirement, specify layout, interaction, and any business rule inferable from the design — detailed enough that no ambiguity is left for the engineer to guess at.

Done when every requirement has acceptance criteria specific enough to implement without asking a follow-up question.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-requirements-from-design-{project-slug}.md`. Never hand-build the path.

The doc holds: the numbered requirements list and the acceptance criteria for each.
