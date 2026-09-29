---
name: product-hypothesis
description: >-
  Use when a product problem needs to become a testable hypothesis with a
  measurable success clause — a problem in, a falsifiable "we believe /
  we'll know" statement out with a stated metric and threshold. Also
  `/research` Step 4, taking Step 3's clustered forces as input. Not for
  designing the experiment that tests the hypothesis (`experiment-design`),
  clustering the JTBD forces that feed it (`jtbd-forces`), or scoping a
  research study before any hypothesis exists (`research-brief`).
---

# Formulate a falsifiable product hypothesis

## Step 1 — State the problem and the proposed change

Name the user problem and the specific change believed to address it — not a vague direction, a concrete action.

Done when the problem and the proposed change are both stated concretely.

## Step 2 — Draft the five-component statement

Write: [Action] will cause [Outcome] to [Direction] for [Users] under [Conditions]. All five components must be present and specific — no vague action, outcome, user segment, or condition.

Done when all five components are present and none is vague enough to mean multiple things.

## Step 3 — Attach the measurement

State the metric that will judge success, how it will be collected, and the threshold that counts as "right" — a change with no threshold isn't falsifiable.

Done when the metric, collection method, and success threshold are all stated.

## Step 4 — Frame it narratively and check it holds

Convert the statement into: "Currently, [user] is experiencing [problem]. We believe that by [change], we'll see [outcome]. We'll know we're right when [metric] changes by [amount]." Confirm it reads as one coherent causal story — problem, change, outcome, and proof all connect.

Done when the narrative form reads as one coherent story and the causal chain from problem to metric holds together.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-product-hypothesis-{problem-slug}.md`. Never hand-build the path.

The doc holds: the hypothesis in narrative form, the five-component breakdown, and the measurement plan.
