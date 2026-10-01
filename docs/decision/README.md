# Normalized decisions and rulesets

AIWG reads both `decision.aiwg.io/v1alpha1` and `decision.aiwg.io/v1alpha2` definitions as an opt-in shared runtime. The
same immutable decision definitions, ruleset, workflow input, and consumer can
run through a Jev binding or an ordinary LLM-subagent binding. Only the binding
changes; probabilistic values and confidence scales are not assumed equal.

The public TypeScript entry point is `aiwg/decision`. It provides schema and
semantic validation, RFC 8785-compatible pins, JSON Pointer projection,
three-valued predicates, deterministic composition, bounded retries and
fallback, receipt replay protection, and both adapter implementations. The
`decision-engine` addon packages the `decision-evaluate` dispatcher for
FlowGraph skill nodes.

Existing workflows are unaffected. Evaluation requires an explicit call and
binding; the packaged dispatcher additionally requires
`AIWG_DECISION_ENABLED=1`. Jev network use needs a logical credential mapping.
The standard test suite uses fixtures only. The live Jev smoke is separately
gated by `AIWG_DECISION_JEV_LIVE_SMOKE=1` and
`AIWG_DECISION_JEV_API_KEY`.

The dispatcher request is deliberately narrower than the TypeScript library.
Public request JSON can name artifact paths, adapter configuration, projection
policy files, credentials by environment-variable name, and trusted
`hostPolicies` references. Runtime objects such as receipt stores, schedulers,
context estimators, compile-cache implementations, result-cache services,
provider-prefix identity functions, and key services stay library or host
module capabilities. They are selected by trusted host code, not serialized in
model-authored JSON. Unknown or inline advanced policy fields are rejected.

Read the [normative specification](specification.md), [architecture](architecture.md),
[implementation and migration plan](implementation-plan.md), and addon
[operations guide](../../agentic/code/addons/decision-engine/docs/operations.md).

Structured entry fields, version migration, and rollback rules are described in
[structured entries](structured-entries.md).
Probabilistic downstream feature export is described in
[feature export](feature-export.md).
The default-off conformal prediction research spike and its open-data v2
artifacts are described in [conformal prediction spike](conformal-spike.md).
Jev request, retry, cancellation, and egress behavior is documented in the
[transport contract](jev-transport.md). State projection is mandatory for
network-capable adapters; see [state projection](state-projection.md) and the
[threat-control mapping](threat-control-mapping.md). The
[egress live qualification runner](egress-live-qualification.md) prepares the #2680 live
credential, attack-movement and canary evidence; no live run has been performed.

The [ensemble, champion/challenger and drift-response contracts](ensembles.md)
define versioned D17 schemas, pure validators, and an experimental default-off
offline runtime with injected dispatch, registry and telemetry seams. Live
qualification and production rollout evidence remain pending.

The [routing pilot](routing-pilot.md) defines D28 default-off,
capability-constrained route selection among already-eligible model/subagent
bindings. Shadow mode executes only the existing deterministic route and
records the Jev-assisted choice as a counterfactual. The pilot distinguishes
bounded Jev task-fit evidence from calibrated success probability, and keeps
hard constraints and ordinary authorization dominant over every routing result.

The [offline pattern playground](pattern-playground.md) provides discoverable,
sanitized examples and a governed authoring checklist without requiring network
access or a provider credential.

The [counterfactual sensitivity analyzer](sensitivity.md) defines default-off
experimental plans and reports for bounded policy replay and offline input
reevaluation. Reports are associative diagnostics only: they are not causal
explanations, correctness evidence, or action authorization.

The [issue triage shadow pilot](issue-triage-pilot.md) adds an experimental,
default-off offline harness for Jev issue classification and deterministic
duplicate reranking. It is shadow-only, writes no tracker mutations, and keeps
live holdout, human-review, and promotion evidence pending.
The experimental [SDLC evidence readiness screening](sdlc-screening.md) pack
adds default-off citation and phase-gate advisory screening. Deterministic
gate/citation checks remain authoritative, evidence facts are caller-asserted
and must come from those validators, and promotion needs record-computed
held-out evidence, including paired non-inferiority against the baseline. Live
held-out data is pending.

The [decision-assisted context pruning pilot](context-pruning.md) is
experimental, default-off and shadow-only by default. It implements
deterministic protected-item retention, immutable reversible receipts and
paired-evaluation scaffolding; live/held-out quality and economics evidence
remain pending.

Experimental [multimodal preprocessing lineage](preprocessing-lineage.md)
records how text-only decision input was derived from non-text sources using
recorded OCR, ASR, caption, or image-description fixtures. It is default-off,
does not add native media support to Jev, and stores receipt/trace references
   instead of raw media or derived text bodies.

Decision results are data, not authority. Any workflow action selected from an
outcome must pass the existing AIWG policy and approval gates independently.

The experimental, default-off [shared held-out collector](heldout-collector.md)
provides source-only preparation, bounded synthetic collection and D11 recorded
ledger verification for D17/D29 study modules. Explicit diagnostic, staged
calibration/test, and pre-existing artifact bindings keep collection scope and
scorer identity separate from D09 qualification. Live studies, calibration, human
review and study-specific statistical reports remain pending.

The [D29 synthetic held-out study](d29-heldout-study.md) supplies a seeded
2,000-subject v6 public development demo with balanced inventory records,
replacement-slot screening-control attempts and explicit provider conventions.
Passage baseline v2 is the primary comparator; passage v1 and the original
baseline remain secondary. Development and public-test audits include structural
and claim-relative single/pairwise rules plus an informational model score.
The 165-assessment template covers every variant and injection phrasing in 50
development items. Staged calibration and test access still require separate
approvals and a reviewed D09 artifact. Experimental and default-off, the study
rejects public seeds through `d29-study-v6` and their pinned corpus digests for
paid collection. Live observations, calibration qualification and human review
remain pending.
