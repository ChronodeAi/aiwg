---
name: product-design-analyzer
description: >-
  Use when evaluating an existing product design or mockup — screenshots plus
  context (goals, users, metrics) in, a structured critique out across
  issues, optimization opportunities, alternatives, and pros/cons, each claim
  tied to a stated goal or named UX principle. Not for generating new design
  ideas from a blank challenge (`affordances-signifiers`), correcting UX
  vocabulary in written requirements (`ux-terminology`), or reviewing a
  written document (`/review`).
---

# Critique a product design against its stated goals

## Step 1 — Gather inputs

Collect screenshots or mockups of the design, plus context: the product's goals, target users, and success metrics. Request whichever is missing.

Done when both screenshots and goal/user/metric context are in hand.

## Step 2 — Critique across four dimensions

For each screen or flow, work through:
- **Issues & limitations** — usability problems, visual inconsistencies, accessibility gaps
- **Optimization opportunities** — changes that move the stated metrics
- **Alternative approaches** — different UX patterns, layouts, or flows worth considering
- **Pros & cons** — what the current design already gets right, weighed against its costs

Every claim ties to a stated goal/metric or a named UX principle — never bare preference.

Done when all four dimensions are covered for every screen in scope, and no claim lacks a stated reason.

## Step 3 — Prioritize and deliver

Rank findings by impact on the stated metrics, not by volume. Lead with the highest-impact 3-5 before the full list.

Done when the top 3-5 findings are identified and ranked ahead of the rest.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-design-critique-{design-slug}.md`. Never hand-build the path.

The doc holds: the four-dimension analysis per screen, and the prioritized top findings.
