---
name: lateral-thinking
description: >-
  Use when a stated problem needs reframing through De Bono's provocation
  technique — deliberate disruptions (reversal, exaggeration, distortion,
  random connection) that break the frame and generate genuinely new
  options. Not for open-topic idea breadth (`brainstorm-genius`),
  constraint-driven ideation (`constrained-ideas`), or borrowing structure
  from an unrelated domain (`metaphor-thinking`).
---

# Break the frame with a provocation, then extract the option

A brainstorm inside the existing frame produces variations on what's already been tried. A *provocation* — a deliberately impossible or absurd statement about the problem — forces thinking outside it, and the real value comes from what gets extracted once you take the provocation seriously for a moment.

## Step 1 — Take the problem

Get the problem statement.

Done when the problem is stated specifically enough to provoke against.

## Step 2 — Generate provocations

Write at least 10 provocations (prefixed "PO"), mixing: reversals (invert an aspect), exaggerations (take an element to an extreme), distortions (change an element's nature), and random connections (introduce an unrelated concept).

Done when at least 10 provocations are written, spanning all four types, none a mild restatement of the problem.

## Step 3 — Extract an option from each

For each provocation, apply a movement technique — abandon the constraint entirely, imagine the ideal case, reverse it back, exaggerate further, introduce chance, or falsify an assumption — to extract one concrete new option from taking the provocation seriously.

Done when every provocation has a named movement technique and a resulting option distinct from the original problem framing.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-lateral-thinking-{problem-slug}.md`. Never hand-build the path.

The doc holds: each provocation, its movement technique, and the resulting option.
