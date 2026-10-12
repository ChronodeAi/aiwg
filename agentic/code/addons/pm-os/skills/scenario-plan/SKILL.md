---
name: scenario-plan
description: >-
  Use when a team is stuck reacting and needs a plan built from four views of the situation — current state, the projected *mess* if nothing changes, the ideal future, and what of that ideal can start today. Fires on "where is this heading," "help me plan out of this situation," or adaptive-planning requests. Not for disruption ideation (`disruption-what-ifs`), SWOT move generation (`swot-moves`), or a delivery plan from a task list (`project-plan`).
---

# Plan from scenario to action

## Step 1 — Establish the current state

Get the situation and who's doing the planning. Then write two lists: what's working (and would be foolish to break) and what's not (facts, not aspirations — "release takes 3 weeks," not "we should ship faster"). Pull both from the user; they hold the facts.

Done when both lists are concrete enough that a newcomer could verify each line.

## Step 2 — Project the mess

Extrapolate the no-change future: the specific failures that arrive, roughly when, and why this outcome is the *stable* one — what in today's setup keeps producing it. Each failure must trace back to a Step 1 item; a mess with no roots in the current state is a fear, not a projection.

Done when every projected failure names its current-state cause and a rough arrival time.

## Step 3 — Describe the ideal future

Write the ideal state as plausible, not fantasy — the test: some team, somewhere, operates this way today. List the key differences from the current state; the differences, not the vision prose, are what the rest of the plan works from.

Done when the differences from today are listed and each passes the someone-does-this test.

## Step 4 — Find the ideal-now slice

For each difference in Step 3, ask: what part of this could start this month with what we already have? Not preparation for the change — the change itself, at small scale (one team, one process, one product area). Differences with no startable slice get marked blocked, with the blocker named.

Done when every difference has either a this-month action or a named blocker.

## Step 5 — Bridge with capabilities and write the plan

Name the capabilities — skills, systems, habits — the team must build to fix the current problems, dodge the mess, and reach the ideal; note which serve all three, because those come first. Then write the action plan: the Step 4 slices plus capability-building steps, each with an owner and a first move, ordered so early wins fund later ones.

Done when every action links to a quadrant or capability, and each has an owner and a first move.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-scenario-plan-{situation-slug}.md`. Never hand-build the path.

The doc holds: the current-state lists, the projected mess with causes and timing, the ideal-future differences, the ideal-now slices and blockers, the capabilities, the ordered action plan.
