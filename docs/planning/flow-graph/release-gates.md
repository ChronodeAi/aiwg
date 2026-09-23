# Flow Graph Capability Release Gates

Public documentation may describe the optional alpha profile only. It must not
claim quality, latency, reliability, or cost improvement until every blocking
gate below is supported by current evidence.

| Gate | Blocking evidence | Current state |
|---|---|---|
| Architecture | #2127 ADR and decision guide | Implemented and verified |
| Schema | #2128 profile validator and invalid fixtures | Implemented and verified |
| Runtime identity | #2129 end-to-end metadata | AIWG core implemented; live Sandbox evidence pending |
| Runtime projection | #2130 mixed node dispatch and restart resume | Static/core path implemented; live qualification pending |
| Sandbox | sandbox #780–#784, bridge #2, and conformance #4 | Wire contract implemented in AIWG; runtime (`d16a08d`…`594e2ae`), bridge (`0df1f78`), and opt-in live profile (`2c8540b`) are on their `main` branches with green CI as of 2026-09-13, but the sandbox owner's 2026-09-12 audit (#850) keeps #781–#784 open for named criterion-to-test gaps and no live conformance result is recorded — still blocking |
| Cockpit | #2131 read-only view and UI tests | Implemented and verified |
| Security | #2135 threat/control/degraded-mode artifacts | Implemented; live Sandbox/adapter evidence remains externally gated |
| Conformance | #2134 fast and full suites | 11-case fast suite and pinned CI job implemented; full Sandbox gate pending |
| Evaluation | #2118 defensible evidence | Issue complete; evidence remains synthetic, so empirical product claims stay blocked |
| Docs/templates/site | #2132 and #2125 | Addon/templates and the approved `flow.aiwg.io` deployment plan are complete; live site activation is an operator change |

Deferred external behavior is blocking for a public “complete graph runtime”
claim, not silently waived. The optional static profile may ship with these
limitations stated in release notes.
