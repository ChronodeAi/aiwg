---
name: film-retrospective
namespace: aiwg
platforms: [all]
description: Turn a bounded film production run into evidence-backed workflow improvements and measurable follow-up criteria.
triggers:
  - "film-retrospective"
  - "review film retrospective"
commandHint:
  modelRole: reasoning
  modelTier: standard
---

# Film Retrospective

## Inputs

Read the current state, generation receipts, review records, delivery record, user corrections, and available time/cost evidence for the selected run. Load `aiwg show template film-review-record` for the bounded findings record.

## Workflow

1. Define the reviewed interval and artifacts. Separate what was inspected directly from logs, reported observations, and missing evidence. Do not treat message counts, tool calls, or receipt volume as production quality or elapsed human effort.
2. Build a compact failure register: observed defect, first occurrence, detection stage, escaped/user-found status, repeated method attempts, and affected downstream assets. Distinguish changed user preferences from failures against the then-current requirement.
3. Reconcile provider tasks and charges before aggregating actual cost. Separate estimates, confirmed charges, unresolved charges, active work time, and waiting time. Unknown values stay unknown; do not invent savings or wasted-cost totals.
4. Identify workflow causes supported by evidence, such as stale current state, degraded masters, whole-scene repair regressions, missing playback, or ambiguous speech mode. Retain practices that demonstrably worked.
5. Propose the smallest corrective workflow change and a bounded next test. Measure first-pass acceptance, calls per accepted asset, known-defect promotions, escaped defects, same-method repeats, and actual cost/time where observable.
6. Update the current production record with accepted operating changes and unresolved findings. Modify reusable skills or persistent memory only within explicit authoring authority. Do not schedule a pilot, resume paused production, or incur new generation spend merely because a retrospective recommends it.

## Outputs

Produce a scoped findings record, evidence links, prioritized improvements, and measurable follow-up criteria.

## Continue or hold

Conclude when findings are grounded and next actions have clear scope. State limits when media was not replayed or cost evidence is incomplete. Claim improvement only after a comparable follow-up run supports it.
