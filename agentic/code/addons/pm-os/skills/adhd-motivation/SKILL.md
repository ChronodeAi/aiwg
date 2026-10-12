---
name: adhd-motivation
description: >-
  Use when someone with ADHD is stuck on a task and needs a motivation plan
  built from the Four Cs (Captivate, Create, Compete, Complete) — a
  situation in, a tactic per C and 2-3 immediate action steps out. Not for
  tracking motivation patterns over time (`motivation-journal`), or a
  founder's focus-and-execution plan (`founder-focus`).
---

# Apply the Four Cs to one stuck situation

## Step 1 — Take the situation

Get the specific task or situation the person is stuck on, and what they've already tried.

Done when the stuck task and any prior attempts are both named.

## Step 2 — Apply each of the Four Cs

For this specific situation, not in general: how could it be made more captivating (what would grab attention here), more creative (what novel angle exists), more competitive (what's the challenge to beat), and more urgent (what deadline or timer forces completion). Skip a C only if it genuinely doesn't fit this situation, and say so.

Done when each of the Four Cs has a tactic specific to this situation, not a generic restatement of the framework.

## Step 3 — Name 2-3 immediate steps

From the tactics in Step 2, pick 2-3 concrete actions the person can take right now — not "apply the Compete principle," the actual first move.

Done when 2-3 immediately actionable steps are named, each traceable to a specific C from Step 2.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-adhd-motivation-{task-slug}.md`. Never hand-build the path — save is optional for a one-off coaching exchange.

The doc holds: the situation, the per-C tactics, and the 2-3 immediate steps.
