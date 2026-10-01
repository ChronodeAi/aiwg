# Gates capability phase 1 core

Experimental, default-off reusable evaluation gates (epic #2824, issues #2826,
#2827, #2828). The gates *evaluator* is default-off: no decision-runtime path
evaluates gate packs, so existing behavior is unchanged. The decision runtime
does reuse the moved statistics and digest helpers under `src/gates/stats/`
(`quality.ts`, `release.ts` and `gate-evidence.ts` import them); those helpers
are numerically identical to the pre-move implementations.

## What exists

- `schemas/gates/GatePack.v1alpha1.schema.json`,
  `GateBinding.v1alpha1.schema.json`, `GateReport.v1alpha1.schema.json`
  (closed, draft 2020-12, cataloged in the decision domain). Conformance
  fixtures live in `test/conformance/gates-v1/fixtures/`, including invalid
  binding/report fixtures for fail-closed conformance vectors.
- `src/gates/`: Ajv schema validation (`schema.ts`), namespace registry with
  `extends` monotone-tightening proofs and binding resolution (`registry.ts`),
  a pure deterministic evaluator (`evaluate.ts`), digest-bound report
  validation (`report.ts`) and four core metric providers (`providers/`).
- `src/gates/stats/`: the statistics moved out of
  `src/decision/qualification/quality.ts` (Wilson, Newcombe-10/Tango, seeded
  percentile bootstrap, non-inferiority, frozen-split helpers) plus the new
  exact Clopper-Pearson interval. `quality.ts` re-exports every moved symbol,
  so existing consumers are untouched.

## Gate kinds (closed set, v1alpha1)

`interval-bound` (wilson, clopper-pearson), `paired-difference`
(non-inferiority, superiority via newcombe or tango), `bootstrap-bound`
(seeded), `count-max`, `count-min`, `value-threshold`, `minimum-n`,
`evidence`, `predicate` (three-valued `DecisionPredicate`; `unknown` is
insufficient), `upstream-ceiling` (eval-integrity allowlist).

Per-gate outcomes come from the gate's own `onFail` / `onInsufficient`
(HOLD or ROLLBACK, never PROMOTE; `onInsufficient` defaults to HOLD) and
combine on PROMOTE < HOLD < ROLLBACK with the upstream ceiling and the
binding ceiling; the maximum never upgrades any component. `upstream-ceiling`
gates mirror the trusted upstream verdict exactly (compromise rolls back,
allowlist problems hold, clean promotes) and never escalate it.
References (`always-review`, `always-predict`,
`pinned-baseline`) are reported, never gating, unless a `paired-difference`
gate names one in `vs` (the contrast is still evaluated from the paired
observation; the name documents which arm it was paired against).

Interval levels are two-sided confidence levels applied to one-sided bounds:
the reported bound is the one-sided edge of a two-sided interval, which is
conservative (wider) relative to a one-sided interval at the same level.

## Registry rules

Namespaces `aiwg:`, `framework:`, `addon:`, `extension:`, `project:`. An
`aiwg:` rest-path can never coexist with the same rest-path from any other
namespace, whichever registers first. A rest-path shared by two non-`aiwg:`
namespaces is `ambiguous` and resolves only by full id; bindings always pin
full ids, so they never hit ambiguity. `extends` is a full pin
`{id, version, digest}` over the parent's authored bytes, and every binding
and report additionally pins the digest of the composed (extends-resolved)
pack, so a loosened parent always moves the child's composed digest and
breaks old pins. A child may only tighten: thresholds move in their declared
direction (a literal threshold may never be rewritten as a bindable
parameter, and parameters may never be renamed), `minimumN` and `levelBps`
only rise, `onFail`/`onInsufficient` only HOLD-to-ROLLBACK, scope changes
only when monotone per kind (`listed` may only widen, `pooled` sets are
fixed, `listed -> each` widens to the inventory, `all -> each` only for
`count-min`/`minimum-n`), `floor: true` gates cannot be removed or
un-floored. Removing a non-floor gate is allowed. Unknown kinds, metrics,
providers, parameters, slices and reason codes fail at load; missing values
are `insufficient`, never PROMOTE. `except` is honoured only by `each` and
is a load error with any other mode.

## Evaluation contract

`evaluateGates({ binding, registry, trustedBindingDigest, holdout, metrics,
upstream, now })` is pure: no I/O, injected clock, seeded bootstrap only.
The binding is resolved internally against the registry — pack pins
(authored and composed digests are both re-derived), provider pins and
`<packId>.<param>` namespaced parameters — and no caller-supplied resolution
object is accepted. Binding, provider and upstream pins are reserved and
fully validated before any gate observes any metric. Parameter values are
preregistered in the binding itself: a looser value is a new binding with a
new digest (and, after holdout access, a new study version), never a silent
bypass. Every provider used by
any gate metric must be pinned, and every metric section consumed must be
pinned; unpinned sections are refused. `holdout` (`firstAccessedAt` plus the
frozen-record digest) is required trusted input from the HeldoutFrozen /
first-access record, never a binding field (the binding's
`holdoutAccessedAt`, where present, is ignored): a missing record, a
frozen-record digest mismatch, or a freeze at or after first access refuses
evaluation. `sealUpstream` binds an integrity report by digest; the digest
is re-derived on every use. `validateGateReport` re-runs the evaluator from
the same trusted inputs and requires a byte-identical report.

Paired observations whose counted support disagrees with their cell sums, and
proportion observations with events above `n`, are `insufficient`, never
trusted. An `each` gate whose exclusions cover the whole inventory is a load
error when statically determinable and `insufficient` otherwise, so no gate
ever PROMOTEs vacuously. `sliceGroups` on a binding is validated against the
slice inventory but never gates (pooled-of group references are deferred).

## Digest migration (#2828)

`FrozenBinaryBenchmarkPlan` and qualification release digests are now
canonical JSON. Verification is canonical-only by default: a legacy
(`JSON.stringify`) digest on newly written evidence never verifies unless the
caller explicitly allowlists the pre-migration mode. The v1 schema lineage is
the pre-migration lineage, so `gate-evidence.ts` split plans and
feature-export release records keep an explicit version-gated legacy
allowlist. Every other verifier defaults to canonical-only; pass
`{ digestModes: ['canonical', 'legacy'] }` only for named pre-migration
evidence.

## Pending (not in this phase)

Live Jev calls, real held-out data, human reviewers and production rollout:
there is no CLI (`aiwg gates`, #2830), no project floors in `aiwg.config`
(#2832), no addon/extension provider loading — providers register only
through core modules and `sourceDigest` binds the provider descriptor, not a
code hash (#2831) — and no study migrates to bindings (#2833+). No live
criterion is met; the harness above is what those phases build on.
