---
name: vision-to-okrs
description: >-
  Use when a vision or mission statement needs converting into a formal
  quarterly OKR set — objectives that are ambitious and qualitative, key
  results that are quantitative and tied to a real product milestone. Not
  for bridging a vision into a this-quarter execution plan with design
  principles (`vision-to-quarter`), or the underlying strategy the vision
  serves (`strategy-kernel`).
---

# Convert vision into objectives with measurable key results

## Step 1 — Take the vision

Get the vision or mission statement.

Done when the vision statement is in hand.

## Step 2 — Break into key themes

Pull 3-5 key themes from the vision — the main components of what it's actually asking the org to become or achieve.

Done when 3-5 themes are named, each traceable to a specific part of the vision statement.

## Step 3 — Write objectives per theme

For each theme, write 1-2 objectives: ambitious, qualitative, action-oriented, and scoped to one quarter.

Done when every theme has 1-2 objectives, each stated as an action, not a metric.

## Step 4 — Write key results per objective

For each objective, write 2-4 key results: quantitative, specific, time-bound, and tied to a real product milestone — not a vanity number disconnected from actual work.

Done when every objective has 2-4 key results, each with a specific number or threshold and a named milestone it maps to.

## Step 5 — Check the trace back to vision

For each theme's OKRs, confirm the line back to the original vision is explicit, not assumed.

Done when every key area's OKRs have a stated one-line connection to the vision statement they serve.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-vision-to-okrs-{quarter-slug}.md`. Never hand-build the path.

The doc holds: the OKRs organized by key theme, and the vision-trace explanation for each.
