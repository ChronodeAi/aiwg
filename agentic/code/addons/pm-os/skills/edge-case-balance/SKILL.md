---
name: edge-case-balance
description: >-
  Use when one specific edge case (typically from support or QA) needs a
  fix that doesn't overcomplicate the core product for everyone else — a
  scenario in, a recommended solution out, scored against the complexity
  tax it adds to the main experience. Not for sweeping a brief for the full
  set of edge cases upfront (`ux-edge-cases`), or turning the fix into
  testable QA acceptance criteria (`ui-acceptance-criteria`).
---

# Solve one edge case without taxing the core experience

## Step 1 — Frame the edge case

Name the core issue, why it's rare but still critical (who's affected, how often, what happens if it's ignored), and the specific trigger condition.

Done when the core issue, its frequency/impact, and its trigger are all named.

## Step 2 — Generate candidate solutions

Produce at least 3 approaches spanning minimal change (a copy tweak, a fallback message) to full redesign, each with a one-line description of the mechanism.

Done when at least 3 solutions are listed spanning minimal to comprehensive.

## Step 3 — Score the tax

For each candidate, state the tax it adds to the core experience (new UI, added complexity, performance cost, maintenance burden) against how completely it resolves the edge case.

Done when every candidate has both a stated tax and a stated resolution completeness.

## Step 4 — Recommend and detail

Pick the lowest-tax solution that still resolves the edge case, and give the implementation detail: UI changes, backend changes, and the hardest part of building it.

Done when one solution is recommended with its tax justified against the rejected alternatives, plus implementation detail.

## Step 5 — Plan the user communication

If users need to know about the change, draft what to say and where (docs, in-app notice, onboarding) — skip this step explicitly if no communication is needed.

Done when user communication is either drafted or explicitly marked unnecessary.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-edge-case-balance-{scenario-slug}.md`. Never hand-build the path.

The doc holds: the framed edge case, the scored candidates, the recommendation with implementation detail, and the user communication plan.
