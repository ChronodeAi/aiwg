---
id: film-revision-rounds
name: Film Revision Rounds
description: Batch revision notes into budgeted rounds and present a ship-or-fix decision when only minor residuals remain.
enforcement: high
activation: bound
summary: Batch revision notes into budgeted rounds and present a ship-or-fix decision when only minor residuals remain.
bound_to:
  agents: [film-producer, film-story-director, film-scene-supervisor, film-continuity-supervisor, film-editor-sound-supervisor, film-qc-reviewer]
  skills: [film-review-gate, film-edit-conform, film-delivery, film-retrospective]
  flows: [film-finish, film-deliver, film-resume, film-revise-with-impact]
---

# Film Revision Rounds

## Scope

Applies to every revision round after the first full assembly, through picture lock, sound lock and delivery.

## Requirements

- Batch all known notes per round; record each round's defects as user-found or self-found in that round's film-review-record.
- After picture lock, declare a round budget in the brief (default 3).
- When a round's remaining defects are all minor and none affects a required beat event, present a ship-or-fix decision with the residual list and marginal cost instead of starting another round.
- After any structural change (re-block, new shot), run a full real-speed self-review before presenting.

## Required response

Hold presentation of a round that follows a structural change until its real-speed self-review is recorded. When the round budget is spent, or only minor residuals off required beat events remain, stop and present the ship-or-fix decision rather than opening another round; a new round needs the user's decision or existing authority.
