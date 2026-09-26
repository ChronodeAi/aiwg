# Roles and artifacts

| Role | Owns | Hands off to |
|---|---|---|
| kairos-pilot-orchestrator | pilot plan, gates CG to OP, pilot report | all roles |
| kairos-domain-modeler | edge proposals (LLM proposer) | evidence auditor |
| kairos-evidence-auditor | evidence bundles, gate evaluations | decision operator (promote, demote), review clerk (escalate) |
| kairos-review-clerk | review packets, decisions, calibration labels | decision operator |
| kairos-decision-operator | node writes, decision and observation receipts | conformance prober (unexpected responses) |
| kairos-conformance-prober | conformance receipts, findings | feedback triager |
| kairos-feedback-triager | issues and comments on ChronodeAi/kairos | orchestrator (report) |

Templates: kairos-connection-record, kairos-pilot-plan, kairos-review-packet, kairos-pilot-report, kairos-conformance-finding, kairos-feedback-issue. Roles may be played in sequence by one agent; only the decision operator writes to the node, and only a human signs a packet.
