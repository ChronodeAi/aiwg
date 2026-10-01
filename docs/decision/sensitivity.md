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
  composition outcomes/priorities and, in the binding, only a target's
  `acceptance` subtree or an evaluation's `fallbackOn`. Paths that replace a
  target, the target list or a whole evaluation, and any value that names
  `adapter`, `adapterVersion`, `model`, `requestedModel`, `subagent` or
  `credentialRef` at any depth, are rejected before replay; a replay whose
  target identities differ from the source is also reported as unreplayable. It makes
  zero adapter calls. Acceptance is replayed against the target that produced
  the stored result, selected by the adapter, adapter version and requested
  model of the final (successful, when accepted) attempt; an unmatched or
  ambiguous attempt keeps the stored result. Replay cannot recover the value
  an earlier target would have produced. A row whose answer depends on such an
  unobserved outcome is reported with `inference: "unreplayable"` and the
  `unreplayable-unobserved-outcome` warning (and the report carries
  `unreplayable-rows-present`) instead of as a no-change row. This covers
  changing a target that was attempted and abstained before the producing
  target, changing `fallbackOn` routing, an unmatched producing target, and a
  replay that newly fails acceptance with a reason the binding would route to a
  later, unobserved target. Unreplayable rows make no sensitivity claim.
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
A malformed, cyclic or otherwise unusable returned result produces a `failed`
or `partial` report instead of throwing; its attempt usage is charged when it
is well formed (finite, non-negative numbers or null). When a failure carries
no usable spend evidence (including a malformed `result` attached to a thrown
error, or NaN, negative or non-numeric usage) the
backend may still have been called, so the pre-dispatch reservation is charged and the report carries the
`spend-unknown-reserved` warning; those figures are a conservative reservation,
not measured spend.
Both statuses still carry `actionAuthorization: "not-authorized"`.
Baseline-stability repeats are available only for input reevaluation and are
labelled separately from perturbation rows. Variants equal to the source are
retained as deduplicated controls without backend calls or path-probe charges.
The source input must match the ruleset input schema. Callers must pass a
host-authenticated `probeIdentity` (tenant, workspace,
project, principal) taken from the host's authentication context. A missing
identity, or a plan whose tenant, workspace, project or actor differs from it,
is rejected before inference. Probe counters are keyed by that identity, the
probed subject (the digest of the source input together with the canonical
ruleset and binding content: `apiVersion`, `kind` and `spec` only) and (for
path counters) path. Caller-chosen artifact metadata (`id`, `version`,
`description`) is not part of the key, and the binding's ruleset pin is
normalized to the canonical ruleset digest, so renaming an otherwise identical
ruleset or binding cannot mint a new budget for re-evaluating the same input.
A genuinely new artifact version mints a distinct subject only through a change
to the evaluated spec. Neither the plan-authored
`sourceSubject.subjectRef` nor the caller-supplied source result artifact is
part of the key, so rotating them cannot mint a new budget for re-evaluating
the same input. Counters use a window derived
from the injected clock: `floor(now / windowMs)`, where `windowMs` is host-owned probe-state
configuration (default one hour). The plan's `probeControl.windowId` is a
descriptive label only and cannot reset a budget. Probe counters are enforced
even when a caller does not provide state; the implicit process-local state
holds at most 512 entries per counter map, evicts only
counters from earlier windows, and when a principal's quota or the store is
full refuses new probes (`probe principal quota exhausted` or
`probe state capacity exhausted`) rather than evicting live limit state. Every
state, including host-supplied state, also caps each principal at
`maxEntriesPerPrincipal` (default 64) distinct counter entries per window.
Budgets are charged only after a plan passes every pre-inference check
(identity, authorization, path limits, capacity, evaluator presence). The M08
amendment requires probes to fail before inference and disclose nothing and
budget exhaustion not to be evadable; it does not require charging rejected
probes, and a rejected plan performs no inference. That implicit state resets on process
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
