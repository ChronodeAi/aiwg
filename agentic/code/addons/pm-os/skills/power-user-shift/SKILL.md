---
name: power-user-shift
description: >-
  Use when retained users need a transition plan from a low-frequency use
  case to a high-frequency one — the behavior gap named, adoption
  barriers identified, and a phased rollout with onboarding and metrics.
  Not for winning back users who already left (`churn-reduction`), or the
  broader growth-loop diagnosis (`growth-strategy`).
---

# Close the gap between occasional use and habitual use

## Step 1 — Take the current and target use case

Get the product description, the current low-frequency use case, and the target high-frequency use case.

Done when the product, current use case, and target use case are all named specifically.

## Step 2 — Name the gap and the barriers

Identify what motivates more frequent engagement, and what specifically blocks users from adopting the target use case today.

Done when at least one motivator and one concrete adoption barrier are named, not a generic "users are busy."

## Step 3 — Design the transition

Plan the feature introduction sequence, the onboarding/education approach for the new use case, and the communication that highlights the benefit — as a gradual rollout, not an all-at-once switch.

Done when the feature sequence, onboarding approach, and communication plan are all specified, in that rollout order.

## Step 4 — Define success metrics and timeline

Name the metrics that would show the shift is working, and a timeline for rollout and evaluation.

Done when metrics and a timeline are both stated, with the metrics directly measuring frequency shift, not a proxy.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-power-user-shift-{product-slug}.md`. Never hand-build the path.

The doc holds: the gap and barriers, the transition plan in rollout order, and the metrics with timeline.
