---
type: flow
name: kairos-validate-phase
description: Kairos validate phase with evidence-based exit criteria (gate EA).
---
# Kairos Validate

## Entry
Gate MB passed; point-in-time evaluation data exists that no proposer read.

## Activities
Build evidence bundles per window, run `scripts/kairos-gates.mjs`, promote on `auto_promote`, carry history forward, and send escalations to a human as review packets. Record once that the node enforces none of the gates (ADR-0034 U34-C Proposed).

Load with `aiwg show skill <name>`: kairos-validate-evidence, kairos-review-packet. Template: kairos-review-packet.

## Outputs and owners
Bundles, evaluations, packets, decisions, calibration labels.
Owners: kairos-evidence-auditor, kairos-review-clerk.

## Exit evidence — EA Evidence Admission
Every edge written to the node traces to an `auto_promote` evaluation (`kfw_evidence_sha256`) or an approved EA packet; every escalation has a packet; human decisions are recorded as calibration labels with review minutes.
