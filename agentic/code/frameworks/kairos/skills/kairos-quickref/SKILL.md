---
name: kairos-quickref
namespace: aiwg
platforms: [all]
kernel: true
description: Route live Kairos node work (connect, causal graph proposals, evidence gates, review packets, operate, conformance feedback) to the kairos skills.
triggers:
  - kairos
  - kairos node
  - kairos pilot
  - kairos causal graph
  - kairos conformance
  - kairos review packet
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Kairos — Quick Reference

Use when a project runs on a live Kairos node: a context-resolution engine whose relationships (vectors) between typed objects (XTypes) are executable rules admitted per request. One lifecycle: **connect → model → validate → operate**, plus a continuous **feedback** track that sends evidence of Kairos's real behavior back to `ChronodeAi/kairos`.

## Discover then load

Run `aiwg discover "<phrase>" --limit 3`, then `aiwg show skill <name>`.

| Need / discovery phrase | Skill |
|---|---|
| connect to a kairos node | kairos-connect |
| kairos conformance probe | kairos-conformance-probe |
| propose a kairos causal graph | kairos-propose-graph |
| validate kairos edge evidence | kairos-validate-evidence |
| kairos review packet | kairos-review-packet |
| operate on kairos with receipts | kairos-operate |
| file kairos feedback issue | kairos-feedback |
| kairos pilot status | kairos-status |

Roles: `aiwg show agent kairos-pilot-orchestrator` (and domain-modeler, evidence-auditor, review-clerk, decision-operator, conformance-prober, feedback-triager). Rules: `kairos-llm-proposes-never-admits`, `kairos-point-in-time`, `kairos-provenance-hash`, `kairos-paper-before-live`, `kairos-feedback-evidence`, `kairos-node-isolation`. Templates: `aiwg show template kairos-pilot-plan` (also connection-record, review-packet, pilot-report, conformance-finding, feedback-issue).

## Gates

| Gate | Passes when |
|---|---|
| CG Connected | the declared node answers health and readiness, `/api/v1/meta` is recorded, the agent auth path works, a conformance baseline exists |
| MB Model Baseline | every candidate edge is a proposal with proposer, family and source sha256 |
| EA Evidence Admission | every edge on the node traces to an `auto_promote` evaluation or an approved packet |
| OP Operational | decisions go through Kairos with receipts; paper unless a human signed off |

## Human boundary

Candidates are created freely and never gate action. Promotion is automatic when every evidence gate passes. A human is asked only for live-money or policy-touching edges, gate disagreement, a sign flip on an active edge, a new node type, or signing and capital policy. Decisions become calibration labels; review minutes per admitted edge are tracked.

## Facts to keep straight (Kairos 2.1.1)

- Workspace: `.aiwg/kairos/`; the node is whatever `.aiwg/kairos/connection/node.json` declares, never a guessed port.
- Writes that are retry-safe: `POST /api/v1/agent/tools/execute` (`create_xtype`, `create_vector`) and observations (`kairos_observe`, `POST /api/v1/observations`, admin). Every write carries a durable `idempotency_key`.
- MCP `POST /mcp`: JSON only, protocol `2025-11-25`, 9 tools; requests with an `Origin` header are refused.
- The ADR-0034 gate stack is Proposed, so the framework enforces the gates client-side (`scripts/kairos-gates.mjs`) and records that as a product gap.
- Expected gaps: C1 empty resolve `trace`, C2 no store revision in resolve, C4 hard 0.618 adaptive threshold on a point estimate, C6 LLM-derived causal weights written directly.
