# Gates capability phase 1 core

Experimental, default-off reusable evaluation gates (epic #2824, issues #2826,
#2827, #2828). Nothing in the decision runtime imports `src/gates/`, so
existing behavior is unchanged; the only shared-surface change is the digest
migration described below.

## What exists

- `schemas/gates/GatePack.v1alpha1.schema.json`,
  `GateBinding.v1alpha1.schema.json`, `GateReport.v1alpha1.schema.json`
  (closed, draft 2020-12, cataloged in the decision domain). Conformance
  fixtures live in `test/conformance/gates-v1/fixtures/`.
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

Per-gate outcomes combine on PROMOTE < HOLD < ROLLBACK with the upstream
ceiling and the binding ceiling; the maximum never upgrades any component.
`standard` severity holds on breach or insufficient evidence, `blocking`
rolls back. References (`always-review`, `always-predict`,
`pinned-baseline`) are reported, never gating, unless a `paired-difference`
gate names one in `vs` (the contrast is still evaluated from the paired
observation; the name documents which arm it was paired against).

## Registry rules

Namespaces `aiwg:`, `framework:`, `addon:`, `extension:`, `project:`. Packs
outside `aiwg:` cannot shadow a shipped `aiwg:` rest-path. `extends` may only
tighten: thresholds move in their declared direction, `minimumN` and
`levelBps` only rise, severity only `standard` to `blocking`, listed scopes
only widen, pooled scopes are fixed, `floor: true` gates cannot be removed or
un-floored. Unknown kinds, metrics, providers, parameters, slices and reason
codes fail at load; missing values are `insufficient`, never PROMOTE.

## Evaluation contract

`evaluateGates({ resolved, trustedBindingDigest, metrics, upstream, now })`
is pure: no I/O, injected clock, seeded bootstrap only. Untrusted binding
digests, provider pin mismatches, forged upstream reports and bindings frozen
at or after `holdoutAccessedAt` throw before any gate runs. `sealUpstream`
binds an integrity report by digest; the digest is re-derived on every use.

## Digest migration (#2828)

`FrozenBinaryBenchmarkPlan` and qualification release digests are now
canonical JSON. Verification accepts both modes by default (operator
decision): `verifyBinaryBenchmarkPlanDigest` and
`verifyQualificationReleaseDigest` return `canonical`, `legacy` or `null`,
and every verifier that re-derives these digests (`gate-evidence.ts`,
`feature-export.ts`, `evaluatePreregisteredBinaryBenchmark`) accepts both.
Pass `{ digestModes: ['canonical'] }` to reject legacy digests.

## Pending (not in this phase)

Live Jev calls, real held-out data, human reviewers and production rollout:
there is no CLI (`aiwg gates`, #2830), no project floors in `aiwg.config`
(#2832), no addon/extension provider loading — providers register only
through core modules and `sourceDigest` binds the provider descriptor, not a
code hash (#2831) — and no study migrates to bindings (#2833+). No live
criterion is met; the harness above is what those phases build on.
