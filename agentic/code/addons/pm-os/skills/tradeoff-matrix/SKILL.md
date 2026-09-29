---
name: tradeoff-matrix
description: >-
  Use when you need to communicate a feature request's trade-off visually — place it on a priority×effort *2×2* against real comparisons so stakeholders see why it's worth pursuing, deferring, or rejecting. Not for prioritizing a whole requirements list (`p0-p1-p2`), pricing one scope-change request against a commitment (`scope-defense`), or ranking discovery opportunities (`ost-prioritize`).
---

# Build a priority × effort trade-off matrix

## Step 1 — Get the request, priority, and effort

Capture the stakeholder's ask, its assessed priority, and its assessed effort. If priority or effort isn't given, ask — the matrix is only as honest as those two inputs.

Done when the request has a priority and an effort rating, both sourced or explicitly estimated.

## Step 2 — Place it among comparisons

Put the request on the priority (low/high) × effort (low/high) 2×2, plus 2–3 real other features or initiatives in different quadrants. A request judged alone always looks reasonable; comparison is the point.

Done when the request and 2–3 comparison items are placed on the 2×2.

## Step 3 — Explain each placement

For every item, state its benefits, its drawbacks or opportunity cost, and why it sits in that quadrant.

Done when every placed item has a one-line benefit, drawback, and placement reason.

## Step 4 — Test for a cheaper path

Ask whether a lower-effort option would address the same underlying need, and name it if so — a high-effort request often hides a low-effort alternative.

Done when a cheaper alternative is named or its absence is stated.

## Step 5 — Recommend

Recommend pursue, defer, or reject, with the reason tied to the quadrant and the comparison, plus the next step.

Done when the recommendation is pursue/defer/reject with a quadrant-grounded reason and a next step.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-tradeoff-matrix-{request-slug}.md`. Never hand-build the path.

The doc holds: the 2×2 with the request and comparisons placed, the per-item explanations, the cheaper alternative (or its absence), and the pursue/defer/reject recommendation.
