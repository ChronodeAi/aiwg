# Decision Engine

The Decision Engine packages AIWG's normalized `decision.aiwg.io/v1alpha1`
contracts and the `decision-evaluate` dispatcher. A workflow pins a ruleset and
binding; changing only the binding selects Jev or an ordinary LLM subagent.

The addon is opt-in. Installing it does not enable inference, migrate existing
workflows, or grant the resulting outcome authority to perform an action.
See [the operator guide](docs/operations.md) and the repository-level
[decision specification](../../../../docs/decision/specification.md).
