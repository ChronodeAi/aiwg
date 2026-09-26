---
name: kairos-pilot-report
description: "Report a Kairos pilot milestone: gates, admitted edges, decisions, human effort and feedback sent to Kairos"
---

# Kairos Pilot Report

Pilot id / period (UTC) / node origin, version, profile, `/meta` sha256 / plan sha256 / gate policy sha256:

## Gates
| Gate | Status | Evidence |
|---|---|---|
| CG Connected | | connection record, conformance baseline receipt |
| MB Model Baseline | | proposals with source hashes |
| EA Evidence Admission | | gate evaluations, packets |
| OP Operational | | decision receipts, sign-offs |

## Graph
Proposals / candidates held / admitted (auto) / admitted (human) / rejected / demoted / sign flips.

## Human effort
Escalations by reason / review minutes total and per admitted edge / calibration labels recorded /
escalations the policy could have avoided (with evidence).

## Decisions
Decisions made via Kairos (resolve, intervene, counterfactual) with receipt count / observations applied and
replayed / paper outcome versus the naive baseline / live decisions (must equal signed OP packets).

## Kairos as a product
Conformance pass rate at start and end / findings by kind and severity / issues filed and commented on
`ChronodeAi/kairos` with numbers / known gaps reproduced / gates enforced client-side because the node does not.

## Next
Decisions needed, with the exact question / work that continues without a decision.
State what was measured and what is `[INFERENCE]`.
