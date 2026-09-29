# Counterfactual sensitivity analysis

Status: **experimental and default-off**. The `aiwg/decision` library exposes
closed `decision-sensitivity-plan/v1` and `decision-sensitivity-report/v1`
contracts plus an offline analyzer. No dispatcher, endpoint, graph node, or
automatic workflow action is enabled by default.

Sensitivity output is associative review evidence. It is not a causal
explanation of model internals, does not prove correctness, and cannot
authorize, approve, execute, or weaken any action restriction. Every report has
`actionAuthorization: "not-authorized"` and
`semantics: "associative-sensitivity-not-causal"`.

## Implemented offline

`SensitivityPlan` binds a bounded analysis to tenant, workspace, project,
authenticated actor, purpose, source subject, source result, evidence pins and
policy pins. It declares one analysis kind:

- `policy-replay`: replays preserved evidence through deterministic policy
  changes only. It permits closed caller-authored changes to ruleset
  composition outcomes/priorities and binding acceptance thresholds. It makes
  zero adapter calls. Acceptance is replayed against the target that produced
  the stored result, selected by the adapter, adapter version and requested
  model of the final (successful, when accepted) attempt; an unmatched or
  ambiguous attempt keeps the stored result. Replay cannot recover the value
  an earlier target would have produced, so loosening a target that was never
  the final attempt does not change the row.
- `input-reevaluation`: applies caller-authored values from D10-approved path
  domains to an input copy and calls a host-supplied offline evaluator. The
  analyzer generates fresh per-run invocation IDs, supplies the expected
  receipt fingerprint before dispatch, and rejects a returned result that
  changes that invocation lineage or omits attempt lineage.

The validator rejects undeclared paths, values outside the path domain,
executable strings, credential/secret-like values, authority-changing paths,
unauthorized action or label values, cross-project source subjects, high
precision threshold probing, membership-style paths, prototype-mutating JSON
Pointer segments, missing structural targets, expired authorization, and stale
or excessive probe windows before inference.

Only abstentions that acceptance produced are replayed. For primitive-policy
targets this requires the result's `acceptance` evidence
(`DecisionAcceptanceEvidence`). Confidence-threshold acceptance records no
evidence, so the stored abstention must be reproduced by the source target's
own threshold; an abstention that threshold would have accepted is treated as
adapter-originated and kept. Limitation: an adapter that itself abstains with a
confidence below the source threshold cannot be told apart and is replayed as
if acceptance produced it.

Resource ceilings stop additional variants while keeping completed rows.
Evaluator failures after completed rows return `partial`; failures before any
row return `failed` and include host-supplied spend evidence when available.
When a failure carries no spend evidence the backend may still have been
called, so the pre-dispatch reservation is charged and the report carries the
`spend-unknown-reserved` warning; those figures are a conservative reservation,
not measured spend.
Both statuses still carry `actionAuthorization: "not-authorized"`.
Baseline-stability repeats are available only for input reevaluation and are
labelled separately from perturbation rows. Variants equal to the source are
retained as deduplicated controls without backend calls or path-probe charges.
Probe counters are keyed by tenant, workspace, project, principal, source
subject and (for path counters) path, within a window derived from the injected
clock: `floor(now / windowMs)`, where `windowMs` is host-owned probe-state
configuration (default one hour). The plan's `probeControl.windowId` is a
descriptive label only and cannot reset a budget. Probe counters are enforced
even when a caller does not provide state; the implicit process-local state
holds at most 512 entries per counter map, evicts only counters from earlier
windows, and when full refuses new probes with `probe state capacity exhausted`
rather than evicting live limit state. That implicit state resets on process
restart, so production hosts must supply durable, non-resettable probe state.

Routine reports contain redacted value digests, receipt/result pins, bounded
outcome, acceptance, matched-rule and distribution deltas, resource use, and
warnings. They do not store raw changed values, state bodies, prompts,
credentials, provider request IDs, or free-form model narration.

The synthetic offline examples live in
`test/fixtures/decision/sensitivity/sensitivity-plan.v1.valid.json` and cover
threshold replay, deterministic outcome/loss-matrix sensitivity, one-field
input perturbation, and an unchanged no-change control. The unit suite runs
those examples offline; it does not call Jev or any live provider.

## Pending live inputs

Live Jev calls, representative held-out data, production probe/rate storage,
human review staffing, durable deletion from all production backups, and any
benefit/quality claim remain pending. A future rollout must provide approved
D10 path/value domains, non-resettable per-principal probe counters,
representative stability fixtures, eval-integrity evidence that preserves
`PROMOTE`/`HOLD`/`ROLLBACK`, and reviewer approval for any presentation that
could reveal sensitive boundaries through differencing.

Rollback disables sensitivity commands/endpoints and leaves original decisions,
receipts, policies and reviews unchanged because reports are additive artifacts.
