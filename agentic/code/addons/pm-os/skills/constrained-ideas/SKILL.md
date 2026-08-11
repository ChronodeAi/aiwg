---
name: constrained-ideas
description: >-
  Use when ideas must fit hard *constraints* — a fixed budget, a project type, a deadline, a one-person team — and the constraints should drive the ideation rather than filter it afterward. Fires on "what can I do with $500," "ideas for X within Y." Not for open-topic ideation (`brainstorm-genius`), product-idea sessions (`product-brainstorm`), or reframing the problem itself (`lateral-thinking`).
---

# Generate ideas that fit hard constraints

## Step 1 — Pin the constraints

Get: the project type, the goal, and every hard constraint — budget, deadline, team size, skills available, anything forbidden. Each constraint must be checkable: a number, a date, or a yes/no. "Limited budget" isn't a constraint; "$500" is.

Done when every constraint is checkable and the goal is one sentence.

## Step 2 — Write down the obvious ideas first

List the 5 ideas anyone would produce for this brief — the default answers, the first page of a search. These are the bar: everything that follows must beat them. Naming them up front is what stops the session from converging back onto them dressed in new words.

Done when 5 obvious ideas are listed, each with one line on why it's the default.

## Step 3 — Use each constraint as a generator

For each constraint, ask: what does this make possible or necessary that an unconstrained team would never do? A tiny budget forces borrowed distribution and partnerships; a two-week deadline forces piggybacking on something that already exists; a solo team forces automation or a format one person can own. Generate at least one idea *from* each constraint.

Done when every constraint has produced at least one idea, and each idea names the constraint that generated it.

## Step 4 — Transform the strongest candidates

Take the 3–5 strongest ideas and push each through at least one transformation: combine two ideas, invert the approach, shrink it to its smallest complete version, or swap the audience. Keep the variant only when it beats the original against the goal.

Done when each candidate has been transformed at least once and the surviving version is marked.

## Step 5 — Deliver ideas that clear the bar

Present 3–5 final ideas. For each: the first concrete step, the cost against the Step 1 numbers, and one line on why it beats the obvious list from Step 2. An idea that violates any constraint or matches a Step 2 entry doesn't ship.

Done when every idea fits every constraint, names its first step, and states what makes it non-obvious.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-constrained-ideas-{project-slug}.md`. Never hand-build the path.

The doc holds: the constraints and goal, the obvious-ideas bar, the per-constraint ideas, the transformations, the final 3–5 with first steps and costs.
