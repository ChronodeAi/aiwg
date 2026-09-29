---
name: onboarding-redesign
description: >-
  Use when a product's onboarding needs redesigning around the user's *transformation* — who they are before, who they become after, and the smallest step that makes them feel the change — with every current step audited as serving the user or serving the product. Fires on "our onboarding leaks users" or "redesign our first-run experience." Not for locating the activation metric (`aha-moment`), mapping the full journey (`journey-map`), or general flow friction (`friction-reduce`).
---

# Redesign onboarding around the transformation

## Step 1 — Get the product, the audience, and the current flow

Ask for the product, the target audience, and the current onboarding enumerated step by step — every screen, form, and email, with drop-off numbers per step if any exist. Vague flows hide the leaks; push for the actual sequence.

Done when the current flow is an ordered list of concrete steps, with numbers attached where they exist.

## Step 2 — Define the transformation

Write who the user is before ("tracks projects in a spreadsheet that's always stale") and who they are after ("sees project status without asking anyone") — in the user's terms, not the product's ("uses dashboards" is the product talking). The gap between the two lines is what onboarding must deliver.

Done when before and after are one line each, both in the user's terms, and the after describes their life, not the feature set.

## Step 3 — Find the smallest step that makes the change felt

Name the earliest moment a user can *feel* the transformation start — the first stale-spreadsheet question answered by the product instead. It must be reachable in the first session; a transformation the user first feels next week is one they never come back for.

Done when the step is named, reachable in session one, and described as something the user experiences rather than completes.

## Step 4 — Audit every current step against the transformation

Mark each step from Step 1: **keep** (advances the transformation), **move** (needed eventually, not before the Step 3 moment — most signup friction and data collection lands here), or **cut** (serves the product, not the user, and the product's gain doesn't survive the drop-off it causes). Every move/cut names what the step was costing.

Done when every current step carries a mark and a reason, and nothing before the Step 3 moment fails to serve it.

## Step 5 — Design the progress mechanics

For the redesigned flow: how progress toward the transformation is shown (progress toward *their* outcome, not profile completeness), how the first win is marked when the Step 3 moment lands, and how the next step is made obvious after each completed one. Each mechanic ties to a specific step in the new flow.

Done when each mechanic names its step, and the progress shown is the user's outcome, not the product's checklist.

## Step 6 — Package the plan

Write the improvement plan, PRD- or design-brief-ready: the new flow in order, the changes from the current flow ranked by expected impact (drop-off data from Step 1 sets the order where it exists), and what to measure after shipping — at minimum, reach rate to the Step 3 moment.

Done when the plan is ordered by impact, every change traces to a Step 4 mark or Step 5 mechanic, and the post-ship measurement is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-onboarding-redesign-{product-slug}.md`. Never hand-build the path.

The doc holds: the current flow with numbers, the transformation lines, the felt-change step, the step audit, the progress mechanics, the ranked plan with its measurement.
