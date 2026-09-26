---
type: flow
name: kairos-connect-phase
description: Kairos connect phase with evidence-based exit criteria (gate CG).
---
# Kairos Connect

## Entry
An operator names the node the project will use and how tokens are issued.

## Activities
Declare the node in `.aiwg/kairos/connection/node.json`; record health, readiness, `/api/v1/meta`, MCP initialize and tools, and the agent auth path; run the conformance baseline; write the pilot plan.

Load with `aiwg show skill <name>`: kairos-connect, kairos-conformance-probe. Template: kairos-pilot-plan.

## Outputs and owners
Connection record, conformance receipt, pilot plan with namespaces and gate policy hash.
Owners: kairos-pilot-orchestrator, kairos-conformance-prober.

## Exit evidence — CG Connected
`connection-record.json` has `gate_cg.status: PASS`: the node answers health and readiness, `/meta` is saved with its sha256, the auth path is verified, and a baseline receipt is attached. Findings from the baseline go to the feedback track; they do not block the pilot unless a claim the pilot depends on fails.
