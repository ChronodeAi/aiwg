---
name: reinforcing-sequence
description: >-
  Use when a small set of strategic components — a flywheel, an
  initiative sequence, a set of bets — needs ordering into a
  self-reinforcing loop, each component making the next easier, with the
  last strengthening the first. Not for organizing a chaotic to-do dump
  (`task-sequence`), or discovering the flywheel's components in the
  first place (`flywheel`).
---

# Order components so the loop closes on itself

## Step 1 — Take the components

Get the small set of components, initiatives, or bets to sequence — already defined, not a raw task dump.

Done when every component is named specifically enough to assess how it affects the others.

## Step 2 — Assess facilitation strength between pairs

For each pair of components, assess whether completing one meaningfully makes another easier or more effective — not just "comes before," but actually reduces friction or adds momentum for what follows.

Done when every component's relationship to at least one other is assessed for facilitation strength, not mere ordering.

## Step 3 — Find the starting point and order the chain

Identify which component is the strongest entry point, then order the rest so each facilitates the next.

Done when every component has a position in the sequence, each justified by how it facilitates the one after it.

## Step 4 — Check the loop closes

Confirm the last component in the sequence meaningfully strengthens the first — if it doesn't, this is a one-way chain, not a reinforcing loop, and that should be stated explicitly rather than forced.

Done when the loop-closing link is either confirmed with its mechanism stated, or the sequence is honestly labeled as one-way.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-reinforcing-sequence-{topic-slug}.md`. Never hand-build the path.

The doc holds: the ordered components, the facilitation reasoning between each pair, and the loop-closing check.
