# Ensembles, champion/challenger, and drift response (D17 contract)

Status: **contract stable; runtime experimental, injected and default-off.** This page describes the
versioned D17 schemas, pure validators, fixtures and offline runtime APIs added for #2611. The
runtime does not select itself from normal decision evaluation, does not resolve credentials, and
does not call a provider unless trusted host code passes an explicit dispatch callback and
`enabled: true`. Live Jev calls, held-out evidence, human approvals and production rollout remain
separate gates.

## Contracts

| Schema | Record | Purpose |
|---|---|---|
| [`DecisionEnsemblePolicy.v1`](../../schemas/decision/DecisionEnsemblePolicy.v1.schema.json) | `decision-ensemble-policy/v1` | Members and their pins, primitive, aggregation, disagreement, acceptance and every resource ceiling |
| [`DecisionEnsembleAggregate.v1`](../../schemas/decision/DecisionEnsembleAggregate.v1.schema.json) | `decision-ensemble-aggregate/v1` | Derived result of the reference aggregation over recorded member results |
| [`DecisionChampionChallenger.v1`](../../schemas/decision/DecisionChampionChallenger.v1.schema.json) | `decision-champion-challenger/v1` | Champion and challenger pins over one immutable input set, with preregistered paired thresholds |
| [`DecisionDriftResponse.v1`](../../schemas/decision/DecisionDriftResponse.v1.schema.json) | `decision-drift-response/v1` | Maps each declared drift signal to exactly one configured response |
| [`DecisionEnsembleIntegrityReport.v1`](../../schemas/decision/DecisionEnsembleIntegrityReport.v1.schema.json) | `decision-ensemble-integrity-report/v1` | Extends the #2037/#2048 eval-integrity report and can never upgrade its decision |

All five schemas are registered in `schemas/catalog/domains/decision.json` with `stability:
experimental`. The TypeScript types, validators and experimental runtime helpers live in
`src/decision/ensemble/` and are exported from `aiwg/decision`. Each validator runs entry admission
and the JSON Schema before its semantic checks. `EnsembleContractError.layer` reports which of the
three layers (`admission`, `schema`, `semantic`) rejected the input.

## Ensemble policy

A policy has a semantic version, a `mode` (`disabled`, `offline-shadow` or `advisory`; v1 has no
enforced mode), its risk tiers, and the decision definition that every member answers. Each member
declares:

- its **member type**: `model-version`, `provider-backend`, `repeated-sample` or `prompt-adapter`;
- pinned definition, binding, adapter version and provider, backend, requested model and pinned model version;
- its primitive, uncertainty profile, required capabilities and the capabilities its binding supplies;
- an optional D09 calibration artifact pin;
- its sample count, fallback depth, and conservative per-attempt estimates of attempts, tokens, cost and deadline.

`validateEnsemblePolicy` refuses the policy before any adapter could be called when:

- a member's primitive or definition pin differs from the policy;
- the aggregation algorithm or disagreement metric is not defined for the primitive;
- a member's uncertainty profile is not on the policy's allow-list. Algorithms that combine numeric
  uncertainty (`mean-probability-v1`, `jensen-shannon-v1`) also require one shared profile, so a Jev
  distribution is never averaged with an LLM self-report;
- a member lacks a required capability;
- the policy requires calibration and a member has no pinned artifact, or the host supplies D09
  `CompatibilityDecision` pins and a member's pin is not an `allow` for that exact artifact;
- two non-sample members share the same binding, adapter and model identity, which would claim
  independence that does not exist; a `repeated-sample` member has fewer than two samples; or a
  `prompt-adapter` member has no approval reference;
- the budget does not fit (see below).

### Budgets

