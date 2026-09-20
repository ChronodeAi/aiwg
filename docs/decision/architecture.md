<!-- markdownlint-disable MD013 MD060 -->

# Architecture decision: AIWG-owned decision elements

Status: accepted and implemented baseline. Date: 2026-09-20.
Source baseline: AIWG commit `fd7033ef8efddf873ada768b0bb687c6cf7bd086`.

## Current-state evidence

Paths below are relative to the AIWG repository; they describe inspected code, not proposed files.

| Existing surface | Evidence | Reuse and limit |
|---|---|---|
| Portable graph contracts | `agentic/code/addons/composition-engine/schemas/flow-graph.schema.json`; `docs/addons/composition-engine/schema-evolution.md` | Closed authoring objects, separate adapter projections, explicit API version changes, stable authorized candidate references. No generic SystemDefinition registry exists in the inspected surfaces. |
| Graph execution | `agentic/code/addons/composition-engine/lib/runtime.mjs`, `invoke`, `options.invokeNode` | Carries run/node/activation/invocation identities, input snapshot, resource ceilings; expects outputs plus usage. Wrap decision evaluation here via a registered skill. Do not add undeclared node kinds or fields. |
| Replay and retries | Same runtime, receipt lookup and node retry loop | Preserve invocation receipts and attempt lineage; coordinate retry ownership to prevent multiplication of provider calls. |
| Extension vocabulary | `src/extensions/types.ts`, `ExtensionType`; `src/extensions/registry.ts`, `ExtensionRegistry`; `src/extensions/capability-index.ts` | Decision definitions, rulesets, and bindings are first-class artifact-index classifications rather than deployable provider extension kinds. |
| Artifact index/routing | `src/artifacts/index-files.ts`, `resolveProjectAiwgDir`; `src/artifacts/index-reader.ts` | Definitions should be discoverable artifacts with stable identities. Runtime writes honor routed artifact root. |
| Existing lint rules | `src/lint/types.ts`, `LintRuleset`; `src/lint/loader.ts`, `loadRuleset` | These are static lint configuration, not probabilistic decision composition. Preserve their format and semantics. |
| Storage | `src/storage/types.ts`, `SubsystemKey`, `StorageAdapter`; `src/storage/index.ts`, `resolveStorage` | Jev is an executor, not storage. Reuse routed artifacts for definitions and receipts; existing activity/provenance storage for indexes. No new storage backend required. |
| Worker execution | `src/serve/mission-conductor.ts`, `RunWorker`, `MissionConductor`, `defaultRunWorker`; `src/serve/stack-adapters.ts` | Default worker is plan-only and returns no output. Actual subagent support requires a configured live worker transport and structured output validation. |
| Worker transport | `src/serve/dispatch-router.ts`, `routeDispatch`; `docs/contracts/executor.v1.md` | Reuse dispatch/executor lifecycle for subagents; do not force Jev's HTTP endpoint to become a coding-harness executor. |
| Existing checks | `test/unit/addons/composition-{engine,runtime,evaluation}.test.ts`; `test/unit/storage/config-schema-parity.test.ts` | Extend relevant contract/runtime regressions. Storage parity changes only if a later decision adds a subsystem. |

## Decision

Introduce `decision.aiwg.io/v1alpha1` with five kinds: DecisionDefinition, DecisionRuleset, DecisionBinding, DecisionResult, and RulesetResult. The latter records composition outcomes separately from individual model results. Follow the existing envelope/closed-schema/adapter pattern; this introduces normalized systems elements without inventing a general-purpose system container.

Use a small portable decision vocabulary: `choice`, `ordinal-score`, `truth-probability`. These describe answer semantics, not vendor names. Bindings separately choose `jev` or `llm-subagent`. Adapter capabilities declare representable types and limits. Normal LLM execution can represent all three using validated structured output; its numeric uncertainty remains model-reported and uncalibrated unless a separate measured calibration profile exists.

Artifacts have human-readable stable identity, immutable version and content digest. Published catalog references use existing catalog identity conventions and a manifest resolver; do not fabricate stable index hashes from example names. A registered dispatcher skill is the initial FlowGraph candidate. Decision artifacts themselves become first-class discoverable data artifacts in the index; they need not be deployable native agent extension types. This avoids unnecessarily broadening `ExtensionType` while still providing authoring, validation, listing, and reference resolution for the new elements.

Product homes are `schemas/decision/`, `src/decision/`, `docs/decision/`, and `test/unit/decision/`. The packaged dispatcher is the `decision-evaluate` skill in the `decision-engine` addon under `agentic/code/addons/`. Runtime artifacts use `<artifact_root>/decisions/{definitions,rulesets,bindings,runs}/`.

## Alternatives and consequences

- Direct Jev calls in each workflow minimize initial code but couple workflow semantics to vendor shapes and make replacement expensive. Rejected.
- Reusing lint rulesets conflates deterministic lint with runtime decisions. Rejected; any future bridge must be explicit.
- Adding a new FlowGraph node kind immediately expands closed graph contracts and adapters. Deferred; the registered skill bridge satisfies v1.
- Treating Jev as a coding provider would imply capabilities it does not have. Rejected.
- Shared contracts add validation and version-management work. In return, callers gain backend substitution, reproducible configuration, traceable fallbacks, and testable behavior.

## Impact and compatibility

No automatic migration, no new default network calls, and no changes to existing lint files. Existing workflows keep current behavior. New graphs explicitly invoke the dispatcher and pin artifact references. Introducing a decision artifact index classification must update validators, search filters, help, and schema parity together. No new storage subsystem or provider deployment target is required in this baseline.

A later breaking interpretation requires a new decision API version, its own schema and validator, and explicit conversion. Preserve old validators until consumers migrate. A definition change always creates a new artifact version/digest; no mutable alias may redirect a pinned reference.
