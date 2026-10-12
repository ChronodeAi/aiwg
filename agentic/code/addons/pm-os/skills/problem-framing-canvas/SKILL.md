---
name: problem-framing-canvas
description: >-
  Use when you have a session transcript, interview, or conversation and need
  the core problem framed from the person experiencing it — a first-person
  narrative (I am / trying to / but / because / feels), the constraints
  around them, and one problem statement stakeholders can rally behind. Also
  invoked by `mckinsey-issue-tree` Phase 3 to frame before building the tree.
  Not for turning a vague stakeholder brief into a problem statement
  (`brief-to-problem`), building the issue tree itself (`mckinsey-issue-tree`),
  or converging to a recommendation (`structure-problem`).
---

# Frame the problem from a session transcript

## Step 1 — Pull the persona and their pain from the transcript

Identify who's experiencing the problem, their real pain points, and the outcome they're actually trying to reach — each grounded in a specific quote, kept whole and verbatim (don't stitch fragments from different points in the transcript), cited by participant ID and approximate timestamp where available.

Done when the persona, their pain points, and the desired outcome each trace to a specific quote.

## Step 2 — Write the first-person narrative

Fill the narrative in the persona's voice, not the PM's: **I am** [traits] / **Trying to** [outcome] / **But** [barriers] / **Because** [root cause] / **Which makes me feel** [emotion].

Done when every line traces to something actually said in the transcript, not an assumption filled in for them.

## Step 3 — Name the constraints around them

List what actually limits this persona — timing, technology, geography, whatever the transcript surfaces. Skip any category the transcript doesn't support; a generic constraints checklist with nothing behind it is worse than a short, grounded list.

Done when every constraint listed is grounded in the transcript.

## Step 4 — Write the problem statement stakeholders can rally behind

Write two alternates, then pick the sharpest: one sentence, empathetic, specific enough to point at a direction without prescribing the solution.

Done when one problem statement is chosen and the other alternate considered is visible for comparison.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-problem-framing-canvas-{persona-slug}.md`. Never hand-build the path.

The doc holds: the cited quotes behind each finding, the first-person narrative, the grounded constraints, and the chosen problem statement with its runner-up.
