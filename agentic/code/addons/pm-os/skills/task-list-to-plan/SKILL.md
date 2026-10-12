---
name: task-list-to-plan
description: >-
  Use when you have an existing list of tasks and need it turned into a sequenced plan — ordered by *dependency*, with the missing tasks surfaced, contingencies for the risky ones, and go/no-go milestones. Not for planning from a brief with a critical path (`project-plan`), ordering an unstructured to-do dump (`task-sequence`), or turning feedback into a release plan (`v2-plan`).
---

# Turn a task list into a sequenced plan

## Step 1 — Inventory the list

Capture every task and subtask, note the dependencies between them, and pull out any deadlines already stated.

Done when every task is listed with its dependencies and any stated deadline.

## Step 2 — Find the gaps

Name the tasks the work needs that aren't on the list — the unglamorous setup, testing, review, and handoff steps lists usually skip. Flag ambiguous tasks with a clarifying question rather than guessing.

Done when the missing tasks are added (marked as added) and ambiguous ones carry a question.

## Step 3 — Sequence by dependency

Order the tasks respecting their dependencies, group related work, and mark which tasks are on the critical path. Note where work can run in parallel.

Done when the order respects every dependency and the critical-path tasks are marked.

## Step 4 — Contingencies for the risky tasks

For each critical or high-risk task, name the likely blocker, a workaround, and a buffer.

Done when every critical or high-risk task has a blocker, a workaround, and a buffer.

## Step 5 — Go/no-go milestones

Name the key milestones, each with a go/no-go criterion and the signal to check it against.

Done when each milestone has a go/no-go criterion and a checkable signal.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-task-list-to-plan-{project-slug}.md`. Never hand-build the path.

The doc holds: the sequenced plan with added tasks flagged, the dependencies and critical path, the contingencies for risky tasks, and the go/no-go milestones.
