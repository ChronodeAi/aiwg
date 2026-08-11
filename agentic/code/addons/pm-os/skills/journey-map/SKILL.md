---
name: journey-map
description: >-
  Use when you have user behavior data and want the end-to-end customer experience mapped as ordered stages — touchpoints, time spent, friction and delight, and the emotional state at each — to find where the experience breaks. Every stage grounded in data; inferred emotions flagged. Not for redesigning one flow's friction (`friction-reduce`), the first-run activation path (`onboarding-redesign`), or an empathy map of a single persona (`create-empathy-maps`).
---

# Map the customer journey from behavior data

## Step 1 — Order the stages

From the behavior data, list the main stages in chronological order — each a real touchpoint or decision moment the data shows, not a stage you'd expect to be there.

Done when the stages are in order and each is backed by something in the data.

## Step 2 — Quantify each stage

For every stage, give the time spent and the completion/drop metric. Where the data doesn't contain a number, estimate it and mark it estimated — never present a guess as measured.

Done when every stage has a time and a completion figure, each marked real or estimated.

## Step 3 — Mark friction and delight

Per stage, name where users struggle (friction) and where they're satisfied (delight), each backed by a metric or explicitly flagged as an inference.

Done when every friction and delight point cites a metric or is flagged as inferred.

## Step 4 — Trace the emotional curve

Infer the emotional state at each stage from the evidence — feedback, behavior patterns, sentiment. Flag any state you inferred without data. Then name the single **emotional low**.

Done when every stage has an emotional state (inferred ones flagged) and the low point is named.

## Step 5 — Name the opportunities

Pick the 2–3 highest-leverage fixes, anchored on the emotional low and the biggest drop. Each names the stage it targets and the metric it would move.

Done when there are 2–3 opportunities, each tied to a stage and a metric it would move.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-journey-map-{product-slug}.md`. Never hand-build the path.

The doc holds: the ordered stages with touchpoints, time, friction/delight, and emotional state (inferred ones flagged); the named emotional low; and the opportunity shortlist tied to stages and metrics.
