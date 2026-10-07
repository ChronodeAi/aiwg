# Frozen worker contracts — B-OG-01 / #2876

This is the S1 **direct/shared fixture checkpoint**, based on the read-only
multi-cli-orchestration proposal dated 2026-10-07: delivery plan B-OG-01,
configuration spec §§2–5 and test strategy T-OG-01/08/14/15/17/19 (Revision 2
Tier 0 packs). The latest source includes optional Revision 3 health definitions;
historical five-feature dispatch records and six-feature records both have shape
vectors. Health monitoring and lease reconciliation are not implemented here.

The fragment files are verbatim JSON contracts from configuration spec §4/§5.1.
They have **no new published schema IDs**. The conformance helper merges them
in memory into the existing owners, preserving IDs, dialects, closed objects and
unrelated extensions. `manifest.json` binds each fragment to its source section,
existing owner, merge location and SHA-256. Tests never need the gitignored
proposal, vendor CLIs, credentials, account data, inference or managed services.

The planned command/tool descriptors are executable **input and output schema
fixtures**, not registered handlers or an advertisement that proposed flags work.
`worker-resolve` and `worker-invoke` are distinct from the unchanged, session-bound
`mission-dispatch`. Invocation accepts a typed resolved invocation and direct
brief, rejects preparatory input and top-level raw command/server/verification properties,
and returns worker claims separately from observed execution. Schema validation
cannot prove expiration, authorization, path containment, exact artifact identity,
profile qualification or cancellation; their consumer boundaries remain owned by
the drafts below. No additional operator-confirmation field is introduced.

`--json` stays the JSON-format compatibility alias. Shell rendering is POSIX
sh/bash; unsupported renderers require the diagnostic/typed descriptor specified
by B-OG-33. MCP output pins registered server/tool/arguments, input/output schema
digests, timeout and session isolation. Config paths stay under `parallelism`;
model preferences stay under `models.json.defaults.workerSelection`. No `mc groups`
namespace exists. MC dispatch queues; MC run executes.

`mission-vectors.json` preserves the test strategy's eight original scenario IDs
and adds direct/shared positives and targeted negative deltas. Direct parent may
be absent/null/conductor-session; direct brief has no lease. Direct accepted
results allow null runner and empty artifact-evidence references but require
verifier identity, exact artifact-digest shape, controlled context and findings.
Managed parent, brief lease/decision, and accepted runner/artifact evidence remain
required. Both variants share closed `workerClaims`; a worker cannot supply trusted
execution or verification. A valid digest's correspondence to the actual artifact
is a runtime check, not a shape claim.

`negotiation-vectors.json` is an executable reference oracle for revision, bundle
digest, required-feature and lossless-codec negotiation. It rejects unknown/absent
required worker support before a prospective data handoff. It does not enable
production negotiation. The canonical codec is tested for actual lossless
extension round trips; other consumers advertise no worker support in
`consumer-inventory.json` until their own conformance and boundary work passes.

## Disposition and consumer ownership

Every disposition below names an owning draft and consuming source owner.
The machine-readable consumer inventory extends the existing Mission matrix
without altering its established consumer IDs. Downstream issues should extend
this corpus and apply its vectors to their production validators/boundaries,
retaining scenario IDs and documenting any reviewed contract revision.

