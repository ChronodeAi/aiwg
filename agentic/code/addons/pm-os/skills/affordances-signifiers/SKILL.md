---
name: affordances-signifiers
description: >-
  Use when a design challenge needs concrete interaction ideas grounded in
  Don Norman's affordance/signifier vocabulary — a stated challenge in,
  affordances, perceived affordances, and signifiers out, each tied to a
  specific user interaction. Not for critiquing an existing design
  (`product-design-analyzer`), or correcting UX terms in written
  requirements (`ux-terminology`).
---

# Generate affordances and signifiers for a design challenge

An affordance is what an object lets you do; a signifier is the cue that tells you it lets you do it. A design with the right affordance but no signifier is invisible — no user will find it.

## Step 1 — Name the interactions

From the design challenge, list the specific user interactions or functions the design must support. Ground everything that follows in this list, not in features generically.

Done when every core interaction the design needs is named.

## Step 2 — Generate affordances

For each interaction, propose at least one affordance — a real property of the design that makes the interaction possible, physical or digital.

Done when every named interaction has at least one affordance, each with a one-line note on why it enables that interaction.

## Step 3 — Generate perceived affordances

For each affordance, state what a first-time user would perceive as possible just by looking — and flag any gap between what's actually possible and what reads as possible.

Done when every affordance has a stated perceived-affordance note, with gaps flagged where perception and reality diverge.

## Step 4 — Generate signifiers

For each flagged gap or non-obvious affordance, propose a signifier — a visual or textual cue that closes the gap.

Done when every gap flagged in Step 3 has a signifier proposed to close it.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-affordances-{challenge-slug}.md`. Never hand-build the path.

The doc holds: the interaction list, and for each, its affordance, perceived-affordance note, and signifier where flagged.
