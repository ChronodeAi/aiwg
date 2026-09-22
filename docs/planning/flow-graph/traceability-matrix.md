# Flow Graph Capability Traceability Matrix

| Requirement | Architecture / docs | Implementation | Verification | Status / limitation |
|---|---|---|---|---|
| GRAPH-REQ-001 | graph ADR and decision guide | graph-pattern manifest | graph-pattern schema tests | Implemented; optional addon only |
| GRAPH-REQ-002 | graph-pattern README | graph schema and validator | graph-pattern invalid fixtures/tests | Implemented |
| GRAPH-REQ-003 | metadata namespace and Sandbox node wire contract | graph metadata, Mission, telemetry, observer, Cockpit | metadata/Mission/observer/Cockpit and wire-schema tests | AIWG path and cross-repo contract implemented; Sandbox pass-through implemented on sandbox `main` (see external reconciliation) but its cancellation-path identity assertion is still open under sandbox #783 |
| GRAPH-REQ-004 | addon adapter guidance | graph runtime, MissionConductor, stack adapters | runtime and Mission tests | Core bindings represented; Sandbox node runtime and bridge implemented externally, restore/resume completion evidence still open under sandbox #782/#784 |
| GRAPH-REQ-005 | ADR, profile README, and threat model | inherited Flow rules plus reducer/HITL/authority/replay checks | validator/runtime/security tests | Implemented; live adapter qualification remains external |
| GRAPH-REQ-006 | Cockpit surfaces doc | read-only bridge and Missions view | Cockpit web/bridge tests | Implemented; visual editor deferred |
| GRAPH-REQ-007 | test strategy, threat model, and release gates | dry-run/replay/conformance commands and pinned CI job | 11-case fast graph conformance plus security tests | Fast subset implemented; opt-in live Sandbox profile implemented (conformance `2c8540b`) but no machine-readable live run has been recorded against a current sandbox `main` |
| GRAPH-REQ-008 | ADR, guide, release fragment | graph-pattern skill/README/scaffold and five templates | validation and discovery/docs gates | Templates validate; `graph flow profile` ranks the addon skill first |

## Issue-to-requirement map

| Issue | Requirements |
|---|---|
| #2127 | GRAPH-REQ-001, GRAPH-REQ-008 |
| #2128 | GRAPH-REQ-002, GRAPH-REQ-005 |
| #2129 | GRAPH-REQ-003 |
| #2130 | GRAPH-REQ-003, GRAPH-REQ-004, GRAPH-REQ-005 |
| #2131 | GRAPH-REQ-003, GRAPH-REQ-006 |
| #2132 | GRAPH-REQ-001, GRAPH-REQ-004, GRAPH-REQ-008 |
| #2133 | GRAPH-REQ-001–008 |
| #2134 | GRAPH-REQ-002, GRAPH-REQ-005, GRAPH-REQ-007 |
| #2135 | GRAPH-REQ-003–007 |

## External evidence reconciliation — 2026-09-13

Verified against the Gitea API on 2026-09-13 (commit ancestry via `compare`,
workflow runs via `actions/runs`). Read-only; no external issue was mutated.

| Repository | Implementation commits | On `main`? | CI evidence | Open acceptance gaps (owner's 2026-09-12 audit, sandbox #850) |
|---|---|---|---|---|
| roctinam/agentic-sandbox | `d16a08d` (graph-node semantics), `9a140c4` (restart recovery), `a2bd7a9` (missing/redacted evidence), `6ef5144` (WebSocket cancel parity), `594e2ae` (Celld gate fix) | Yes — all ancestors of `main` (`2039aee` audited; head `b9c6826` on 2026-09-13) | Main CI 57381 all eight jobs green at `2039aee`; conformance 57382, host 57386, macOS 57387 green | #781 signal-vs-other terminal distinction and graph cancellation evidence through the terminal observer; #782 combined resumable/non-resumable + replay/idempotency/evidence matrix; #783 identity/evidence envelope preserved through cancellation; #784 restored/resumed task completion and restore-failure propagation. Sandbox roadmap #850 schedules this "after the Kelos/Xfce first milestone". |
| roctinam/agentic-sandbox-aiwg | `0df1f78` (bridge), `530a59d`, `a8624b6` (CI fixes) | Yes — head `7899dfe` | Latest runs 59801/59414/59258 success | Issue #2 open; no criterion-to-test audit recorded since the 2026-08-23 contract handoff. |
| roctinam/agentic-sandbox-conformance | `2c8540b` (opt-in live profile) | Yes — is `main` | Run 43757 success at `2c8540b` | Issue #4 open; profile exists but no live machine-readable result against a current sandbox build has been published. |

Consequence for this matrix: GRAPH-REQ-003/004/007 move from "external
implementation pending" to "external implementation delivered, acceptance
evidence incomplete". The epic (#2126) stays open until the four sandbox gaps
above are closed by direct tests and a live conformance run is recorded.
