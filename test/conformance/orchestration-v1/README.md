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

## #2885 S1 installation qualification checkpoint

`ProviderAdapter.inspectWorkerInstallation` computes the host-owned scope before
negative qualification. It binds canonical executable bytes, installed driver
and declared runtime dependency digests, exact CLI version, profile/control
metadata, account scope, effective configuration digest, workspace, writable
roots, explicitly supplied environment and endpoints, and enforcing boundary.
The host supplies an installed-module allowlist using #2880's loader contract;
metadata cannot download or import a new executable. The host must protect the
installation and its complete dependency closure against concurrent mutation.

`qualifyWorkerInstallation` requires negative-case evidence bound to that scope
and the shipped `workerNegativeFixtureSuite` definition (hash it with
`workerNegativeFixtureDigest()`). Arbitrary or obsolete fixture digests are
rejected. Provider IDs use the existing provider-definition registry's aliases,
case folding and whitespace trimming. Providers without a permission row require
an external boundary and every negative case, including third-party modules.
It then runs only the declared version probe (closed stdin, empty environment
except explicit allowed names, at most 10 seconds and 5 MiB). Failure returns
DISABLED without raw output. A successful result is host qualification data,
not task authority. Copy its four evidence fields into the selected profile's
`installationQualification`. For MCP, capture `workerServerDigest` before the
probe as `mcpServerDigest`; the returned server digest must match registration's
`authorizedServerDigest`. Typed registry methods persist and recheck that binding.
The legacy `.mjs` registry writer invalidates bindings but cannot mint them.
Both registry variants and installation scopes use the same canonical JSON
SHA-256 helper and `sha256:` encoding. The MCP binding also records the mandatory,
validated `requiredControls` set; changing it invalidates qualification.

When a scoped profile is passed to `prepareWorkerInvocation`, supply its current
installation context. Preparation rechecks scope, evidence, canonical cwd,
exact driver-owned `buildWorkerArgs`, stdin and the explicitly named current
environment. It retains #2884's canonical model-policy predicates. Reprepare
after changing the environment or installation and immediately before handoff;
a copied shell command is not an immutable authority token. Unscoped legacy
preparation remains a pure mapping helper, not proof of installation readiness.
Direct shell preparation never needs executor registration or an MC directory.
Native process controls must map to an exact argv flag or a JSON array of
contiguous argv tokens. Supply a representative `invocation` when qualifying
such profiles; qualification checks the driver's generated argv and binds it
into the scope. Preparation checks the actual invocation's mappings again.
External controls are covered by the named enforcing boundary, with declared
argv tokens checked as well when the external mapping uses a flag or JSON array.
Pinned executor selection now checks the same required capabilities as automatic
selection, without implementing managed dispatch.

The added tests register T-OG-03/10/14/15/17/19 as **partial**. Synthetic Codex,
Muse, Claude and Hermes profile mappings exercise native/external requirements;
no vendor installation is enabled. Each synthetic OS/executor boundary uses
Node permission flags through the prepared CLI command for actual denied
sibling/home writes, with a permitted-write control. MCP uses the same negative
fixture. Revision 2 records endpoint allowlist decisions as mapping-only data
and separately attempts an actual TCP connection to `127.0.0.1:1`. Tests observe
the connect call and socket outcome (`ECONNREFUSED`, `EPERM`, or `EACCES`); the
connection count comes from socket events. A refused or blocked loopback probe
does not prove allowlist enforcement or OS network isolation, so the pack remains
**partial**. Temporary roots and children are cleaned up. Existing #2880
third-module and #2884 package tests
retain ownership of extensibility and both installed package targets.

Native HTTP/local text installation qualification remains DISABLED here until
its local transport driver checkpoint supplies qualified probes; no implicit
server startup or network requests occur. Provider live qualification, native
MCP worker eligibility and doctor coverage remain their separate S1 owners.
Managed admission, verifier runners, fencing and lifecycle integration are
**deferred to S2+**. Sandbox EPERM/EROFS failures must be reported as environmental,
not converted into passing qualification or bypassed by test skips.

Initial validation before the review fixes in the restricted #2885 worktree (2026-10-07):

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass; no TypeScript errors |
| `npm run lint:schemas` | Pass; 236 strict compiles, 0 errors, 2 existing fixture-marker warnings |
| `npm run lint:orchestration-packs` | Pass; 16 packs, release remains unqualified |
| `npx vitest run --config config/vitest.config.js test/conformance/mission-v1/ test/unit/models/ test/unit/config/ test/unit/ralph-external/` | 1,524 passed, 38 failed, 1 skipped |
| `npx vitest run --config config/vitest.conformance.config.js test/conformance/orchestration-v1/` | 23 passed, 16 failed |
| `npx vitest run --config config/vitest.config.js test/unit/mcp/worker-qualification.test.ts test/unit/mcp/registry.test.ts test/unit/serve/executor-registry.test.ts` | 546 passed, 1 failed |
| `npx vitest run --config config/vitest.conformance.config.js test/conformance/mission-v1/` | 142 passed, 0 failed |
| `npx vitest run --config config/vitest.packaging.config.js test/integration/worker-adapter-package.test.ts` | Blocked before test collection by `listen EPERM` on the packaging TSX IPC socket |
| `node tools/mission-protocol/inventory.mjs --write` | Blocked by `spawnSync rg EPERM`; no new Mission files were added |

The required unit run has 12 new process-dependent failures and 26 existing
fixture failures. The new failures are four fake version probes and eight fake
MCP negative probes; all eight prepared CLI negative scenarios pass. Existing
failures include blocked child spawning and eight Git fixture commit-setup
failures. The separate MCP registry failure is its fake `tools/list` child.
The orchestration lane fails existing child/IPC mechanics. A minimal nested
Node `spawnSync` returned `EPERM`, exit status 0, and empty stdout/stderr: zero
status is not usable qualification evidence in this environment. These failures
were not skipped, and no sandbox bypass was added. All test-owned temporary
roots were removed; no real credentials, vendor calls or sockets were used by
the original qualification fixtures (revision 2 adds the loopback probe above). Re-run blocked gates on an authorized runner
before accepting the S1 installation checkpoint.
