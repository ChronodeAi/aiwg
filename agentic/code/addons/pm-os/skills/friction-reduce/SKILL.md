---
name: friction-reduce
description: >-
  Use when a multi-step flow (onboarding, checkout, signup, approval) is losing people and you want to cut steps without removing the checkpoints that prevent costly errors — each step tagged, priced against the drop-off it causes, and redesigned. Not for the first-run activation path (`onboarding-redesign`), mapping the whole end-to-end experience (`journey-map`), or retention work (`churn-reduction`).
---

# Reduce friction in a multi-step flow

## Step 1 — Map the flow and where people drop

List every step in order: what the user does, why the step exists, and the share of users who complete it. Pull the drop-off from analytics if the user has it; if not, ask where they *think* people quit and mark those numbers estimated. A flow you can't see the drop-off in is a flow you're guessing at.

Done when every step is listed with its purpose and a completion number (real or explicitly estimated), and the biggest drop is named.

## Step 2 — Tag each step

Tag every step exactly one of: **value** (advances the user's own goal), **checkpoint** (prevents a specific, named costly error — fraud, legal, data loss, lockout), or **tax** (neither — it exists for legacy, duplicate data, or internal convenience).

Done when every step carries one tag, and every checkpoint names the specific error it prevents.

## Step 3 — Apply the cost gate

Walk each step: cut every **tax** step; keep a **checkpoint** only if the error it prevents costs more than the drop-off it causes (say the comparison out loud); for heavy **value** steps, collapse/merge/defer/auto-fill rather than delete. Reversible actions don't need a confirmation; sensitive asks come after trust is built, not before.

Done when every step has a verdict — cut, keep, or reshape — each with the one-line reason it survived the gate or didn't.

## Step 4 — Redesign the flow

Show the new flow with before→after step count. For every step removed or moved, name the risk it was covering and how the new design covers that risk — or state plainly that it was covering nothing.

Done when the redesigned flow is laid out step by step, and no removed checkpoint's risk is left unaccounted for.

## Step 5 — Name the riskiest change and its watch metric

Pick the single change most likely to backfire (a cut checkpoint, a collapsed step) and name the one metric that will tell you within two weeks whether it helped or hurt — plus the threshold that would trigger a rollback.

Done when the riskiest change is named with a specific metric, a check date, and a rollback threshold.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-friction-reduce-{flow-slug}.md`. Never hand-build the path.

The doc holds: the current flow with drop-offs, each step's tag and gate verdict with reasons, the redesigned flow with risks reaccounted, and the riskiest change with its watch metric and rollback threshold.
