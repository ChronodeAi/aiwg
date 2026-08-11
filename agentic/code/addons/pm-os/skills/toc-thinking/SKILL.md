---
name: toc-thinking
description: >-
  Use when a stakeholder decision is stuck on a conflict and you want to dissolve it with Theory of Constraints — trace symptoms to a root cause (Effect-Cause-Effect), surface the conflict and the assumption holding it (the Evaporating Cloud), then break that assumption. Not for a general root-cause tree (`causal-tree`), a MECE decomposition (`mece-tree`), or converging a messy problem to a recommendation (`structure-problem`).
---

# Dissolve a stuck decision with TOC thinking

## Step 1 — State the problem and stakeholders

Name the core problem in one sentence and the stakeholders — who must decide and what each cares about.

Done when the core problem is one sentence and each stakeholder's stake is named.

## Step 2 — Effect-Cause-Effect: find the root cause

List the undesirable effects (the symptoms people complain about), trace each to its causes, and converge on the one root cause underneath. Treating symptoms is why the decision keeps recurring.

Done when the undesirable effects trace down to a single named root cause.

## Step 3 — Build the Evaporating Cloud

Name the conflict as two things in tension, the legitimate requirement behind each side, and the assumption that makes them appear mutually exclusive.

Done when the cloud has both sides, each side's requirement, and the assumption holding the conflict in place.

## Step 4 — Break the assumption

Find the injection — the change that makes the assumption false and dissolves the conflict, yielding a solution that meets both requirements rather than trading one off.

Done when a specific injection is named that invalidates the assumption and serves both sides.

## Step 5 — Build the stakeholder case

Present the recommendation as addressing the root cause and dissolving the conflict, tied explicitly to what each stakeholder cares about.

Done when the case connects the injection to the root cause and to each stakeholder's stake.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-toc-thinking-{problem-slug}.md`. Never hand-build the path.

The doc holds: the problem and stakeholders, the undesirable effects traced to a root cause, the Evaporating Cloud (conflict, requirements, assumption), the injection that breaks it, and the stakeholder case.