| Disposition | Owning draft / issue | Consumer | This checkpoint / next checkpoint |
|---|---|---|---|
| Public vocabulary and compatibility corpus | B-OG-01 / #2876 | CLI handlers, MCP orchestration, Mission schema tests | S1 fixture gate delivered here |
| Group/CLI/model field shapes, merge restrictions, model observations | B-OG-29 / #2878; B-OG-02/04 | `src/config/aiwg-config.ts`, `src/config/cli.ts`, `src/models/config-loader.ts`, `src/models/provider-policy.ts` and existing config/model schemas | Frozen field fragments and initial shape vectors; downstream adds semantic vectors and production validation |
| Managed coherent activation and copy inventory | B-OG-29; B-OG-02/04 | Existing config/model writers and MC preflight | Marker shape frozen; managed writer/lock/admission assertions **deferred S2+** |
| Shared and managed Mission definitions, producer separation, required-feature negotiation | B-OG-30 / #2879 | `schemas/mission-v1.schema.json`, `src/mission-protocol/types.ts`, `src/mission-protocol/codecs.ts`, executor consumers | Reviewable version-1 definitions and compatibility/negotiation vectors; downstream ships definitions and fail-closed consumer guards |
| Closed capability root and trusted installed module loader | B-OG-31 / #2880; B-OG-06 | `schemas/models/provider-model-capabilities.v1.schema.json`, `src/models/provider-policy.ts`, Ralph `registerProvider` factory | Frozen root patch and adapter/profile fragments; downstream implements trusted loader/digest/version/export checks |
| Exact command rendering, unsupported syntax, stale/denied exclusions, Muse consumer mismatch | B-OG-33; B-OG-04 | `src/cli/handlers/models.ts`, `src/models/resolver.ts` | Flag/alias/transport fixtures and actual fake POSIX command capture; runtime renderer/resolver remains S1 downstream work |
| Read-only worker resolution and bounded authorized invocation | B-OG-35 | `src/mcp/tools/orchestration.mjs`, `src/mcp/server.mjs`, `src/mcp/registry.ts`, `src/mcp/profiles.ts` | Frozen descriptors and negative inputs; runtime bridge/native transport, concurrency/disconnect/late-call assertions belong to B-OG-35 |
| Doctor group readiness and steward model guidance | B-OG-18 | `tools/cli/doctor.mjs`, `src/cli/handlers/steward.ts` | Existing namespace flag fixtures; runtime direct readiness/diagnostics remain S1 downstream work |
| Provider and alias completeness, actual transport qualification | B-OG-27/47; B-OG-07/08/09/28/36–45/48 | Capability matrix, provider definitions, model policy, qualified invocation profiles | Every current provider plus local text has row, owner and consumer; all fixture rows explicitly unqualified; enabled live qualification remains S1 downstream work |
| Direct lifecycle, protected verification, optional receipts | B-OG-13/14/15/34 | Conductor, existing launcher/result/evidence owners | Direct schema independence and synthetic shell mechanics delivered; end-to-end lifecycle/verification remains S1 downstream work |
| MC brief/group/decision and Mission/Flow/Ralph bindings | B-OG-16/23; B-OG-30 | `src/cli/handlers/mc.ts`, Mission conductors, composition-engine validator/runtime, Ralph | Vocabulary, offline Flow value-schema mappings and consumer inventory delivered; Mission/MC lifecycle, completion and accounting **deferred S2+** |
| Leases, admission, fencing, cancel/reconcile | B-OG-10/12/16 | `src/serve/shared-host-scheduler.ts`, existing admission store, MC/Mission owners | Required managed data shape retained; managed runtime assertions **deferred S2+** |
| Optional health definitions and required-feature compatibility | B-OG-49/50/54/55; B-OG-12/16 for enforcement | Existing launcher/adapters, Mission codecs, scheduler | Five/six-feature shape compatibility only; health-to-lease mappings owned by B-OG-54 and managed enforcement **deferred S2+** |
| Catalog editor annotation discrepancy | B-OG-29 / #2878 | `schemas/models/model-catalog.v1.schema.json`, catalog loader | Existing catalog payload validates; its checked-in `$schema` annotation is undeclared by the closed owner. Test records the exact annotation explicitly; no root is opened here |

## Test lane and evidence limits

- `test/conformance/mission-v1/worker-contracts.test.ts`: T-OG-01/08/14 shared
  shapes, legacy schemas, managed-required negatives, actual canonical codec
  round trips, offline cross-dialect Flow bindings and negotiation reference oracle.
- `test/unit/cli/handlers/models-worker-contracts.test.ts`: T-OG-15 flag/alias
  catalog, actual legacy handler compatibility, a zero-managed-state direct schema
  pair, fake POSIX argv/cwd/stdin/environment-name/output capture, cleanup, and
  T-OG-19 inventory/alias reconciliation. The injection-shaped prompt is literal
  data; malformed group/transport/format syntax is rejected by descriptor vectors.
