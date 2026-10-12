---
name: ux-terminology
description: >-
  Use when a written product requirement uses vague or incorrect UX
  terminology — a requirements doc or excerpt in, each imprecise term
  flagged with the correct UX/interaction term and why it matters, out. Not
  for evaluating a visual design (`product-design-analyzer`), or generating
  new design ideas (`affordances-signifiers`).
---

# Correct UX terminology in written requirements

## Step 1 — Scan for imprecise terms

Read the requirements text and flag every UI/interaction term that's vague, informal, or ambiguous between multiple real UX patterns (e.g. "popup," "button," "dropdown," "sidebar," "hover").

Done when every ambiguous or imprecise term in the text is flagged, with its surrounding sentence quoted.

## Step 2 — Resolve each to a precise term

For each flagged term, determine the specific UX pattern the requirement is actually describing — or, if genuinely ambiguous, name the 2-3 candidates it could be — and state the correction.

Done when every flagged term has either one resolved correction or a named set of 2-3 candidates the author needs to pick between.

## Step 3 — Explain why it matters

For each correction, state the concrete difference it makes — implementation cost, accessibility behavior, or user expectation — not just "more precise."

Done when every correction has a stated concrete consequence, not a vague precision claim.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-ux-terminology-{doc-slug}.md`. Never hand-build the path. If no corrections are needed, state that directly instead of writing a file.

The doc holds: each original term (quoted), its correction, and the concrete consequence.
