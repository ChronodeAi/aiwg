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

## Experimental D17 study

The source-checkout [ensemble held-out study](../../../../docs/decision/ensemble-heldout-study.md)
prepares a seeded synthetic corpus, frozen splits, priced approval template and
88-assessment review form without a build or provider calls. It reuses the
shared collector and native ensemble/statistical helpers. Collection requires
separate operator approval in `uncalibrated-diagnostic` mode; no calibration
artifact or fixture digest is accepted. Reports explicitly disclaim D09
qualification and calibrated gates. Calibration, live measurements and human
review remain pending. The study is default-off and cannot promote a model.
