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
  zero adapter calls.
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

Resource ceilings stop additional variants while keeping completed rows.
Mid-run evaluator failures return an explicit partial report that preserves
completed rows and their recorded spend. Partial reports still carry
`actionAuthorization: "not-authorized"`. Baseline-stability repeats are
available only for input reevaluation and are labelled separately from
perturbation rows. Probe counters are enforced even when a caller does not
provide process-local state, but production rollout still requires durable,
non-resettable storage.

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
