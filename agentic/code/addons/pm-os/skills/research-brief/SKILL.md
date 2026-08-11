---
name: research-brief
description: >-
  Use when a problem and a proposed solution are already defined and need to
  become an actionable research brief — background, scope, timeline,
  methods, deliverables, and expected outcomes, tied to what's actually
  risky about the solution. Not for framing a decision as a researchable
  question first (`research-decision`), turning an unvalidated leadership
  hunch into a research plan (`intuition-to-research`), or synthesizing
  findings once research is done (`research-synthesis`).
---

# Scope a research brief from a problem and a proposed solution

## Step 1 — Take the problem and the proposed solution

Get the problem statement and the specific solution being proposed for it.

Done when both the problem and the proposed solution are stated.

## Step 2 — Name what's actually at risk

Identify the proposed solution's real strengths and weaknesses, and the specific things that aren't yet validated — not a generic risk list, the ones that would change the decision if they turned out false.

Done when the risky, decision-relevant unknowns are named — not a boilerplate risk checklist.

## Step 3 — Scope the study

Choose the research type and method mix (qualitative, quantitative, or both) that would actually resolve the named unknowns, with a rationale for each choice tied to what it's meant to answer.

Done when every chosen method is tied to a specific unknown from Step 2, not applied as a default template.

## Step 4 — Set timeline, deliverables, and outcomes

Give a rough timeline, the specific deliverables the research will produce, and the outcomes/measurements expected — all tied to the decision this research is meant to inform.

Done when timeline, deliverables, and expected outcomes are all stated and traceable to the decision at stake.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-research-brief-{topic-slug}.md`. Never hand-build the path.

The doc holds: the problem and proposed solution, the named risky unknowns, the scoped methods with rationale, and the timeline/deliverables/outcomes.
