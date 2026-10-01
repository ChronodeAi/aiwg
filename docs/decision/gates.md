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

Per-gate outcomes come from the gate's own `onFail` (HOLD or ROLLBACK,
never PROMOTE) and `onInsufficient`, which is always HOLD (insufficient
evidence holds; only an observed blocking failure rolls back) and
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
only rise, `onFail` only HOLD-to-ROLLBACK while `onInsufficient` is always
HOLD (a ROLLBACK there is a load error), scope changes only when monotone
per kind (`listed` may only widen, `pooled` sets are fixed, `listed -> each`
widens to the inventory minus exceptions that must exclude none of the
parent's listed slices, `all -> each` only for `count-min`/`minimum-n` with
no exceptions; every other cross-mode change is rejected), `floor: true`
gates cannot be removed or un-floored. Removing a non-floor gate is allowed.
Unknown kinds, metrics,
providers, parameters, slices and reason codes fail at load; missing values
are `insufficient`, never PROMOTE. `except` is honoured only by `each` and
is a load error with any other mode.

## Evaluation contract

`evaluateGates({ binding, registry, trustedBindingDigest, holdout, metrics,
upstream, now })` is pure: no I/O, injected clock, seeded bootstrap only.
`registry` must be a `GateRegistry` (duck-typed `{resolveBinding}` objects
are rejected). The binding is resolved internally through the pure
`resolveGateBinding` over a standalone snapshot of the registry's authored
packs — `composeGatePack`/`applyGateExtends` carry the `extends`
tightening semantics, and no overridable `GateRegistry` instance method is
called for anything security-relevant, so a subclass that overrides
`resolveBinding` cannot empty gates, loosen parameters or forge digests.
Pack pins (authored and composed digests are both re-derived by the
evaluator itself from authored packs plus the `extends` chain), provider pins
and `<packId>.<param>` namespaced parameters are re-derived inside the
evaluator — never trusted from registry-provided `resolved`/`parameters` —
and no caller-supplied resolution object is accepted. Binding, provider and
upstream pins are reserved and fully validated before any gate observes any
metric. Parameter values are preregistered in the binding itself: a looser
value is a new binding with a new digest (and, after holdout access, a new
study version), never a silent bypass (P7 binding freedom). A child that
drops a parent parameter default, making the parameter required, is
equivalent to this freedom: the binding must then supply the value, and any
value within the parameter's type range verifies. Project floors
(`aiwg.config` `gates`, #2832) are the check for binding-level minima: a
binding parameter value that loosens a floor minimum is refused at
resolution. Every provider used by
any gate metric must be pinned, and every metric section consumed must be
pinned; unpinned sections are refused. `holdout` is a sealed
`sealGateHoldout({ frozenDigest, firstAccessedAt })` record from the
HeldoutFrozen / first-access record, never a binding field (the binding's
`holdoutAccessedAt`, where present, is ignored): the seal (`digest` over
`{frozenDigest, firstAccessedAt}`) is re-derived on every use, following
`readHeldoutFrozen`, so a spread-copied or edited record is refused. The
seal is an unkeyed integrity digest, not an authenticity proof: any caller
can compute one, so `holdout` is a trusted caller input in the same trust
class as `trustedBindingDigest`. Callers must build it from the held-out
collector's verified HeldoutFrozen and access records; an entry point that
accepts and verifies the HeldoutFrozen record itself is tracked in #2833. A
missing or unsealed record, a seal mismatch, a frozen-record digest mismatch,
or a freeze at or after first access refuses evaluation. `firstAccessedAt`
may be null only when the binding declares no held-out split (no
`splitDigest`/`corpusDigest`/`goldDigest`); a null record on a split binding
refuses. The report records the sealed holdout (`digest`, `frozenDigest`,
`firstAccessedAt`), and `validateGateReport` checks it plus a byte-identical
re-derivation. `sealUpstream` binds an integrity report by digest; the digest
is re-derived on every use. `validateGateReport` re-runs the evaluator from
the same trusted inputs and requires a byte-identical report.

Paired observations whose counted support disagrees with their cell sums, and
proportion observations with events above `n`, are `insufficient`, never
trusted. An `each` gate whose exclusions cover the whole inventory is a load
error when statically determinable and `insufficient` otherwise, so no gate
ever PROMOTEs vacuously. `sliceGroups` on a binding is validated against the
slice inventory but never gates (pooled-of group references are deferred).

## Project floors (`aiwg.config` `gates`, #2832)

Experimental, default-off project policy over the core above. The `gates`
section of `.aiwg/aiwg.config` holds `floors` (inline `project:` GatePacks
and/or pins over registered packs whose composed gates all become floors)
and optional per-study `ceilings` keyed by binding `metadata.id`. Inline
floor packs validate against the closed GatePack schema at config load;
pack-reference versions and authored digests are verified at resolution and
composed through the pure `extends` chain, so a loosened parent moves the
composed digest and breaks the pin. Every floor gate that binds a threshold
parameter must declare a default for it: the default is the enforced
minimum.

Resolution refuses a binding that omits a floor gate or loosens any floor
gate's threshold, parameter value, scope or outcome, reusing the per-kind
`assertGateTightens` validator and the scope-superset rule. Binding threshold
parameters are resolved to their preregistered values before comparison, so
the check is value-against-minimum in the gate's declared direction. A
binding whose ceiling sits below its configured per-study ceiling is refused;
tighter ceilings resolve. `resolveGateBinding`, `GateRegistry.resolveBinding`
and `evaluateGates` take floors as an optional trusted input loaded from
`aiwg.config` by the caller (`resolveProjectFloors`), in the same trust
class as `trustedBindingDigest` and the sealed holdout record: pins and
composition are re-derived, never trusted. An absent floors input disables
the check and keeps resolution and evaluation byte-identical.

When no floors are configured, `resolveProjectFloors` injects the operator
default: the `project:default-floors` pack, whose single `integrity-ceiling`
`upstream-ceiling` gate requires every decision study to observe the
eval-integrity ceiling. Configuring floors replaces the default only for the
`integrity-ceiling` gate id itself: an inline floor pack that governs a gate
with that id suppresses the default, anything else keeps it. There is no
opt-out: a project that configures floors without governing the ceiling keeps
the default ceiling. Config parsing errors fail closed at
`readAiwgConfig`/`writeAiwgConfig` time.

Example (every decision study observes the integrity ceiling and caps the
false-ready rate; study `d29-synthetic-v8` can never promote):

```json
{
  "gates": {
    "floors": [
      { "packRef": { "id": "aiwg:decision-engine/integrity-ceiling", "version": "1.0.0", "digest": "sha256:<pack-digest>" } },
      { "pack": {
        "apiVersion": "gates.aiwg.io/v1alpha1", "kind": "GatePack",
        "metadata": { "id": "project:study-floors", "version": "1.0.0", "description": "Project false-ready floor." },
        "spec": {
          "metrics": { "false-ready": { "provider": "decision.screening/v1", "kind": "proportion" } },
          "gates": [
            { "id": "false-ready-upper", "kind": "interval-bound",
              "metric": { "provider": "decision.screening/v1", "name": "false-ready" },
              "statistic": { "kind": "interval-bound", "method": "wilson", "bound": "upper", "levelBps": 9500 },
              "threshold": { "op": "lte", "value": 100 },
              "scope": { "mode": "all" }, "direction": "lower-is-stricter", "onFail": "HOLD" }
          ]
        }
      } }
    ],
    "ceilings": { "d29-synthetic-v8": "HOLD" }
  }
}
```

## Digest migration (#2828)

`FrozenBinaryBenchmarkPlan` and qualification release builders now emit
`/v2` records with canonical-JSON digests. Verification is canonical-only by
default: a legacy (`JSON.stringify`) digest on a freshly built v2 record
never verifies, even under an explicit allowlist. The `/v1` schema lineage
is the pre-migration lineage, so `quality.ts`, `release.ts`,
`gate-evidence.ts` split plans and feature-export release records keep an
explicit version-gated legacy allowlist: `v1` verifies legacy only when the
caller passes `{ digestModes: ['canonical', 'legacy'] }`, and `v2` intersects
any caller allowlist with canonical-only. Existing v1 evidence still verifies
under the allowlist; every other verifier defaults to canonical-only.

## Pending (not in this phase)

Live Jev calls, real held-out data, human reviewers and production rollout:
there is no CLI (`aiwg gates`, #2830), no addon/extension provider loading —
providers register only through core modules and `sourceDigest` binds the
provider descriptor, not a code hash (#2831) — and no study migrates to
bindings (#2833+). Project floors in `aiwg.config` (#2832) are implemented as
a trusted registry/evaluator input with the default integrity-ceiling floor,
but no shipped floor pack exists yet and no study resolves with floors. No
live criterion is met; the harness above is what those phases build on.
