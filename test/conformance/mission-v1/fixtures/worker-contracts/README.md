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
