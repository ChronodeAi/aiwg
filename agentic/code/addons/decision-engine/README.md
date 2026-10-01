# Decision Engine

The Decision Engine packages AIWG's normalized `decision.aiwg.io/v1alpha1`
contracts and the `decision-evaluate` dispatcher. A workflow pins a ruleset and
binding; changing only the binding selects Jev or an ordinary LLM subagent.

The addon is opt-in at two levels. It is deployed only when named:

```bash
aiwg use decision-engine                     # default provider
aiwg use decision-engine --provider codex    # any supported provider
```

Bulk deploys (`aiwg use all`, including `--copy-all`, and framework deploys
such as `aiwg use sdlc`) do not include it. Its manifest sets
`"explicitInstall": true`. A copy deployed earlier stays in place until you
remove it. Once installed, the dispatcher still refuses to run unless
`AIWG_DECISION_ENABLED=1` is set. Installing it does not enable inference,
migrate existing workflows, or give any outcome the authority to perform an
action.

Runnable offline examples ship with the addon in [`examples/`](examples/README.md).
They are included in the npm package at
`node_modules/aiwg/agentic/code/addons/decision-engine/examples/`.

The `decision-playground` skill lists the installed decision pattern packs and
runs their offline recorded fixtures through the same evaluator, with no
credential or network access. See
[the pattern playground guide](../../../../docs/decision/pattern-playground.md).
The `aiwg decision` CLI and opt-in MCP `decision` toolset expose the same
runtime-backed capabilities, validation, pattern runs, live plans, and
explicitly enabled evaluation. See
[the decision CLI/MCP driver guide](../../../../docs/decision/cli-mcp-driver.md).

The addon also ships a declarative gate pack in [`gate-packs/`](gate-packs/integrity-ceiling.gatepack.yaml)
(`aiwg:decision-engine/integrity-ceiling`, one `upstream-ceiling` floor gate).
Gate packs are experimental, default-off data: no decision-runtime path
evaluates them. The offline `aiwg gates validate|evaluate|show|list` CLI
validates and evaluates packs from files with a fake-clock `--now`. See
[the gates guide](../../../../docs/decision/gates.md).

The packaged dispatcher exposes public JSON fields for artifact paths,
credential environment mappings, adapter selection, projection policies, and
named `hostPolicies` references. The referenced advanced runtime objects are
not public JSON capabilities: batching receipts, schedulers, context planners,
compile caches, result caches, provider-prefix policy, stores, callbacks, and
key services must come from trusted host code. Unsupported or misspelled
request fields fail closed.

See [the operator guide](docs/operations.md) and the repository-level
[decision specification](../../../../docs/decision/specification.md).

The experimental, default-off [D29 synthetic evidence screening study](../../../../docs/decision/d29-heldout-study.md)
provides source-only preparation for 2,000 v3 synthetic subjects, varied
attributes and passages, benign look-alikes, injection/near-miss traps, a
single-feature shortcut audit, per-variant reports and offline receipt-scoring
tests. It uses the shared held-out collector, preserves deterministic gate
authority, and requires
separate live-spend approval and human review.
The committed corpus and gold are public development demos; paid collection
rejects their seeds and corpus digests and requires a fresh private operator seed.

D29 uses two staged approvals: tuning/calibration collection and sealing first,
then offline fitting and operator-reviewed D09 registration before a separately
approved test phase. The [D29 runbook](../../../../docs/decision/d29-heldout-study.md#seal-fit-review-register-and-approve-test-access)
provides source-only commands; no live data or human approval is supplied.
D29 scores through its preregistered absolute-screening gates
(`gate-packs/absolute-screening.gatepack.yaml`, evaluated through
`evaluateGates` with a HOLD ceiling); the offline fixtures exercise them
with zero provider calls.

## Offline comparative sensitivity replay

The experimental D23 comparative replay runner is source-checkout-only and
default-off. It reuses stored synthetic evidence with zero provider calls and
exports a digest-bound HOLD report and 44-assessment operator review packet.
See [comparative replay](../../../../docs/decision/comparative-replay.md) for the
explicit command, passing diagnostic gates, exact artifacts and pending review.

## Experimental D17 study

The source-checkout [ensemble held-out study](../../../../docs/decision/ensemble-heldout-study.md)
prepares a seeded synthetic corpus, frozen splits, priced approval template and
88-assessment review form without a build or provider calls. It reuses the
shared collector and native ensemble/statistical helpers. Collection requires
separate operator approval in `uncalibrated-diagnostic` mode; no calibration
artifact or fixture digest is accepted. Reports explicitly disclaim D09
qualification and calibrated gates. Calibration, live measurements and human
review remain pending. The study is default-off and cannot promote a model.
