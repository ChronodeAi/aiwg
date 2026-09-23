# Decision backend-swap examples

`dispatcher-request-llm.json` exercises the packaged dispatcher and actual
`LlmSubagentDecisionAdapter` against a deterministic terminal worker fixture.
It is offline conformance evidence, not a live provider claim:

```bash
npm run build:cli
AIWG_DECISION_ENABLED=1 node \
  agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate.mjs \
  --request examples/decision/dispatcher-request-llm.json
```

The Jev and LLM bindings pin the same `ruleset.json` and definitions. A backend
swap changes only `bindingPath` (and runtime credential/worker configuration),
not the ruleset, decisions, input, or outcome consumer.
