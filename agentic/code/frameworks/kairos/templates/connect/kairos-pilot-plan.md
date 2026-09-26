---
name: kairos-pilot-plan
description: "Scope a Kairos pilot: node, namespaces, domain, gate policy, human boundary and success measures"
---

# Kairos Pilot Plan

Project / pilot id / owner / recorded at (UTC) / plan sha256 (after first save):

## Node
Configured node origin and profile (from `.aiwg/kairos/connection/node.json`) / why this node / who operates it.
The framework never starts, stops, resets or reseeds it.

## Domain and namespaces
Decision the pilot supports (one sentence) / host pipeline and mode (paper by default) /
namespaces the pilot may write / namespaces reserved for conformance probes / approved node types
(kind and namespace per XType; anything else is a new node type and escalates).

## Data
| Dataset | Ref | As-of rule | Availability lag | sha256 recipe | Used for (proposal, evidence, both) |
|---|---|---|---|---|---|

Evaluation data must be disjoint from proposal sources.

## Gate policy
Policy file path and sha256 (copied from `config/gate-policy.json`, becomes `contract_sha256`) /
changes from the default with a reason for each / randomized paper-action design for EA-G6, or why none.

## Human boundary
Humans decide only: live-money or policy-touching edges, gate disagreement, a sign flip on an active edge, a
new node type, signing and capital policy. Reviewer(s) / expected turnaround / where packets are announced.

## Success measures
Admitted edges with receipts / escalation rate and review minutes per admitted edge / decisions made via Kairos
/ paper-versus-baseline outcome / findings filed on Kairos and their states / conformance pass rate at start and end.

## Stop conditions
Node unavailable or wrong version / conformance regressions on claims the pilot depends on / a gate policy
change without a reason / any request to go live without an OP sign-off.
