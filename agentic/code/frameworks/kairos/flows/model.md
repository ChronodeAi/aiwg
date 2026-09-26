---
type: flow
name: kairos-model-phase
description: Kairos model phase with evidence-based exit criteria (gate MB).
---
# Kairos Model

## Entry
Gate CG passed; the pilot plan lists approved node types, writable namespaces and hashed datasets.

## Activities
Propose XTypes and candidate edges from several proposer families (LLM vendors, statistical screens, domain rules); check acyclicity with `POST /api/v1/causal/validate-dag`; hash every source.

Load with `aiwg show skill <name>`: kairos-propose-graph.

## Outputs and owners
Validated `kairos_edge_proposal/v1` files under `.aiwg/kairos/proposals/`.
Owners: kairos-domain-modeler, kairos-pilot-orchestrator.

## Exit evidence — MB Model Baseline
Every candidate edge has at least one proposal that validates with source sha256 values and `recorded_at`; new node types are flagged. No edge has been written to the node except through the optional role-gated candidate mirror.
