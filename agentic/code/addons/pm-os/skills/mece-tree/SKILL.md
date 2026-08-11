---
name: mece-tree
description: >-
  Use when a list of items — options, causes, segments, anything — needs a
  MECE check before you build on it: no overlaps, no gaps, and a logical tree
  that exposes whichever one was hiding. Also /decisions Step 4 and an
  optional check inside /opportunity, taking whatever list the workflow has
  already assembled. Not for tracing root causes (`causal-tree`), the full
  Why/What/How issue-tree pipeline (`mckinsey-issue-tree`), or converging to
  one recommendation (`structure-problem`).
---

# Check a list for MECE gaps and overlaps

A list that looks complete usually isn't — two items secretly overlap, or a real case has no item at all. This skill forces both checks before anything gets built on the list, then renders what it finds as a tree.

Inside `/decisions` this is Step 4: the options from Steps 1–2 come in. Inside `/opportunity` it's an optional check on a slice of the tree. Standalone, gather the list first.

## Step 1 — Get the list

Take the list as given — options, candidate causes, opportunity statements, whatever the workflow handed off. Standalone, ask for it: one item per line.

Done when the list is in hand, one item per line.

## Step 2 — Check mutual exclusivity

Compare every pair. Where two items could both be true or chosen at once, or one is a special case of another, that's an overlap — name which two items collide and why, not just that "some overlap exists."

Done when every pair has been considered and every overlap is named with the specific items and the reason.

## Step 3 — Check collective exhaustiveness

Ask what real scenario the list doesn't cover. A residual "other" bucket is a confession, not a fix — name the specific missing case instead of parking it there.

Done when every gap is named as a specific missing case, none papered over with "other."

## Step 4 — Build the tree

Resolve the overlaps (merge or split the colliding items) and the gaps (add the missing case, or exclude it with a stated reason) from Steps 2–3, then render the result as a hierarchical tree so the structure is visible, not just listed.

Done when the tree reflects every resolved overlap and gap, and no leaf is still ambiguous.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-mece-tree-{list-slug}.md`. Never hand-build the path.

The doc holds: the original list, every overlap and gap named with its resolution, and the resulting MECE tree.
