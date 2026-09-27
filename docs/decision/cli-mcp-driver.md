# Decision CLI and MCP Driver

The decision driver gives operators one compact surface for governed
classification workflows without replacing the existing dispatcher.

CLI:

```bash
aiwg decision capabilities
aiwg decision patterns list
aiwg decision patterns offline-run bounded-classification classification-known
aiwg decision validate request dispatcher-request.json
AIWG_DECISION_ENABLED=1 aiwg decision evaluate --request dispatcher-request.json
aiwg decision setup synthetic-classification --output-dir .aiwg/working/decision-demo
```

MCP:

Set `AIWG_MCP_TOOLSETS=decision` to expose the decision tools. Evaluation is
disabled unless both `AIWG_DECISION_ENABLED=1` and the per-call `opt_in` flag
are present. MCP evaluation accepts only named profiles from
`AIWG_DECISION_MCP_REQUESTS`, for example:

```json
{"demo":"/absolute/path/to/dispatcher-request.json"}
```

MCP tools never accept arbitrary adapter or host-policy module paths. The CLI
keeps `--request <path>` for an operator-controlled shell workflow.

The synthetic setup command emits reviewable JSON files and a dispatcher request
that points to the shipped offline fixture adapter. It does not configure live
defaults and it does not execute actions.