- `test/unit/mcp/worker-contracts.test.ts`: T-OG-17 frozen input/output descriptors,
  schema pin/isolation requirements and unchanged actual Mission tool descriptor.

Run all three with `npx vitest run --config config/vitest.config.js <files>` and
`npm run typecheck`. These run in existing default Vitest lanes. Temporary roots
are owned by the tests and removed; the fake child has a finite deadline, closed
stdin after the synthetic brief and bounded output. No paid/live qualification or
full provider drivers, packaged adapter loading, MCP transport chaos, managed
Mission runtime, leases or admission is claimed by these passing fixture packs.

## Validation evidence (2026-10-07)

`npm run typecheck`: passed (exit 0).

Final Vitest invocation:

```sh
npx vitest run --config config/vitest.config.js \
  test/conformance/mission-v1/worker-contracts.test.ts \
  test/unit/mcp/worker-contracts.test.ts \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/conformance/mission-v1/mission-protocol.test.ts \
  test/unit/mission-protocol/inventory.test.ts \
  test/unit/mission-protocol/migration.test.ts \
  test/unit/cli/handlers/models.test.ts \
  test/unit/mcp/orchestration.test.ts \
  test/unit/mcp/orchestration-flows.test.ts \
  test/unit/models/provider-policy.test.ts \
  test/unit/config/aiwg-config.test.ts
```

New suites: **105 passed, 0 failed** (81 Mission/schema, 18 MCP, 6 CLI/inventory).
Related existing suites: **241 passed, 5 environmental failures**; combined:
**346 passed, 5 failed**, nine passing files and two failing files.

Four failures are in the existing Mission inventory suite: its synchronous Node
subprocesses are denied with `EPERM`; the final assertion sees empty subprocess
stderr instead of its expected outside-workspace diagnostic. One existing models
handler test fails with `EROFS` attempting to write the home model-catalog cache.
Neither sandbox restriction was bypassed or changed. These failures are not passes.

Sanitized fixture evidence: the real fake shell child produced exactly the frozen
argv (including quotes, spaces, Unicode, newline, leading-dash text and literal
command-substitution text), assigned cwd, synthetic brief stdin, separate output
paths and environment names `OLDPWD`, `PATH`, `PWD`. The apparent injection did
not create its target file; final claims validated independently. No environment
values are exported. All newly created temporary roots were removed by teardown;
removal was checked by `ENOENT`. Direct schema validation left only the input
`models.json` and `.aiwg/aiwg.config`, with their bytes unchanged.

Acceptance at this fixture checkpoint: disposition ownership, legacy compatibility,
unsupported-required-metadata rejection vectors, and reviewable versioned Mission
definitions/consumer inventory are met. Production negotiation remains #2879's
consumer-boundary work; managed runtime/leases/admission are deferred to S2+.

## #2879 production boundary refinement

The frozen #2876 fragments and vectors remain intact. Production validation now
uses the bundled Mission owner. `encodeMission` and `decodeMission` negotiate and
validate worker extensions before cloning; unqualified native projections and
runtime handoffs reject them with `OG_CONTRACT_UNSUPPORTED`. Only canonical-codec
advertises support after its production boundary tests pass. Consumer rows that
name schemas or types do not introduce an executor handshake. Model selectors,
profile registries and provider-name factories have no worker payload input;
their future worker support remains false.

`test/unit/mission-protocol/worker-boundaries.test.ts` adds aggregate UTF-8 byte
limit/limit+1 and nesting depth 16/17/32 cases without changing the frozen shape
vectors. Individual fields remain schema-valid in these aggregate negatives.
The same test creates immutable pending and accepted result snapshots through
the existing codec owner, checks unchanged prior bytes/digest, and round-trips
linked `workerDispatch.previousRecord` updates through canonical Mission owners.
Snapshot records are local codec return values, not new persisted schema owners.

