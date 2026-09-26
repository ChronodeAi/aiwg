---
id: kairos-llm-proposes-never-admits
name: Kairos LLM Proposes, Never Admits
description: An LLM may propose a Kairos edge; only the evidence gates or a recorded human decision may admit it.
enforcement: critical
triggers:
  - "can the model add this edge to kairos"
  - "write the proposed edges to kairos"
  - "admit an llm proposed edge"
  - "promote a candidate edge"
---

# Kairos: LLM Proposes, Never Admits

## Scope

Applies to every agent that creates, promotes or edits an edge (vector) on a Kairos node for a project using this framework. It restates Kairos's own accepted invariant, ADR-0034 Decision 3 (unit U34-A, accepted 2026-09-24): "An LLM may propose an edge. It may never admit one." (`.aiwg/architecture/adr-0034-causal-evidence-state-and-admission.md:40,122` at `v2.1.1`).

## Requirements

- LLM output becomes a proposal record under `.aiwg/kairos/proposals/`, with proposer id, proposer family, the prompt or method reference, and the sha256 of every source it read. A proposal is never an admitted edge.
- Kairos 2.1.1 has no candidate or active edge status (ADR-0034 U34-B is ACCEPT-LATER). Any vector written to the node can be admitted by resolution. Therefore no agent calls `create_vector`, `POST /api/v1/vectors` or `PUT /api/v1/vectors/{id}` for an edge until `scripts/kairos-gates.mjs` returns `auto_promote` for it, or a review packet records `decision.outcome: approve`.
- The only exception is a candidate mirror whose vector parameters require the context role `kairos-candidate` (see `kairos-propose-graph`). Operate-phase requests never send that role, so a mirrored candidate never gates action.
- An LLM proposer counts as one proposer family in gate EA-G2. Two LLMs from the same vendor are one family. Agreement between LLMs does not replace the statistical, walk-forward or interventional gates.
- Weights, signs and mechanism parameters derived from LLM text are proposal fields, not node writes. Kairos's own `src/causal/live_providers.py:276-300` writes LLM-derived causal weights directly (known gap C6); do not call that path from this framework, and record any observed use as a finding.

## Required response

When asked to "just add" a model-suggested edge, write the proposal, run the gates, and report the gate result. If the requester is a human who wants to bypass the gates, record their decision in a review packet with reason code `HUMAN_OVERRIDE` before any write.
