---
name: experiment-design
description: >-
  Use when you have a hypothesis (or a goal to validate) and need the minimum experiment that could *disprove* it — method, primary metric, minimum detectable effect, sample size, and stop/scale rules. Also /research Step 5, one experiment per product hypothesis. Not for defining the success metric itself (`success-metric`), instrumenting the events an experiment needs (`tracking-schema`), or choosing which assumptions to test (`risky-assumptions`).
---

# Design the minimum experiment that could disprove the hypothesis

## Step 1 — State the hypothesis and its falsifier

When arriving from `/research` Step 5, take the product hypotheses from Step 4 — one experiment per hypothesis; standalone, get the hypothesis or the goal to validate. Write each as a falsifiable claim and name the result that would disprove it.

Done when each hypothesis is one falsifiable sentence with the specific result that would kill it.

## Step 2 — Pick the cheapest method that could produce that disproof

Choose the method that could actually surface the killing result — A/B test, fake-door, concierge, cohort analysis, prototype test, survey. Match it to the claim and the stage; don't run an RCT when a fake-door answers the question.

Done when the method is named with one line on why it can disprove the claim and why a cheaper one can't.

## Step 3 — Define the primary metric and minimum detectable effect

Name the one primary metric the result rides on, and the smallest change that would matter (the MDE). A metric with no MDE can't tell a real effect from noise.

Done when there is one primary metric and a numeric MDE.

## Step 4 — Size it

State the sample size or duration needed to detect the MDE at reasonable confidence, and whether current traffic makes that feasible. If it's underpowered, say so and name the fix — a bigger expected effect, a longer run, or a cheaper method.

Done when the sample/duration is stated and its feasibility judged, with a named fix if underpowered.

## Step 5 — Set stop and scale rules

Decide in advance: the result that scales it, the result that kills it, and what counts as inconclusive — plus a guardrail that halts the test early if it does harm.

Done when scale, kill, and inconclusive thresholds are set and a harm guardrail is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-experiment-design-{topic-slug}.md`. Never hand-build the path.

The doc holds, per hypothesis: the falsifier, the method with its justification, the primary metric and MDE, the sample/duration with its feasibility, and the stop/scale rules with the harm guardrail.
