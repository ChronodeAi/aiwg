---
name: success-metric
description: >-
  Use when a design or product goal is vague — "improve onboarding," "make search better" — and the PM needs one primary metric with a baseline, a target, and *guardrails* before work starts. Not for the full measurement workflow (`/measure`), event-schema design (`tracking-schema`), estimating a feature's impact (`impact-sizing`), or designing the experiment (`experiment-design`).
---

# Define the success metric for a change

## Step 1 — Pin the change and its intended outcome

Ask for: the specific change being made, and what should be different for the user afterward. Push past restated goals — "improve onboarding" is not an outcome; "new users reach their first created project without help" is.

Done when the change is one sentence and the user outcome is one sentence a stranger could observe happening.

## Step 2 — Pick one primary metric

Choose the single number that most directly captures the Step 1 outcome. Behavioral beats stated (completion rate beats satisfaction score) and close-to-the-outcome beats upstream proxy (first-project-created beats signups). Write its exact definition: numerator, denominator, who's counted, over what window. Runner-up candidates go in a supporting list — they inform, they don't decide.

Done when there is exactly one primary metric with numerator, denominator, population, and window all stated.

## Step 3 — Set baseline and target

Get the current value. If nobody knows it, the first deliverable is the baseline measurement — name how and how long. Then set the target and the minimum worth shipping, with the date they're judged on. A target with no baseline is a guess wearing a number.

Done when baseline, minimum, target, and judgment date are all filled — or the baseline-measurement task has a method and an owner.

## Step 4 — Add the guardrails

Ask: how could the primary metric improve while users get worse off? Each answer becomes a guardrail — 2 or 3, each with the harm it catches and the threshold that triggers alarm ("support tickets on checkout +20%," "refund rate above baseline"). A metric pair like faster-checkout/more-refunds is the template.

Done when each guardrail names its harm and its threshold, and at least one guards the users the primary metric doesn't count.

## Step 5 — Make it measurable

List what has to exist for these numbers to arrive: events to instrument with their properties, the tool that captures them, roughly how many users or how long until the result is trustworthy, and who implements each piece. Small products get honesty here: with low traffic, name the wait or choose a coarser metric.

Done when a teammate could set up the measurement from this list alone, and every item has an owner.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-success-metric-{change-slug}.md`. Never hand-build the path.

The doc holds: the change and outcome, the primary metric with full definition, the supporting list, baseline/minimum/target/date, the guardrails with thresholds, the instrumentation list with owners.
