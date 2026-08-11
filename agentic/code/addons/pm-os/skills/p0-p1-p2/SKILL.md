---
name: p0-p1-p2
description: >-
  Use when a requirements list has everything marked "must-have" and the PM needs it forced into P0/P1/P2 — P0 meaning *launch blocker*, tested, not claimed. Fires on "prioritize these requirements," "what's actually P0 here," or pre-launch scope fights. Not for pricing one incoming scope request (`scope-defense`) or ranking discovery opportunities (`ost-prioritize`).
---

# Force-rank requirements into P0/P1/P2

## Step 1 — Define launch before touching the list

Ask what launch means: which 2–4 core tasks must a user be able to complete on day one, and what capacity exists. The P0 test is meaningless until the core tasks are named — they are the standard every "must-have" claim gets measured against.

Done when the core tasks are listed, each as something a user does, and capacity is a number.

## Step 2 — Apply the launch-blocker test to every item

For each requirement: which core task becomes impossible without it? If the answer names a task, it's P0. If the answer is "it would be worse but possible," it is not P0 — no matter who said "must-have." For every claimed must-have that fails, record the challenge: who claimed it, what evidence they gave, and what the workaround is.

Done when every P0 names the core task it unblocks, and every demoted claim has its claimant, evidence, and workaround recorded.

## Step 3 — Split the remainder into P1 and P2

P1: significantly improves a core task or enables an important secondary use case — with the evidence, not just the assertion. P2: an enhancement users won't block on. Every item gets one line of reasoning; an item nobody can produce a reason for gets flagged as a cut candidate, not parked in P2.

Done when every item holds exactly one priority with a one-line reason, and reason-less items are flagged.

## Step 4 — Check the plan against capacity

Sum effort per tier. If P0 alone exceeds capacity, the launch definition is too big — go back to Step 1 and shrink what launch means, don't shave estimates. If P0 fits but P0+P1 doesn't, name which P1s slip and whether any has a smaller version that keeps its core value.

Done when the shipping set fits capacity, and anything moved out is named with its destination (slipped, shrunk, or cut).

## Step 5 — Package the demotions for the claimants

The contested calls will be re-litigated, so arm them: for each demoted must-have, one short paragraph — claimed priority, actual priority, the test it failed, the workaround, and what evidence would reverse the call. That last line matters; it turns a fight into a falsifiable claim.

Done when every demotion has its paragraph including the evidence that would reverse it.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-p0-p1-p2-{project-slug}.md`. Never hand-build the path.

The doc holds: the launch definition and core tasks, the tiered list with reasons, the capacity check with what moved, the demotion paragraphs.
