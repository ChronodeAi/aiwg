---
name: shape-up
description: >-
  Use when a vague feature idea needs shaping into a Shape Up pitch — an
  appetite set as a constraint rather than an estimate, boundaries drawn,
  rabbit holes and no-gos named, and the constraint language an executive
  will actually commit to before the cycle starts. Not for the collaborative
  shaping methodology with slices and breadboards (`shaping`), holding scope
  once it is already under pressure (`scope-defense`), finding the
  application archetype before shaping (`eng-shape`), or a full requirements
  document (`prd-draft`).
---

# Shape a feature into a Shape Up pitch

Ryan Singer's shaping sits between the raw idea and the spec: concrete enough that a team can start, rough enough that they still own the implementation. Two things kill it — over-specification that leaves the team nothing to solve, and an open-ended scope an executive re-opens in week four. This skill fixes the abstraction level and pre-negotiates the constraint.

Structure comes from `templates/shape-up-pitch.md`. Read it before drafting; this skill owns the shaping judgement.

## Step 1 — Set the appetite

Decide the appetite before the solution: small batch (1–2 weeks) or big batch (6 weeks). Appetite is how much the problem is worth, not how long the work would take. State why this problem is worth that much and not more.

Done when one batch size is picked with a one-sentence reason grounded in the problem's value, not in an effort guess.

## Step 2 — Frame the problem and draw the boundary

Articulate the core problem, not the requested feature — a feature request is a proposed solution wearing a problem's clothes. Ground it in one concrete scenario a real user faces. Then state what is in scope and what is out.

Done when the problem statement survives the test "would a different solution also solve this?", and both the in-scope and out-of-scope lists are written.

## Step 3 — Sketch the solution at fat-marker fidelity

Describe the key interfaces and interactions in words at fat-marker level — broad strokes that define the shape without specifying the implementation. Wireframes are too specific; abstract nouns are too vague. Aim between them.

Done when the sketch names the key screens or interactions and no element specifies a control, layout or component the team should be choosing.

## Step 4 — Name the rabbit holes and no-gos

List the rabbit holes: the unresolved technical or design questions that could swallow the cycle, each with the decision that defuses it. Then list the no-gos explicitly — the adjacent things this pitch deliberately does not do.

Done when every rabbit hole carries a defusing decision and the no-go list is non-empty.

## Step 5 — Write the executive constraint

Write the language that secures commitment to the appetite and the boundary before work starts, plus the mechanism for handling new ideas mid-cycle without re-opening scope — where they go instead, and who decides.

Done when the pitch states the appetite as a circuit breaker (the work stops at the wall, unfinished, rather than extending) and names where mid-cycle ideas get parked.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-shape-up-pitch-{feature-slug}.md`. Never hand-build the path.

The doc holds: the pitch in the template's structure, and the executive constraint language with the mid-cycle-idea mechanism.
