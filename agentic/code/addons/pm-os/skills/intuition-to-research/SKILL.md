---
name: intuition-to-research
description: >-
  Use when leadership has a gut feeling about a feature and it needs to
  become a research plan before anyone builds anything — a hunch and
  company context in, the hunch's hidden assumptions surfaced, and a plan to
  validate or refute it out. Not for planning a study around an
  already-defined problem and solution (`research-brief`), framing a
  decision as a researchable question (`research-decision`), or checking
  whether old research has decayed (`research-recency`).
---

# Turn a leadership hunch into a research plan

## Step 1 — Take the hunch and the context

Get the intuition as leadership actually stated it, plus the company context needed to interpret it.

Done when the hunch and company context are both in hand.

## Step 2 — Surface the assumptions and check for bias

List what the hunch assumes to be true, and flag any obvious bias behind it (recency bias, a loud anecdote, a competitor's move, seniority-driven certainty). A hunch with its assumptions unnamed gets validated or refuted by accident.

Done when the hunch's underlying assumptions are listed and any obvious bias is named.

## Step 3 — Turn assumptions into research objectives

From the assumptions, prioritize the ones that would most change the decision if false, and write 3-5 measurable objectives that would validate or refute them.

Done when 3-5 objectives are written, each tied to a specific prioritized assumption.

## Step 4 — Choose methods and success metrics

For each objective, pick the qual/quant method that resolves it and the metric that will show whether the hunch held up.

Done when every objective has a method and a success metric, not a generic research-methods list.

## Step 5 — Flag risk and propose a timeline

Name what could go wrong in running this research (access, sample size, timing) and a realistic timeline with milestones.

Done when risks are named with a mitigation, and the timeline has stated milestones.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-intuition-to-research-{topic-slug}.md`. Never hand-build the path.

The doc holds: the hunch, its surfaced assumptions and bias flags, the research objectives with methods and success metrics, and the risk/timeline plan.
