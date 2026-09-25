---
id: film-state-authority
name: Film State and Authority
description: Keep one versioned production truth and separate acceptance evidence from permission to act.
enforcement: high
---

# Film State and Authority

## Scope

Applies to film-production planning, resumption, asset promotion, and operation boundaries. This is agent procedure; loading the rule does not install a background recorder or executable gate.

## Requirements

- Keep one controlling production state that points to current briefs, shot records, source versions, review evidence, residual defects, authority, and next actions. Resolve the artifact root with `aiwg artifacts path --json --check-write` before writing production payloads; stop on an unavailable root rather than using a silent fallback.
- At resume, read current state and affected shots first. Search history only for a specific missing decision. Archive superseded directions instead of mixing them with controlling requirements.
- Bind acceptance to exact asset versions and separate story/blocking, visual quality, performance, motion, edit, and delivery dimensions. A correction reopens affected dimensions and downstream dependencies while preserving unaffected acceptance.
- Record authorization separately for editing, external upload, paid inference, delivery, and publication. Carry valid existing authorization forward; do not manufacture a new approval ceremony at every phase.
- Distinguish `quality hold` or missing evidence from absent authority. An agent can complete authorized repairs without asking again; it cannot silently promote a known failing asset or expand the action's scope.
- On pause, update current state and stop the paused production work. Continue only separately authorized independent work. Do not interpret a receipt, partial milestone, or recommendation as permission to resume.

## Required response

Record contradictions and their controlling resolution once. If unresolved, hold dependent actions and continue useful independent work. At a genuine boundary, provide a concrete review package and the exact missing decision or authority, rather than a vague request to proceed.