Persisted managed snapshots and completion integration remain **deferred S2+**:
configuration spec 05 §5.1 assigns digest-addressed versions to existing
Mission/Flow/Ralph artifacts; rules spec 06 §7 explicitly assigns immutable
pending/accepted artifact versions to Tier 1 and permits Tier 0 verification in
context or an optional receipt; delivery plan 11 S2–S3 schedules managed evidence
and Flow bindings. The S1 codec preserves bytes and successor links in memory
without requiring a database, receipt or Mission runtime.

`installed-layout.test.ts` probes compiled codec modules and local validator
dependencies under temporary installed paths for both `aiwg` and `@aiwg/cli`.
`test/integration/mission-contract-packaging.test.ts` additionally packs/unpacks
both publication targets offline in the existing serial packaging lane.

### Fix-pass validation (2026-10-07)

- `npm run typecheck`: pass.
- `npm run lint:mission-contract`: pass, compatible, no breaking changes.
- `npx vitest run --config config/vitest.config.js test/conformance/mission-v1/ test/unit/mission-protocol/`:
  **243 passed / 4 failed**. Existing inventory tests fail on sandbox-denied Node
  subprocesses (`EPERM`), including the assertion that receives empty stderr.
- `node tools/mission-protocol/inventory.mjs` and the same command with `--write`:
  both blocked by `spawnSync rg EPERM`. Newly added files still need inventory
  generation/classification in an environment permitting these subprocesses.
- `npx vitest run --config config/vitest.packaging.config.js test/integration/`:
  **0 collected**, existing global setup fails on `prepack`'s `tsx` IPC
  `listen EPERM`. The installed-layout checks passed separately (2/2); actual
  tarball execution remains environmentally unverified.

Related owner suites before the final UHP transmission additions: **510 passed,
0 failed** (22 files):

```sh
npx vitest run --config config/vitest.config.js \
  test/unit/mission-protocol/handoff-boundaries.test.ts \
  test/unit/mission-protocol/mc-worker-handoff.test.ts test/unit/a2a/ \
  test/unit/serve/mission-conductor.test.ts \
  test/unit/serve/fleet-mission-conductor.test.ts \
  test/unit/serve/shared-host-scheduler.test.ts test/unit/uhp/sse-mission.test.ts \
  test/unit/addons/composition-runtime.test.ts test/unit/mcp/agentic-sandbox.test.ts \
  test/unit/mcp/orchestration.test.ts test/unit/cli/handlers/mc.test.ts
```

Final UHP transmission regression: **76 passed, 0 failed** (6 files):

```sh
npx vitest run --config config/vitest.config.js test/unit/uhp/ \
  test/unit/mission-protocol/handoff-boundaries.test.ts \
  test/unit/mission-protocol/mc-worker-handoff.test.ts
```

The related-owner command above with `test/unit/cockpit/` added (before the three
SDK stripping tests) produced **524 passed / 13 failed**. All failures were the
existing bridge smoke isolation suite's sandbox-denied Node permission probes
(`spawnSync EPERM`). Broader related coverage produced **1450 passed / 32 failed**:

```sh
npx vitest run --config config/vitest.config.js \
  test/unit/mission-protocol/handoff-boundaries.test.ts \
  test/unit/mission-protocol/mc-worker-handoff.test.ts \
  test/unit/serve/mission-conductor.test.ts \
  test/unit/serve/fleet-mission-conductor.test.ts \
  test/unit/serve/shared-host-scheduler.test.ts test/unit/uhp/ \
  test/unit/addons/ test/unit/mcp/ test/unit/cli/handlers/mc.test.ts
```

Those broader failures are in existing subprocess-evidence tests (30), a
compound-memory context-pack schema expectation (1), and a real MCP child-pipe
timeout (1). The subprocess tests received empty child output despite exit zero;
this is not labeled a proven `EPERM` failure. No changed boundary test failed.
Related package metadata/workflow checks also passed (6/6):

