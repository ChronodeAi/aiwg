---
type: flow
name: kairos-operate-phase
description: Kairos operate phase with evidence-based exit criteria (gate OP).
---
# Kairos Operate

## Entry
Gate EA holds for the edges the decision uses; the host project defines the decision and its paper mode.

## Activities
Write promoted edges through the retry-safe agent tools; decide with `kairos_resolve`, `/causal/intervene` and `/causal/counterfactual`; teach adaptive edges with `kairos_observe`; save every request and response with hashes; demote edges that fail K evaluations.

Load with `aiwg show skill <name>`: kairos-operate, kairos-status. Template: kairos-pilot-report.

## Outputs and owners
Decision and observation receipts, pilot report.
Owners: kairos-decision-operator, kairos-pilot-orchestrator.

## Exit evidence — OP Operational
Every decision in the period has a receipt; every write carried a durable idempotency key; every live decision has a signed OP packet (`human_go_signoff: true`). Paper outcomes are compared with the naive baseline in the pilot report.
