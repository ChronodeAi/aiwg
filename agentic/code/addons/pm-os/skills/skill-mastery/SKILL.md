---
name: skill-mastery
description: >-
  Use when a vague learning goal needs a falsifiable mastery plan — a skill,
  a time horizon, and a weekly budget in, a deconstructed sub-skill map, an
  80/20 sprint plan, an accountability contract, and a tracked scoreboard
  out, via the DSSS (Deconstruction, Selection, Sequencing, Stakes)
  framework. Not for a Socratic tutoring session on a topic (`ai-tutor`),
  general adaptive PM performance coaching (`coaching`), or broader
  career-direction guidance (`career-guidance`).
---

# Build a DSSS mastery plan from a vague goal

## Step 1 — Gate the goal

Turn the goal into a Definition of Done that's observable, measurable, and falsifiable — not "get better," but a specific target with a deadline and a weekly time budget. Note the starting level with evidence, and any real constraint (budget, tools, space, injury risk). Refuse and redirect if the goal is unsafe, illegal, or unethical.

Done when the DoD is falsifiable, the time horizon and weekly budget are set, and no safety issue is unaddressed.

## Step 2 — Deconstruct into sub-skills

Break the skill into 10-20 sub-skills — concepts, procedures, decisions. For each: its prerequisites, its common failure modes, and a 5-minute micro-task with a pass/fail test.

Done when every sub-skill has prerequisites, failure modes, and a pass/fail micro-task.

## Step 3 — Select the leverage 20%

From the deconstruction, choose the sub-skills that drive ≥80% of the outcome. For each: why it's leverage, the highest-yield drill (10-15 min), the minimum viable learning resource, and the KPI that proves it's working.

Done when the shortlist has leverage rationale, drill, resource, and KPI for every item.

## Step 4 — Sequence the sprint

Build a 2-6 week plan: prerequisites → constrained drills → whole-task integration → pressure tests, with session templates (warm-up, core drill, integration, cool-down) and spacing/interleaving rules. Set checkpoint dates with pass/fail criteria tied to the DoD, plus the first three actions doable in the next 15 minutes each.

Done when the weekly plan, session template, checkpoints, and first actions are all specified.

## Step 5 — Stake it

Design layered accountability: financial (deposit or anti-charity with a forfeit trigger), social (a named person and a reporting cadence), temporal (non-negotiable calendar blocks), and environmental (friction removed). Write an if-then rule for the most predictable failure point, and a kill/adjust rule for real constraints hitting (injury, scope change).

Done when the contract names a deposit/forfeit, a reporting cadence, an if-then rule, and a kill/adjust rule.

## Step 6 — Track and verify

Set lead indicators (practice volume, drill accuracy, retrieval latency) and lag indicators (representative-task score, external benchmark) in a scoreboard reviewed weekly. Verify mastery against the Step 1 DoD with a pass/fail benchmark test, not self-report — a teach-back to someone else is the strongest check.

Done when the scoreboard tracks both lead and lag indicators, and mastery is checked against a benchmark test.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-skill-mastery-{skill-slug}.md`. Never hand-build the path.

The doc holds: the DoD, the sub-skill deconstruction, the leverage shortlist, the sprint plan with checkpoints, the accountability contract, and the tracking scoreboard.
