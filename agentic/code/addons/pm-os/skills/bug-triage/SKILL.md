---
name: bug-triage
description: >-
  Use when a reported bug needs a fast now-or-later call against what's
  already committed — a bug description, current work, and planned work
  in, a defer-or-escalate decision out with reasoning against both. Not for
  classifying a decision's reversibility (`two-way-door`), or pricing a
  mid-project scope-creep request (`scope-defense`).
---

# Triage a bug against committed work

## Step 1 — Take the bug and the committed work

Get the bug description, what's currently being worked, and what's planned next.

Done when the bug, current work, and planned work are all stated.

## Step 2 — Answer both comparisons

Is this bug more important than the current work? Is it more important than the planned work? Answer each with reasoning first, then yes/no — don't skip to the answer.

Done when both questions have stated reasoning and a yes/no answer.

## Step 3 — Decide

If both answers are no, defer the bug — it does not interrupt anything already committed. If either answer is yes, it merits escalation to fuller classification (severity, blast radius, workaround availability) rather than an immediate interrupt.

Done when the decision is either "defer" or "escalate for further classification," tied directly to the Step 2 answers.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-bug-triage-{bug-slug}.md`. Never hand-build the path.

The doc holds: the bug, the two comparison answers with reasoning, and the defer-or-escalate decision.
