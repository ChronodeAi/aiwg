---
name: task-sequence
description: >-
  Use when a chaotic to-do list needs organizing — dump everything, group
  by affinity, unpack anything too vague to act on, then sequence by
  dependency. Not for a project brief needing a critical path
  (`project-plan`), an already-clean task list needing dependency
  ordering (`task-list-to-plan`), or sequencing a small set of strategic
  components into a self-reinforcing loop (`reinforcing-sequence`).
---

# Organize the dump before sequencing it

## Step 1 — Dump everything

Get every task the user has in mind, in any order, without organizing yet.

Done when the user confirms the dump is complete, not just the first batch.

## Step 2 — Affinitize

Group related tasks by likeness, stating the reasoning for each grouping, and confirm the groupings with the user.

Done when every task belongs to a named group, and the user has confirmed or adjusted the groupings.

## Step 3 — Unpack

For any task too vague or broad to act on, break it into specific, actionable subtasks.

Done when every task in the sequence is concrete enough to start without further clarification.

## Step 4 — Sequence by dependency

Diagram which tasks must complete before others, based on what inputs or outputs connect them. Check with the user for missing tasks, over- or under-granular tasks, and external deadlines or constraints, adjusting the sequence accordingly.

Done when every task has its place in the dependency order, confirmed against gaps, granularity, and constraints the user raised.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-task-sequence-{topic-slug}.md`. Never hand-build the path.

The doc holds: the grouped tasks, the unpacked subtasks, and the dependency-ordered sequence.