Budget validation mirrors `GraphBudgetLedger` (#2608). Effective ceilings are the minimum of the
policy's ceilings and every host layer, as in `effectiveGraphCeilings`. Every planned sample becomes
a `{ attempts, tokens, costMicros }` reservation with at least one attempt. Attempts are never
refunded, so an estimate must cover the member's fallback depth. Unknown cost is rejected unless the
policy's `unknownCost` rule reserves an explicit trusted bound per attempt. The whole plan is
admitted all or nothing: the policy is rejected when total members, attempts, tokens, cost, fallback
depth or the conservative deadline exceed a ceiling. The deadline is the slowest sample multiplied by
the number of concurrency waves. `planEnsembleBudget` returns the effective limits, demand and
reservations. This check happens at validation time; it is not a dispatcher.

`executeDecisionEnsemble(policy, options)` is the experimental dispatcher wrapper over that plan.
It returns `disabled` unless `options.enabled === true` and the policy mode is not `disabled`.
When enabled, trusted host authorization is mandatory: if no authorization callback is registered,
or if it rejects a member for security, privacy, region, capability or budget reasons, no member is
invoked. Before every dispatch the wrapper checks the sample's planned reservation against actual
spend so far plus every in-flight reservation, for attempts, tokens and cost, and against the member
ceiling; a sample that would not fit is not dispatched and is recorded as `budget-exhausted`. Each
dispatch request carries that reservation as hard per-call `limits` (`attempts`, `tokens`,
`costMicros`). The wrapper cannot stop a provider call that is already running, so the ensemble
ceilings hold only when the dispatcher enforces those per-call limits. A result that reports usage
above its reservation is a budget violation: that member is recorded as `budget-exhausted`, the
overrun is included in the reported actuals, and no further sample is dispatched. Samples that were
already in flight when the overrun was observed can still add spend, so with concurrency above one, a
dispatcher that ignores its limits can exceed a ceiling by up to the in-flight calls' overruns. It runs
admitted samples under the effective concurrency and an injected-clock deadline, passes each member to
an injected dispatch callback, validates each returned value with the existing `DecisionResult`
validator, retains each full `DecisionResult` by digest, converts successes and all failure paths into
`EnsembleMemberResult`, and then calls `aggregateEnsembleResults`. Dispatch rejection, timeout,
a malformed member result (`invalid-output`), fallback-depth excess, runtime token/cost budget
exhaustion, and unknown provider cost under an `unknownCost: reject` policy are recorded as failed
member evidence rather than flattening the whole ensemble call. A sample that times out or rejects is
charged its full reservation, since its provider usage is unknown. A result whose attempts report
`null` input or output tokens is charged at least the sample's full token reservation: null usage is
unknown, never zero. The policy contract has no separate unknown-token rule, so this always applies.
The result's `actuals` (`attempts`, `tokens`, `costMicros`, `unknownUsageSamples`) and the
`aiwg.budget.unknown_usage_samples` telemetry attribute count every sample charged this way; usage a provider reports after the
deadline is not observed, so a late result that exceeded its reservation is not reflected in the
reported actuals. Runtime telemetry is metadata-only: ensemble IDs, member counts, budgets/actuals,
disagreement and disposition are emitted without inputs, prompts or response bodies. When no trace
context is supplied, fresh W3C trace/span IDs are generated for each emitted span.

## Reference aggregation

`aggregateEnsembleResults(policy, results)` is a deterministic library over results that were
already recorded. Each result names its member, sample index, status (`succeeded`, `failed`,
`abstained`), and a digest of the full member `DecisionResult`/attempt lineage, which is retained
separately. Every planned sample must be recorded, failures included. Results are put in canonical
`(memberId, sampleIndex)` order before any arithmetic, so the output is identical for every
permutation of the input.

| Algorithm | Primitives | Output value |
|---|---|---|
| `majority-v1` | Choice, Noul | Plurality label. Noul votes `true` at p >= 0.5. |
| `mean-probability-v1` | Choice, Noul | Choice: argmax of the mean provider distribution. Noul: mean probability. |
| `score-distribution-mean-v1` | Score | Mean score; dispersion is retained. |
| `score-median-v1` | Score | Median score. An even count with distinct middle values is a tie. |

| Disagreement metric | Primitives | Definition (reported in basis points, 0 to 10000) |
|---|---|---|
| `vote-share-v1` | Choice, Noul | 1 minus the winning vote share |
| `normalized-entropy-v1` | Choice, Noul | Vote entropy divided by log2 of the label count |
| `jensen-shannon-v1` | Choice, Noul | Generalized Jensen-Shannon divergence over member distributions, divided by log2(min(members, labels)) |
| `score-dispersion-v1` | Score | Population standard deviation divided by half the level span |

The tie rule is `lowest-canonical-value` (lowest option ID in code-unit order, `false` before `true`,
or the lower middle score), `defer` or `review`. The disposition is chosen in this order: too few
successful members, then a tie under a `defer`/`review` rule, then disagreement above the threshold,
and otherwise `accept`. A non-accepted aggregate carries no outcome value. The aggregate records the
algorithm and metric ID and version, the policy digest, every member result reference, counts and
derived statistics.

## Agreement is not correctness

The aggregate is labelled `semantics: stability-signal-not-correctness` and `provenance: derived`.
Its schema has no calibrated-probability, accuracy or correctness field, and its `correctnessGate`
is the constant `not-satisfied`. Agreement alone never satisfies a correctness or calibration gate.
Meeting such a gate needs separate labelled evaluation evidence.

Warnings make the limits visible:

- `high-agreement-not-correctness`: at least two successful members agree within the policy's
  `highAgreementWarningBps`.
- `shared-systematic-error-risk`: high agreement from members that share one model identity, or that
  are all repeated samples or prompt variants. The `ENS-SHARED-01` fixture shows five agreeing samples
  of one model that are all wrong.
- `member-failures-present` and `uncalibrated-members`.

### Independence limits and shared error

The member types do not have equal independence. Repeated samples from one model share its training
data, prompt and systematic errors, so their agreement measures stability, not truth. Different model
versions of one provider share most of their lineage. Different providers are more independent, but
can still share public training data and the same prompt. Prompt or adapter variants are only
members when explicitly approved. None of these designs is a certificate of correctness, and
black-box sample agreement cannot prove truth.

### Expense

Each member sample is a separate call with its own tokens, cost and latency. An ensemble of k
samples costs roughly k times a single decision and adds latency unless concurrency is available.
Only a workload-specific benefit, measured against that added spend and latency, justifies enforced
use. That measurement is part of the deferred runtime qualification.

### Calibration requirements

Member uncertainty semantics differ and are never flattened into a common calibrated probability.
Calibrated risk comes only from a pinned D09 calibration artifact whose compatibility decision is
`allow` for the exact member identity. A policy with `calibration.requirement: required` rejects any
member without such a pin. An aggregate derived from calibrated members is still not itself a
calibrated estimate.

## Champion and challenger

`DecisionChampionChallenger.v1` pins both roles by D09 identity digest, actual model, binding, adapter,
calibration and optional ensemble policy. It also pins one immutable input set (ID, digest, item count,
freeze time) and the paired metrics `quality`, `calibration`, `risk-coverage`, `abstention`,
`latency`, `tokens`, `cost` and `slice`, each with a comparison, bound and minimum pair count. The
thresholds are preregistered by an order-independent digest before any held-out access. The record
names the required D09 `PromotionEligibility` ID, the eval-integrity report, the approval, and a
rollback target that must be the exact champion alias revision, as `promoteAlias` requires.

`validateChampionChallenger` can also compare the record with the D09 eligibility record and the
immutable alias history. D17 consumes that registry. It does not keep a parallel registry or alias
state machine, and it does not move aliases.

The experimental runtime exports:

- `runChampionChallengerShadow(record, options)`: default-off paired shadow execution. Trusted host
  code supplies the immutable input set and an evaluator callback. Champion and challenger receive
  structured clones of the same item, their input digests must match the preregistered input-set
  digest, and the result reports paired quality, calibration, risk-coverage, abstention, latency,
  tokens, cost and slice deltas.
- `promoteChampionChallenger(...)`: consumes the D09 `PromotionEligibility`, the D17 integrity report
  and immutable alias history. The gateway must expose D09's stored eligibility
  (`promotionEligibility(id)`, as `CalibrationRegistry` does), and the supplied eligibility must be
  canonically identical to it, because `promoteAlias` acts on the stored record. The alias's current
  revision must still be the record's pinned champion (revision and identity), and the record's
  eligibility ID must not appear anywhere in alias history, so a stale record cannot promote over a
  newer champion and a promotion cannot be replayed after a rollback. The replay guard is keyed by
  eligibility ID only. Refusing reuse of the same approval reference under a new eligibility ID is
  D09's responsibility when it records eligibility. It validates the report, then independently rebuilds it with
  `buildEnsembleIntegrityReport` from the trusted record, the eligibility, the alias history and the
  report's carried integrity fields and raw paired observations, and refuses unless the rebuilt report
  is canonically identical to the supplied one. The carried integrity fields must also hash
  (`ensembleContractDigest`) to the record's pinned `evaluationIntegrityReport.digest`. Alias movement
  is delegated to the D09 gateway only when the rebuilt decision is `PROMOTE` for the exact
  champion/challenger record. A report whose decision, findings, passed flags or thresholds were
  edited, even with a recomputed digest, is refused. The paired deltas must also be bound to a shadow
  run: the integrity fields must carry `paired_baseline.championChallengerShadow`, produced by
  `championChallengerShadowBaseline(record, shadowResult)` from a completed
  `runChampionChallengerShadow` result. It names the record ID, input-set digest, thresholds digest,
  both role identities, a digest of the shadow run's paired deltas and a digest of its per-item
  receipts. Promotion recomputes everything except the receipts digest from the record and the report's
  deltas. Because the record pins the digest of those integrity fields, deltas that differ from the
  approved shadow run, or that have no shadow binding, are refused. The binding uses the record's stable
  fields rather than its whole digest, since the record itself pins the integrity report. The receipts
  digest is carried for audit only; promotion does not have the receipts to recompute it. After the
  gateway returns, the event must be kind `promoted` for this alias and eligibility ID, name the
  challenger's identity digest and actual model, and have the revision after the pinned champion's.
  Otherwise promotion throws `promotion-event-mismatch`. The gateway has already acted by then, so
  the host must inspect alias history.
- `rollbackChampionForNewRuns(...)` and `pinChampionForRun(...)`: rollback requires a valid approval
  reference, that the alias's current revision is this record's promoted challenger (kind
  `promoted`, the record's eligibility ID and challenger identity), and that the revision it replaced
  is the record's rollback target. Otherwise it refuses without calling the gateway, so nothing is
  appended to alias history. When allowed, it delegates to D09 `rollbackAlias` for future alias
  resolution, while already pinned active runs keep their original champion revision. After
  interleaved promotions and rollbacks, only the most recent promotion can be undone this way; an
  earlier promotion can only be undone through the D09 registry (`rollbackAlias` with its own
  approval).

The D09 `CalibrationRegistry.promoteAlias` applies the same guard itself: it refuses when the alias's
latest event is not the eligibility's rollback target, or when the eligibility ID was already used in
alias history. It also exposes `promotionEligibility(id)`.

## Eval-integrity report extension

`buildEnsembleIntegrityReport` carries the #2037/#2048 integrity fields unchanged (`sample_n`,
uncertainty, paired baseline, integrity mode and state, fresh-workspace requirement and verification,
compromise labels, trusted score source, weak-signal reason and release gate). It adds the paired
deltas against their preregistered bounds and D17 findings. The decision logic can only keep or tighten
the upstream gate:

- an upstream `ROLLBACK`, or any compromise, gives `ROLLBACK`;
- an upstream `HOLD`, or any D17 finding, gives `HOLD`;
- `PROMOTE` needs an upstream `PROMOTE`, a matching eligible D09 record, verified integrity, and every
  paired delta present, sufficiently sampled and within its bound.

`validateEnsembleIntegrityReport` rejects any report whose decision is less conservative than its
upstream decision. It also recomputes the integrity-derived findings, each paired delta's `passed`
flag and finding against the thresholds carried in the report, and the decision, and rejects a report
that is inconsistent with them. D09-derived findings and the thresholds themselves need the record,
so they are checked when `promoteChampionChallenger` rebuilds the report; a validated report alone is
not a promotion authorization.

## Drift response

`DecisionDriftResponse.v1` declares one rule per `(source, metric)`:

| Source | Metrics | Evidence |
|---|---|---|
| `alias-drift` | `identity-change` | D09 `AliasDriftEvent` from `CalibrationRegistry.driftEvents()` |
| `output-distribution` | `jensen-shannon-v1`, `population-stability-index-v1` | Unlabelled warning, not direct evidence of quality loss |
| `label-drift` | `label-error-rate-delta-v1`, `calibration-error-delta-v1` | Labelled quality evidence |

Each rule names exactly one response: `alert`, `reduce-coverage`, `route-to-review`,
`disable-challenger`, `restore-champion` or `require-recertification`. A policy must configure
alias drift, its thresholds are pinned by version and digest, and it names the response for a window
with too few samples. `resolveDriftResponse` returns the configured response for a signal. It rejects
a signal with no configured rule, a different alias, or a different threshold version, so old
thresholds are never reused silently. Values equal to a threshold are within it. The resolver only
reports the response. `executeDriftResponse(policy, signal, handlers)` is the default-off execution
seam: it first resolves the exact configured response, then invokes only the handler for that
response (`alert`, `reduce-coverage`, `route-to-review`, `disable-challenger`, `restore-champion` or
`require-recertification`). If the resolved response has no registered handler, execution fails
closed and does not claim the response ran. The handler remains host-owned; this package does not
mutate routing, coverage or aliases by itself.

## Fixtures

The fixtures in `test/fixtures/decision/ensemble/` are synthetic and repository-authored. They
exercise validation and deterministic plumbing only. They are not quality, calibration or drift
threshold evidence and must not be used to select production thresholds.

- `ensemble-policy.v1.{valid,invalid}.json`, `champion-challenger.v1.{valid,invalid}.json` and
  `drift-response.v1.{valid,invalid}.json`: positive records, plus anti-fixtures written as JSON
  patches against a valid base, each declaring the layer that must reject it.
- `aggregation-vectors.v1.json`: Choice, Noul and Score aggregation, disagreement, stable-tie,
  defer-on-conflict and shared-systematic-error vectors (`ENS-*`).
- `drift-response-table.v1.json`: the signal-to-response table (`DRF-T*`).

## Offline runtime examples

The addon examples include `agentic/code/addons/decision-engine/examples/ensemble-runtime-offline.mjs`.
After `npm run build:cli`, it runs the ensemble runtime against synthetic member `DecisionResult`
objects and prints only aggregate metadata. It is executable offline and carries no live quality,
calibration or Jev claim.

## Synthetic held-out study

The [D17 study module](ensemble-heldout-study.md) prepares 1,800 fresh synthetic
subjects, frozen 200/400/1,200 splits, native policy/comparison templates and
preregistered statistical gates on top of the shared collector. Its source-only
dry run reports USD 5.4 worst-case reservation within the USD 8 study cap.
The 88-assessment operator audit, compatible calibration and live observations
remain pending; study reports cannot promote an ensemble.

## Still pending live rollout evidence

The offline runtime now implements bounded ensemble dispatch, paired shadow plumbing, promotion and
rollback gates, drift-response execution, security/privacy/capability pre-dispatch filtering, and
metadata-only telemetry seams. These are not production rollout evidence. Still pending external
inputs are: real paired shadow runs, D11 frozen-split drift thresholds, human review approvals,
live Jev/provider calls, the benefit-versus-spend benchmark, cross-provider egress matrix, and any
production OpenTelemetry wiring such as a `decision.drift` metric producer.