```sh
npx vitest run --config config/vitest.config.js \
  test/smoke/cli-package-publish-workflow.test.ts test/unit/package-metadata.test.ts
```
## #2880 S0 / S1 capability and installed-loader checkpoint (2026-10-07)

The capability owner now contains the frozen root patch, workerAdapter and its
profile/helper definitions verbatim. `contractSchemas()` reads this production
owner directly; it no longer patches capability fixtures over missing production
fields. Existing adapter vectors also exercise the production Zod loader. No
frozen fragment, manifest digest, or existing vector was changed.

New vectors in this same fixture home:

- `adapter-vectors.json`: T-OG-03/17 HTTP and MCP positives, schema pins,
  isolation, missing controls, closed profile fields, unsupported revision and
  qualification evidence negatives. Deltas retain positive sibling values.
- `adapter-loading-vectors.json`: T-OG-10/14 traversal, symlink, digest,
  package/adapter/interface versions, wrong/reassigned exports, URL/unknown
  modules, worker/group/world writable paths, duplicate IDs/references, builtin
  collision, unsupported platforms and catalog-module tampering. Every negative
  checks absence of the import side-effect marker.
- `third-worker-adapter.mjs`: synthetic interface-v1 installed adapter/catalog.
  No bootstrap switch, resolver or workflow knows its ID. Concurrent loads use
  `ensureProvidersRegistered(trustedBindings)` and the existing string factory;
  import and registration occur once. Cached calls recheck installed bytes.

The host registration API takes the existing registry and an in-memory trusted
installed-module allowlist: reference, canonical package root, relative module
path, package name/version, interface version, SHA-256, adapter IDs and qualified
platforms, plus worker-writable roots. Project configuration cannot supply this
allowlist through any CLI/config loader. All selected runtime/catalog modules
pass validation before any selected module import. Exports must be statically
bound (`interfaceVersion=1`, callable `register(factory)`); reexports, computed
interface values and visible binding writes are rejected. The syntax scan also
rejects direct `eval(...)` calls; it does not detect indirect eval, `Function()`
or computed dynamic imports. Trust rests on the approved digest and installation
authority, since importing executes the entire module body.

Threat note (08 Revision 2, TB5/TM-OG-07/17; 05 §4.3a): the host must keep
installation roots, their path bindings and dependency closure read-only during
loading and execution, including against concurrent installers and worker writes
through aliases. Schedule installation updates outside that interval. Symlinked
package roots resolve to a canonical identity before containment, package and
digest checks; module/package.json symlinks inside that root remain rejected.
Hardlinked module/package.json files are accepted only with no write permission
bits for anyone (`mode & 0222 === 0`); writable hardlinks fail before import.
This permits read-only content-addressed stores. Permission bits do not prevent
an owner from changing modes or establish ACL/mount isolation: the host must
enforce the read-only requirement, including shared inodes and symlink ancestors.

The loader bounds module and package.json reads to 5 MiB (the catalog `maxBytes`
default), then rechecks canonical identity, permissions and digest immediately
before import. A residual check-to-import TOCTOU race remains: ESM reopens the
path after validation, so the recheck narrows but does not close that window.
These checks are defense in depth, not filesystem isolation or a race-free load.

Direct/shared results: closed annotation enum and lossless metadata preservation,
exact reference namespaces, process-default/HTTP binding semantics, versioned
shell/MCP control guards, installed factory loading and pre-import negatives are
implemented. Pure resolution needs no Mission, MC, admission, activation or
executor service. All deployment providers pass the models consumer guard and
bundled policy compiler, including Muse; Codex/Muse native resolve is exercised
without managed state. Deployment support is not live worker qualification.
T-OG-03 here covers metadata/required-control boundaries; provider terminal,
cancellation and full invocation qualification remain their existing S1 owners.
T-OG-17 here covers profile/schema pins; transport chaos belongs to B-OG-35.
Managed admission, leases, activation, Mission/Flow/Ralph runtime and health
settlement are **deferred to S2+**; no managed readiness is advertised.

