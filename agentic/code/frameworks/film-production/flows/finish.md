---
type: flow
name: film-finish
description: Film finish lifecycle phase with evidence-based exit criteria.
---
# Film Finish

## Entry
Selected takes and locked performances available; actual target NLE project verified.

## Activities
Assemble causal edit; preserve authentic layers; synchronize speech/foley; balance color and mix to the delivery brief. Review full playback and patch only affected areas. Record the timeline hash and one cut record per adjacent shot pair; lock picture before the final mix, then measure every audio element and lock sound.

Load with `aiwg show skill <name>`: film-edit-conform, film-performance-sound, film-review-gate.

## Outputs and owners
Editable timeline, cut records, measured audio elements, picture and sound lock records, export candidate.
Owners: film-editor-sound-supervisor, film-qc-reviewer.

## Exit evidence — FP-G05a Picture lock, then FP-G05b Sound lock
Criteria: `docs/taxonomy.md`, Acceptance gates and locks. Run `scripts/validate-film-state.mjs` on current state after recording each lock; a picture change after lock records a change list and relocks, which also reopens sound lock.

This gate evaluates evidence; it does not automatically demand a new user approval. Existing explicit scope/authority persists. On failure, stay in the affected phase, update current state and continue independent authorized work. A user pause blocks production. Frame, motion and delivery approvals apply to the recorded version and dimension only.
