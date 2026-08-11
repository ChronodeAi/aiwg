---
name: requirements-reconcile
description: >-
  Use when stakeholders have handed in *conflicting* requirements and the PM needs one unified list — "sales wants X, engineering wants not-X," multi-stakeholder PRD input, or /prd Step 2. Many conflicts dissolve once each side's underlying goal is named; the rest get decided, not averaged. Not for scoring options on a matrix (`tradeoff-matrix`) or deciding whether to fight at all (`pick-your-battles`).
---

# Reconcile conflicting requirements into one list

A stated requirement is a stakeholder's chosen solution; the *underlying goal* is what they'd accept any solution for. Most conflicts live between the solutions, not the goals — name the goals and many dissolve. The rest are real and get decided, not split down the middle.

Inside `/prd`, this is Step 2; the output feeds the use-case step.

## Step 1 — List the conflicts

Write each conflict as: requirement A (who wants it, in their words) vs. requirement B (who, in their words), and classify it — mutually exclusive, tradeoff (both possible with compromise), or same-resource contention. Pull the requirements from what stakeholders actually said; don't paraphrase away the tension.

Done when every conflict names both requirements with their stakeholders and carries a classification.

## Step 2 — Name the underlying goal on each side

For each requirement, write the goal behind it: what is this stakeholder actually trying to achieve, and what metric are they judged on? Ask the user where it isn't known — the goal is often not in the requirement's wording ("we need SSO" may mean "we need to stop losing enterprise deals"). Note where the two sides hold different unstated assumptions; a false conflict often lives there.

Done when every requirement has an underlying goal that is either visibly different from its wording or confirmed identical.

## Step 3 — Dissolve the false conflicts

Where the goals turn out compatible even though the requirements clash, propose the approach that serves both: sequence them in time, make one the default with the other an override, split by user segment, or meet the goal with a different mechanism entirely. Each dissolution states how both goals are met.

Done when every conflict is marked either **dissolved** (with its approach) or **real**.

## Step 4 — Decide the real conflicts

For each real conflict, lay out 2–3 options with what each side gains and loses, then recommend one. Tiebreakers, in order: user evidence, product strategy, reversibility. If the call is above the PM's authority, say so and name who decides and by when — a named decision-maker is a valid output; a mushy compromise that satisfies no goal is not.

Done when every real conflict has a recommendation with its tiebreaker, or a named decision-maker and date.

## Step 5 — Write the unified requirements list

Produce the single list downstream work builds from: every original requirement appears exactly once, marked **in**, **out**, or **modified** (with the modified wording), each with a one-line rationale pointing back to its dissolution or decision. This is the artifact `/prd` carries forward.

Done when no original requirement is missing from the list and every rationale traces to a Step 3 or Step 4 outcome.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-requirements-reconcile-{project-slug}.md`. Never hand-build the path.

The doc holds: the conflict list with classifications, the underlying goals, the dissolved conflicts with approaches, the decided conflicts with tiebreakers or escalations, the unified requirements list.
