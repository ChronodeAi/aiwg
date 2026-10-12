# Provider-neutral build readiness verification

`aiwg build-verify --provider <id>` checks that AIWG is deployed correctly before
the selected provider performs a build or CI task. The command reuses the shared
provider definitions and deployment verifier: artifact paths, installed bundle
records, capability indexes, canonical context, provider wiring and available
native inspection all remain in that common implementation.

```bash
aiwg use all --provider codex --scope project
aiwg build-verify --provider codex
```

Use the same commands with `claude`, `grok-build`, `grokbot`, or another registered
provider. Without `--provider`, normal active-provider resolution applies;
ambiguous or invalid selections fail. In CI, select the provider explicitly.

The result is JSON with schema `aiwg.build.verify.v1`, `provider`, `status`,
`verification`, restart guidance and findings. Missing project deployment or any
blocking finding yields a nonzero exit. Advisory findings remain visible.

| Verification level | Meaning |
|---|---|
| `deployment` | Shared file/configuration, registry and discovery checks; native runtime loading is not asserted. |
| `native-inspection` | A documented provider inspector also confirmed the deployed artifacts. |

Where a native inspector is implemented, its absence or failure blocks this CI
gate. Currently Grok Build uses `grok inspect`, checking this project's
`AGENTS.md` and every deployed skill. Other providers retain deployment-level
checks until a documented native inspector is integrated into the shared
verifier. Ordinary `aiwg use`/status inspection retains its advisory behavior.

After verification, let the provider perform the requested task through its
native prompt/configuration and execution tools. This command does not launch
inference, invoke a compiler, run tests, implement scheduling or install plugins.
A successful check does not prove that a model followed instructions. The CI
system still owns job triggers, credentials, timeouts and deterministic tests.

See [Grok Build CI](grok-build-ci.md) for a concrete provider example and
[non-interactive installation](../install/non-interactive.md) for runner setup.
Use [bot-handoff](bot-handoff.md) for shared reviewable prompt proposals.
