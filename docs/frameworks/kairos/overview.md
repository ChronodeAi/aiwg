# kairos Overview

kairos is a provider-neutral framework for running a real project on a live Kairos node and sending evidence of the
node's actual behavior back to the Kairos product. It models the project's domain as a context-resolved causal graph,
admits edges only on evidence, makes decisions through Kairos with receipts, and turns every discrepancy between the
Kairos documentation and the node into a reproducible finding. It does not install, start, reset, or upgrade a Kairos
node, hold keys, or move money.

## Common Use Cases

- Record what a node reports about itself (`/api/v1/meta`, readiness, version, auth mode) before any work starts.
- Prove that a Kairos release behaves as documented with an executable conformance baseline.
- Propose a causal graph for a decision the project already makes, with every proposal hashed to its sources.
- Promote edges automatically when evidence gates pass, and ask a person only for the few decisions that need one.
- Operate in paper mode through `kairos_resolve`, causal interventions, and receipted observations.
- File deduplicated, evidence-complete issues on `ChronodeAi/kairos`.

## Lifecycle

Work moves through **connect → model → validate → operate**, with a continuous **feedback** track.

| Phase | Skills | Output |
|-------|--------|--------|
| Connect | `kairos-connect`, `kairos-conformance-probe` | Connection record, conformance receipt, pilot plan |
| Model | `kairos-propose-graph` | Hashed edge proposals from several proposer families |
| Validate | `kairos-validate-evidence`, `kairos-review-packet` | Gate evaluations, promotions, review packets, calibration labels |
| Operate | `kairos-operate` | Node writes, decision and observation receipts, pilot report |
| Feedback | `kairos-conformance-probe`, `kairos-feedback` | Findings, issues and comments on `ChronodeAi/kairos` |
| All | `kairos-status` | Gate state, pending decisions, review minutes per admitted edge |

## Gates

| ID | Gate | Passes when |
|----|------|-------------|
| CG | Connected | The declared node answers health and readiness, `/meta` is recorded with its hash, the agent auth path works, and a conformance baseline exists |
| MB | Model Baseline | Every candidate edge is a proposal with proposer, proposer family, and source hashes |
| EA | Evidence Admission | Every edge on the node traces to an automatic promotion or an approved review packet; every escalation has a packet |
| OP | Operational | Decisions go through Kairos with receipts; everything is paper unless a person signed off |

## Evidence Admission

Seven client-side gates decide promotion: a naive-baseline margin, agreement of two of three proposer families, a
provenance-appropriate statistic under Benjamini-Hochberg false-discovery control, block and regime stability,
point-in-time walk-forward prediction on data no proposer read, interventional confirmation from randomized paper
actions when available, and K-consecutive hysteresis. The framework runs them because Kairos 2.1.1 does not: its
ADR-0034 accepts only the invariant that an LLM may propose an edge but never admit one, while the gate stack itself is
still Proposed and edges have no candidate status. The framework records that gap as product feedback.

## Human Boundary

Candidates are created freely and never gate action. Promotion is automatic when every gate passes. A person is asked
only for live-money or policy-touching edges, gate disagreement, a sign flip on an active edge, a new node type, or
signing and capital policy. Each decision is recorded as a calibration label, and review minutes per admitted edge are
tracked so the escalation policy can shrink with evidence.

## Core Components

The framework ships one kernel skill, `kairos-quickref`, which routes to 8 operational skills, 7 agents, 6 rules,
5 flows, 6 templates, and 5 schemas.

### Agents

| Agent | Purpose |
|-------|---------|
| `kairos-pilot-orchestrator` | Run the pilot plan and hold gates CG, MB, EA, and OP |
| `kairos-domain-modeler` | Propose nodes and edges as hashed proposals; never admit |
| `kairos-evidence-auditor` | Build evidence bundles, run the gates, decide promote, hold, or escalate |
| `kairos-review-clerk` | Render review packets and record human decisions as calibration labels |
| `kairos-decision-operator` | Write promoted edges and decide through Kairos with idempotency keys and receipts |
| `kairos-conformance-prober` | Probe documented claims on the configured node and record findings |
| `kairos-feedback-triager` | Deduplicate findings and file or comment on `ChronodeAi/kairos` |

### Rules

| Rule | Purpose |
|------|---------|
| `kairos-llm-proposes-never-admits` | Model output is a proposal; only gates or a recorded human decision admit an edge |
| `kairos-point-in-time` | No look-ahead; every dataset is referenced as-of with a hash |
| `kairos-provenance-hash` | Every proposal, packet, and finding carries source hashes and a UTC `recorded_at` |
| `kairos-paper-before-live` | No live money or signing without a recorded human sign-off |
| `kairos-feedback-evidence` | A finding needs the exact command, output, doc citation, and expected versus observed |
| `kairos-node-isolation` | Touch only the node the project declared; never probe or switch to another |

## Relationship to Other Frameworks

kairos packets share the AIWG gate record's fields (`schema`, `recorded_at`, `gate`, `status`, `recommendation`,
`human_go_signoff`, `contract`, `contract_sha256`), so an SDLC gate can cite them directly. The host project keeps its
own release gates; kairos adds evidence about the Kairos-backed decisions inside them.

## References

- [Quickstart](quickstart.md) — Deploy and pass the Connected gate
- [Framework README](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/kairos/README.md) —
  Human boundary, gates, scripts, and catalog
- [Kairos surfaces](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/kairos/docs/surfaces.md) —
  Routes, auth, expected gaps, and documentation drift with citations
- `@$AIWG_ROOT/agentic/code/frameworks/kairos/skills/kairos-quickref/SKILL.md` — Routing entry point
