---
name: research-decision
description: >-
  Use when you have a decision to make and want to frame it as a specific, researchable *decision question* — sized by how reversible and high-impact the call is — so research is attached to a decision instead of run for its own sake. Not for planning the study itself (`research-brief`), turning a hunch into a research plan (`intuition-to-research`), or synthesizing findings into insights (`research-synthesis`).
---

# Frame a decision as a researchable question

## Step 1 — Name the decision and its stage

State what will be decided and where the product is — concept, build, or grow. The stage sets what kind of evidence is appropriate; you don't need statistical proof to test a concept.

Done when the decision and the development stage are both stated.

## Step 2 — Size the splash zone

Judge how big and how reversible the decision is. A one-way, high-impact call warrants more evidence; a reversible tweak warrants a cheap read. This sizes the whole effort.

Done when the decision's impact and reversibility are named and translated into how much evidence it warrants.

## Step 3 — State the evidence needs

Name what you'd need to know to make the call with confidence, matched to the stage and the splash zone.

Done when the evidence needs are listed and matched to stage and splash zone.

## Step 4 — Write the decision question

Rewrite the decision as one specific, researchable question — visceral and concrete. "Decide if launching X fits user needs, is usable, and is discoverable," not "decide if X is good."

Done when the decision is one specific question a study could actually answer.

## Step 5 — Set the bar

State what answer would greenlight the decision and what would stop it, so the research has a decision waiting on it rather than running for its own sake.

Done when the greenlight and stop conditions are both stated.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-research-decision-{topic-slug}.md`. Never hand-build the path.

The doc holds: the decision and stage, the splash-zone sizing, the evidence needs, the researchable decision question, and the greenlight/stop bar.
