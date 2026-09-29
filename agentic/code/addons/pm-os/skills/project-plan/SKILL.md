---
name: project-plan
description: >-
  Use when a project brief needs turning into a schedule with a *critical path* — tasks, estimates, milestones, risks, and the ambiguities that will blow the timeline if left unasked. Fires on "plan this project" or "build a timeline from this brief." Not for organizing an existing task list (`task-list-to-plan`), sequencing a to-do dump (`task-sequence`), or prioritizing feedback into a release (`v2-plan`).
---

# Build a project plan with a critical path

## Step 1 — Extract the commitments from the brief

Pull from the brief: the objective, the concrete deliverables, the deadline and any fixed dates, and the people or capacity available. What the brief doesn't say, ask — capacity and deadline especially; a plan without them is fiction with formatting.

Done when objective, deliverables, dates, and capacity are each stated, or explicitly marked as asked-and-unknown.

## Step 2 — Break the work down with estimates

Decompose each deliverable into tasks small enough to estimate — days, not weeks. Each task gets an estimate, the dependency it waits on, and who does it. Mark low-confidence estimates rather than padding them silently; the padding hides exactly the information Step 5 needs.

Done when every deliverable is fully covered by tasks, and every task has an estimate, dependencies, and an owner or role.

## Step 3 — Find the critical path

Chain the dependencies and find the longest path from start to final deliverable — those tasks set the end date. State the path explicitly, the end date it implies, and the slack on everything off it. If the implied end date misses the Step 1 deadline, say so now and show the gap; a plan that hides its overrun until week six is worse than none.

Done when the critical path is listed task by task, the end date is stated, and any gap to the deadline is named up front.

## Step 4 — Lay out the calendar at honest granularity

Plan day by day for the first two weeks — that's as far as daily precision survives contact with reality — then week by week to the end, with a named milestone closing each week or phase: something checkable shipped or decided, not "continue development." Fixed dates from Step 1 go on the calendar first.

Done when the first two weeks are daily, the rest weekly, and every milestone is a checkable event.

## Step 5 — Name the risks and the ambiguities

Two lists. **Risks**: what could slip, its likelihood, and the mitigation — with critical-path tasks and low-confidence estimates from Step 2 examined first, since that's where slips move the end date. **Ambiguities**: what the brief leaves unclear, why it matters, and the question that resolves it, each with who to ask and by when — an ambiguity resolved in week one costs a conversation; in week six it costs the timeline.

Done when every critical-path task has been risk-checked, and every ambiguity has a question, a person, and a by-when.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-project-plan-{project-slug}.md`. Never hand-build the path.

The doc holds: the commitments, the task breakdown with estimates, the critical path and end date with any deadline gap, the calendar with milestones, the risks and ambiguities with owners and dates.