Minimal shared edits: `src/models/provider-policy.ts` adds capability fields and
helpers only, leaving the config/catalog areas owned by #2878 unchanged;
`src/cli/handlers/models.ts` derives its provider guard from the registry;
`worker-contract-fixtures.ts` and `worker-contracts.test.ts` switch capability
checks to production. Package manifests/lock promote already-locked Acorn to a
runtime dependency for pre-import syntax checks. Both package manifests include
models schemas, the CLI builder/manifest include Ralph adapters, and
`config/test-lanes.mjs` registers the test in the existing packaging lane.

Validation commands and results:

```sh
npm run typecheck
npx tsc && npm run build:copy-mjs
npx vitest run --config config/vitest.config.js \
  test/conformance/mission-v1/worker-contracts.test.ts \
  test/unit/models/worker-capabilities.test.ts \
  test/unit/ralph-external/installed-worker-adapter.test.ts \
  test/unit/ralph-external/provider-adapter.test.ts \
  test/unit/models/provider-policy.test.ts \
  test/unit/models/provider-conformance.test.ts \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/unit/cli/handlers/models.test.ts \
  test/unit/mcp/worker-contracts.test.ts \
  test/unit/ralph-external/session-launcher.test.ts \
  test/unit/providers/capability-preflight.test.ts
npx vitest run --config config/vitest.packaging.config.js \
  test/integration/worker-adapter-package.test.ts
```

Typecheck and compilation/resource copy passed. Combined default suites:
**318 passed, 1 environmental failure**, ten passing files and one failing file.
The existing Grok discovery test in `models.test.ts` fails with `EROFS` writing
`~/.cache/aiwg/model-catalog.v1.json`; no production workaround was added.
The packaging lane fails in its existing global prepack setup with `EPERM`
creating the tsx IPC socket, before either package test runs: **0 executed,
2 blocked**. T-OG-14 package-path verification is therefore **partial**, not a
passing packaged-runtime claim. The tests pack/extract both published targets
outside the checkout, use compiled production code and preinstalled dependencies,
and exercise the same trusted factory. The conductor must rerun this lane where
its existing prepack setup is permitted.

All owned test temporary roots were removed and ENOENT checked. New tests use
synthetic modules/catalogs and no credentials or paid calls. Open conductor item:
rerun the two package cases in a permitted environment before claiming T-OG-14
complete; no contract redesign or frozen-vector correction is requested.

### #2880 security fix pass (2026-10-07)

The installed-loader unit suite adds writable hardlink negatives for both module
and package.json, read-only store positives, symlinked package/ancestor positives
with canonical-cache identity, worker-writable root and escaping symlink
negatives, and 5 MiB read-limit boundaries. All frozen vectors are preserved.

```sh
npm run typecheck
npx vitest run --config config/vitest.config.js \
  test/conformance/mission-v1/worker-contracts.test.ts \
  test/unit/cli/handlers/models-worker-contracts.test.ts \
  test/unit/models/worker-capabilities.test.ts \
  test/unit/ralph-external/installed-worker-adapter.test.ts \
  test/unit/ralph-external/ test/unit/models/
npx vitest run --config config/vitest.packaging.config.js \
  test/integration/worker-adapter-package.test.ts
```

Typecheck passed. The requested four files passed **164/164** tests. The full
default invocation produced **1029 passed, 9 failed**, 36 passing files and two
failing files. One existing `models/live-smoke.test.ts` check fails with subprocess
`EPERM`. Eight existing `ralph-external/snapshot-manager.test.ts` cases fail in
temporary-repository `git commit` setup; stderr is suppressed by those tests, so
their precise cause is unconfirmed (this environment enables GPG commit signing).
No test or signing configuration was changed to bypass these failures.

The packaging lane remains **0 executed, 2 blocked**: its global prepack setup
fails with `EPERM` creating the tsx IPC socket. The focused loader suite passes
**32/32**. All four requested security corrections are implemented; full green
regression/packaging evidence remains partial until the conductor can rerun the
blocked/failing existing lanes in a permitted test environment.
