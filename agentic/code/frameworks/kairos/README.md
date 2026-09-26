# Kairos

Put a live Kairos node to work on a real project: model the domain as a context-resolved causal graph, admit edges on evidence, operate on it, and feed conformance findings back to Kairos.

Lifecycle: **connect → model → validate → operate**, plus a continuous **feedback** track. Start with [kairos-quickref](skills/kairos-quickref/SKILL.md). It routes to 8 operational skills, 7 agents, 6 rules, 6 templates, 5 schemas and 5 flows. The framework talks only to the node the project declares; it never installs, starts, resets or upgrades Kairos.

## Use

```sh
aiwg use kairos --provider codex
aiwg discover "kairos review packet" --limit 3
aiwg show skill kairos-quickref
aiwg show skill kairos-connect
aiwg show template kairos-pilot-plan
```

Reload the provider session after deployment for the new kernel skill and agents. Standard skills are retrieved through discovery.

## Gates

| Gate | Passes when |
|---|---|
| CG Connected | the declared node answers `/api/v1/health` and `/api/v1/health/ready`, `/api/v1/meta` is recorded with its sha256, the agent auth path works, and a conformance baseline receipt exists |
| MB Model Baseline | every candidate edge is a proposal with proposer, proposer family and source sha256 |
| EA Evidence Admission | every edge on the node traces to an `auto_promote` gate evaluation or an approved review packet; every escalation has a packet |
| OP Operational | decisions went through Kairos with receipts; everything is paper unless an OP packet carries a human sign-off |

## Minimal human-in-the-loop policy

- Candidate edges are created freely (as proposals, optionally mirrored to the node behind a role nobody sends) and never gate action.
- Promotion to active is automatic when every evidence gate passes (`scripts/kairos-gates.mjs` decision `auto_promote`).
- A human is asked only for: live-money or policy-touching edges, gate disagreement, a sign flip on an active edge, a new node type, or signing and capital policy.
- Each human decision is recorded as a calibration label (`packets/calibration-labels.jsonl`), so the escalation policy can shrink with evidence.
- Review minutes per admitted edge are tracked (`scripts/kairos-records.mjs status`) and reported per milestone.

## Evidence gates, and what Kairos enforces

The client-side gates are EA-G1 naive-baseline margin, EA-G2 two of three proposer families, EA-G3 a provenance-appropriate statistic under Benjamini-Hochberg FDR control, EA-G4 block and regime stability, EA-G5 point-in-time walk-forward prediction on data no proposer read, EA-G6 interventional confirmation from randomized paper actions when available, and EA-G7 K-consecutive hysteresis. Defaults are in [config/gate-policy.json](config/gate-policy.json).

Kairos 2.1.1 enforces none of them: ADR-0034 accepted only "an LLM may propose, never admit" (U34-A); the gate stack (U34-C) is Proposed, and edges have no candidate/active status yet (U34-B). A vector on the node is live for resolution. The framework therefore runs the gates before any write and records the gap as a finding. What the node enforces is listed in [kairos-validate-evidence](skills/kairos-validate-evidence/SKILL.md).

## Workspace

`aiwg use kairos` creates `.aiwg/kairos/{connection,proposals,evidence,packets,decisions,observations,conformance,findings,reports}`. Records are JSON with `recorded_at` (UTC) and sha256 provenance; schemas are in [schemas/](schemas/) and examples in [examples/](examples/) (synthetic; format only).

## Scripts

Run from the project root with `FW="$AIWG_ROOT/agentic/code/frameworks/kairos"`:

- `. "$FW/scripts/kairos-env.sh"` — `KAIROS_URL` from `node.json` (refuses a different one), `kcurl`/`kget`/`kpost`/`kmcp`/`ktool` with the bearer token passed through a file descriptor, `kkey` durable idempotency keys, `ksave` save-and-hash.
- `node "$FW/scripts/kairos-connect.mjs"` — connection record and gate CG.
- `node "$FW/scripts/kairos-gates.mjs" <bundle>` — gate evaluation and decisions.
- `node "$FW/scripts/kairos-records.mjs" <validate|fingerprint|fileable|render-packet|issue-body|sha256|status>` — record validation, packet and issue rendering, workspace status.

They check recorded data. They cannot prove a command was run, authenticate a reviewer, or show that Kairos behaved as recorded.

## Catalog

[Lifecycle](plan-act-kairos.md) · [Roles and templates](actors-and-templates.md) · [Metrics](metrics/tracking-catalog.md) · [Kairos surfaces used](docs/surfaces.md) · [Integration and verification](docs/integration.md)

Rules: `kairos-llm-proposes-never-admits`, `kairos-point-in-time`, `kairos-provenance-hash`, `kairos-paper-before-live`, `kairos-feedback-evidence`, `kairos-node-isolation`. Schemas: `review-packet`, `finding`, `connection-record`, `edge-proposal`, and `conformance-claim` (owned by the conformance probe suite).

## Scope

Installing the framework creates no node, token, edge, issue or trade. Feedback goes only to `ChronodeAi/kairos`. Live money and signing stay with the host project and a named human.
