---
name: ai-recommendation-canvas
description: >-
  Use when an AI feature needs a one-page go/no-go before anyone builds it — a
  customer problem and one persona in, a canvas out chaining business outcome →
  product outcome → solution hypothesis → success metric, plus the data and model
  feasibility check, the cheap discovery acts that would de-risk it, and risks
  split into investigate-now versus monitor-later. Not for turning a problem into
  a single falsifiable hypothesis (`product-hypothesis`), designing the experiment
  that tests one (`experiment-design`), or building the KPI arithmetic behind a
  feature's impact (`impact-model`).
---

# Fill an AI Recommendation Canvas for one problem and one persona

Ask only for what is missing. Where the user hesitates on a field, offer two to four tailored options rather than leaving it blank. Where a fact is unknown, mark it unknown — never fill a field by invention.

## Step 1 — Fix the problem and the persona

Take the product name, the customer problem, and one target persona. Gather the surrounding constraints: regulatory, data, budget, timeframe, stakeholders, competitors, and the data sources available.

If several personas are in play, pick one primary and note the secondary impacts in a line. If the data touches PHI, PII, or other regulated categories, record the compliance constraint and the data-minimization requirement here — it binds every later field.

Done when one primary persona is named, the problem is stated as a narrative rather than a components worksheet, and every constraint is either stated or marked unknown.

## Step 2 — Chain the outcomes

Write the chain and check it holds link by link:

- **Business outcome** — what the company gets, in money or in a named strategic position.
- **Product outcome** — the change in user behavior that produces the business outcome.
- **Solution hypothesis** — what you would build, and why it should cause that behavior change.
- **Success metrics** — how the product outcome gets measured.

Prefer verbs, numbers, and a timeframe. Convert every vague goal ("improve engagement") into something measurable with a threshold and a date.

Done when each link causes the one before it — you can state why the product outcome delivers the business outcome, and why the solution produces the product outcome — and every success metric carries a number and a timeframe.

## Step 3 — Check AI feasibility

Test the solution hypothesis against what it would actually take: data availability, volume, and quality; whether the model class is a fit or a stretch; latency and cost per call at expected volume; and the operational load — monitoring, retraining, human review.

For a generative feature, add the evaluation approach, the safety guardrails, and abuse monitoring.

Done when data, model, latency and cost, and operations each have a verdict of feasible, uncertain, or blocking, and every uncertain one names what would settle it.

## Step 4 — Name the tiny acts of discovery

List the cheap moves that would resolve the uncertain verdicts before a build commitment: a data-quality audit, a labelled sample, a prompt bake-off against held-out cases, five user interviews, a wizard-of-oz run.

Done when every uncertain or blocking verdict from Step 3 has at least one discovery act against it, each costed in days rather than weeks.

## Step 5 — Split the risks

Sort every risk into one of two lists, because they get handled differently:

- **Risks to investigate** — unresolved before the decision. These block the go.
- **Risks to monitor** — accepted at the decision, watched after launch. Each needs the signal that would trip it.

Done when every risk sits in exactly one list, and each monitor risk names its tripwire signal.

## Step 6 — Call it

Give a go, no-go, or go-after-discovery recommendation with the reason, plus three to five specific improvements to the canvas itself.

Done when the recommendation names the one thing that would flip it.

## Output

Render the canvas as Markdown inside a single code block, bullets terse, unknowns marked. Then resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json` and write to `{project_path}/YYMMDD-ai-canvas-{feature-slug}.md`. Never hand-build the path.

The doc holds: the problem and persona, the outcome chain, the feasibility verdicts, the discovery acts, both risk lists, and the recommendation.
