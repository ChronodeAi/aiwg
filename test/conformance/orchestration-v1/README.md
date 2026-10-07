# Orchestration S0 wiring — #2886 / B-OG-19

This checkpoint starts the deterministic infrastructure from test strategy 09
(levels/ownership and Revision 2 Tier 0 packs) and delivery plan 11 (B-OG-19,
slices and release gates). It does not complete #2886 or any provider's live
qualification. The proposal is read-only and is not required at test time.

`packs.json` registers exactly T-OG-01–12, 14, 15, 17 and 19. `ownerIssue` is
the test-delivery issue, #2886; `mechanismOwners` are the proposal's frozen
work-package owners. `knownCheckpointIssues` maps the tracker IDs supplied for
the concurrent S0 work. No unknown tracker IDs are guessed. `slice` is the owning
mechanism checkpoint; `laterSlices` identifies additional runtime checkpoints.
All current entries are planned or partial, with empty test lists where the
corresponding tests have not landed. Partial mappings include #2876's frozen
schema/CLI/MCP contracts and the existing Grok headless test, plus the new fake
mechanics. They do not claim complete T-OG mechanism or safety coverage.
Route-feasibility (#2877), configuration vectors (#2878), runtime definitions
(#2879) and adapter loading (#2880) must add their test paths as they land.

`npm run lint:orchestration-packs` fails for implemented/partial packs without
test files, missing paths, missing pack ownership, and qualification passes
without scoped live evidence. Its report is
`test-results/orchestration-pack-registry.json`. A successful S0 report says
`wiring-valid` and `releaseQualification: unqualified`; it never says the
release packs passed. To validate a separately authorized qualification report,
run `npm run lint:orchestration-packs -- --qualification-report FILE`. The JSON
document has a `results` array, using the same row format as
`qualificationResults` in the registry:

```json
{"results":[{"id":"missing-binary","qualification":"missing","result":"blocked"}]}
```

Qualification states are `missing`, `unqualified`, `qualified`; result states
are `passed`, `failed`, `blocked`, `unqualified`. A `passed` result requires
`qualified` and `evidence.kind: live` with nonempty `version`, `account`,
`profile`, `transport`, `reportRef`. Account is a synthetic/sanitized identity,
never a credential. Missing, skipped or fake mechanics cannot count as live
qualification. This is a report consistency check; S1 owns actual per-provider
readiness, evidence freshness and qualification.

The existing `config/vitest.conformance.config.js` fixture lane imports
`orchestrationConformanceFiles` from `config/test-lanes.mjs`; those files are
excluded from the default lane. Existing unit files keep their original runner.
The existing CI Test job runs the pack gate and conformance lane and preserves
the registry report and `test-results/conformance-fixtures.json` outcomes
through its existing artifact upload after the conformance step. No workflow, model
call, vendor CLI or credential is added.

## Shared child fixtures

The executables live beside `test/fixtures/ralph-stub-cli.mjs`:

- `ralph-worker-cli.mjs`: real argv/cwd/stdin-at-EOF recording; environment
  names only; output paths from configuration and supported output flags;
  success, exit-zero error, hang, missing/double/truncated final streams.
- `ralph-worker-mcp.mjs`: stdio JSON-RPC initialization, `tools/list`, typed
  `fixture-worker` calls, schema drift, `isError`, content truncation,
  stall/disconnect and correlated late completion after cancellation delivery.
- `ralph-worker-protocol.mjs`: shared synthetic claims and input shape; this
  fixture input shape is not a published schema or a production worker tool.

Set `AIWG_FAKE_WORKER_CONFIG` to a synthetic JSON file with `scenario`,
`recordPath`, optional `scenarioId`, `outputPaths: {final: PATH}` and `worker`.
CLI control configuration stays outside argv so all task arguments are recorded
unchanged. Stdin must be closed. CLI stdout and the final path contain the same
JSONL events; fault scenarios deliberately violate terminal semantics. Output
flags default to `--final-output`, `--output-last-message`, `--output-file` and
can be supplied as `outputFlags` by an owning provider test. All paths must be
owned temporary fixture paths. No environment values are recorded.

MCP calls accept `invocationId`, `workspace`, `selection: {provider, model,
effort}`, and `brief`. Optional `scenarios` maps invocation IDs to scenarios,
allowing different concurrent faults without cross-request state. Call records
are JSONL. `notifications/cancelled` records delivery without claiming stop;
`fixture/release` with `{requestId: ID}` releases only a pending
`late-completion` call. This barrier avoids timing races. Closing stdin or
terminating the fixture disposes all pending synthetic work; there is no remote
worker. Self-tests own watchdogs, wait for child closure and remove temp roots.

## Deferred checkpoint gates

S1 must add each direct/shared mechanism test in its owning issue, including
zero managed-state launch, full provider registry readiness and actual
shell/native-MCP/AIWG-bridge enforcement. Fake equivalence here compares only
synthetic claims, not production resolver/adapter behavior. Revision 3 liveness
packs T-OG-20–24 are outside this S0 assignment.

S2–S5 add managed admission, recovery, bindings and mandatory evidence, plus
the 100-request crash-admission and 1,000-request cached-overhead checks. The
p95 cached plan/admission ≤250ms and dispatch-to-launch ≤5s measurements remain
unexecuted checkpoint gates, not S0 results. Third-adapter extensibility,
all-Must positive/negative traceability and safety mutation targets remain
with their mechanism owners and final audits.

No changed-code coverage hook exists in the inspected lanes; current scoped
coverage jobs use fixed module lists. Changed-code threshold enforcement is
deferred until mechanism code lands: ≥90% statements / ≥85% branches for pure
validators and ≥80% branches for changed adapter/recovery code, with every
declared failure transition and adversarial case. S0 adds no repository-wide
coverage threshold. Direct S1 and later managed results must be reported
separately; managed gates do not block S1.
