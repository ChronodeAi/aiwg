---
type: flow
name: kairos-feedback-track
description: Continuous Kairos feedback track that turns observed behavior into evidence-complete issues.
---
# Kairos Feedback (continuous)

## Entry
Any phase. Triggers: a conformance probe run, a node upgrade, or a response that contradicts the docs during real work.

## Activities
Record findings with command, output and sha256, doc citation `file:line` at the node's tag, expected versus observed, and fingerprint; check `fileable`; deduplicate against `ChronodeAi/kairos`; file or comment through MCP/app, then the HTTP API, then `gh`.

Load with `aiwg show skill <name>`: kairos-conformance-probe, kairos-feedback. Templates: kairos-conformance-finding, kairos-feedback-issue.

## Outputs and owners
Findings, issues and comments, and their states in the pilot report.
Owners: kairos-conformance-prober, kairos-feedback-triager.

## Exit evidence
Each open finding is filed, marked duplicate with the issue reference, held with its missing evidence listed, or triaged out with a note. Nothing is filed on a fork or mirror, and nothing without its evidence fields.
