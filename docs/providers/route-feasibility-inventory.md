# Route-Feasibility Evidence Inventory (S0, B-OG-27)

Bounded feasibility evidence for every provider target in the capability
matrix and provider registry. Issue roctinam/aiwg#2877; proposal
`11-delivery-plan-and-issue-backlog.md` §B-OG-27, `03-software-architecture.md`
§10 (scope authority), `07-stewards-and-catalog-freshness.md` and
`08-security-and-threat-model.md` (Revision 2 Tier 0).

Method (2026-10-07, host titan): free local discovery only — `--version`,
`codex debug models`, Muse model-catalog JSON, checked-in Ralph adapters
(`tools/ralph-external/lib/`), model discovery (`src/models/`) and executor
registration (`tools/ralph-external/lib/provider-adapter.mjs`). No model
calls were made; authorizing a probe budget does not run a probe.

Evidence grades: **H** = help/version inspected on this host (syntax only);
**R** = checked-in adapter/contract evidence; **D** = official
documentation/source, needs live qualification. No row claims inference,
auth, sandbox, tool-list or model qualification from help alone.

Standing rules: help text, flag acceptance and worker echoes do not qualify.
Unknown hidden fan-out or data path blocks strict use. No named target is
silently dropped. Final qualification stays with B-OG-07/08/09/28 (plus
B-OG-36–48 per §10). No target is backend-attested in this pass; every IN
row is runtime-configured-only or unavailable, pending S1 qualification.

## Alias normalization and non-provider names

Matrix `claude-code` normalizes to registry `claude`; aliases never add
providers. `openai` in `src/models/types.ts` is an inference provider, not
another harness — it resolves to the `codex` harness target. Bare `grok`
names the xAI model/API category, not a provider. `generic` is a
registry-only deployment fallback ( nineteenth entry), not an executable
provider and not a matrix row. Devin CLI is a nondeployable future surface
of `windsurf`, not an alias. Gemini is not a provider and was not added.

| Alias / related name | Canonical target | Kind |
|---|---|---|
| `claude-code`, `claude` | `claude` | alias → provider |
| `openai` | `codex` (harness); `openai` (inference) | alias → provider; separate inference name |
| `agy` | `antigravity` | alias → provider |
| `dsh` | `deepseek-harness` | alias → provider |
| `oh-my-pi` | `omp` | alias → provider |
| `pi-coding-agent` | `pi` | alias → provider |
| `devin`, `devin-desktop`, `devin-local`, `cascade` | `windsurf` | alias → provider |
| `devin-cli` | — | future-provider surface, not an alias |
| `tinyhumansai` | `openhuman` | alias → provider |
| `github-copilot` | `copilot` | alias → provider |
| `factory-ai` | `factory` | alias → provider |
| bare `grok`, `muse-spark`, `spark`, `meta` | — | not providers |
| `generic` | — | registry-only fallback, no matrix row |
| `openai` (models `Provider`) | — | inference provider, not a harness |

## Per-target feasibility

Scope IN/OUT follows 03 §10. Every `Budget` is **authorized by the operator
on 2026-10-07 for titan and noodle**, exactly as proposed, as a synthetic probe
ceiling (calls / tokens); OUT rechecks retain 1 call / 0 tokens (help/version
only, no inference), and generic retains 0 / 0. No probes were run. Authorization
does not establish live qualification, which stays with B-OG-07/08/09/28
(plus B-OG-36–48 per §10). `Owner` is the final-qualification issue.

| Target | Scope | Identity | Evidence channel and exact limits | Hidden fan-out / data path | Budget | Owner |
|---|---|---|---|---|---|---|
| `claude` | IN | runtime-configured-only | H: `claude -p --output-format stream-json --verbose`; terminal-result extraction; no sandbox flag inferred; `--max-budget-usd` is budget, not step cap | Unknown: Agent/Task tools, implicit fallback; Ralph adapter currently adds bypass by default so direct profile must differ; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-28 |
| `codex` | IN | runtime-configured-only | H: `codex debug models` (observed 0.160.1: gpt-6.1-sol/astra/sol, gpt-5.6-sol/terra, 272k ctx, ultra = auto-delegation) + `exec --json -o F` thread/turn/item/error stream; native `mcp-server` not advertised by installed help | Unknown: `ultra` self-delegates outside conductor budget — deny ultra; subagents unqualified; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 50000 | B-OG-07 |
| `muse` | IN | runtime-configured-only | H: catalog JSON (observed 1.4.3: muse-spark-1.3 minimal–max, 1M ctx; `-contributor` default is a policy hazard; image model hidden) + `exec --json` invocation-bound session logs; `muse serve` is MSP, not MCP; `--provider echo` is mechanics only | Unknown: subagent/delegation surface unqualified; contributor default never silently selected; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-08 |
| `hermes` | IN | runtime-configured-only | H: `hermes -z` plain final + `--usage-file` (observed 0.20.6); session-filtered log binding required, global log growth proves nothing; `-z` auto-bypasses approvals so external sandbox/tool restriction is required | Unknown: native moa/fallback chains must be disabled/qualified; conversation tools are not worker calls; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-48 |
| `copilot` | IN | runtime-configured-only | D: `copilot -p --output-format json`; scoped `--allow-tool`, never allow-all; effort via `effortLevel` settings needs isolated profile qualification; agent-definition model may override `--model` | Unknown; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-36 |
| `factory` | IN | runtime-configured-only | R: `droid exec --output-format stream-json`; existing adapter `--skip-permissions-unsafe` is prohibited in default profiles; effort/autonomy/step controls unqualified | Unknown (Missions); restricted writing blocked until controls proven; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-37 |
| `cursor` | IN | runtime-configured-only | D: `agent -p --output-format json` (+`--sandbox enabled`); do not infer `--force` is a sandbox; effort/step caps unknown | Unknown; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-38 |
| `opencode` | IN | runtime-configured-only | R: `opencode run --format json`; `--variant E` is provider-specific; permissions need a qualified profile, not `--auto`; `serve` is HTTP, not MCP | Unknown; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-39 |
| `warp` | IN | runtime-configured-only | D: `oz agent run --prompt/--model/--cwd/--profile`; effort/JSON/step caps not established; remote/cloud routes are separate | Unknown; qualify Oz as the Warp interface, not a new provider; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-40 |
| `grok-build` | IN | runtime-configured-only | R: `grok -p --output-format streaming-json`; headless options lack explicit model/effort — extend before enablement; ACP adapter is not MCP | Unknown: `--no-subagents` is flag evidence only; version-scoped behavioral evidence with model/effort pinning must prove child control; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-41 |
| `openclaw` | IN | runtime-configured-only | D: `openclaw agent exec --json`; workspace/settings mapping, effort/step controls need live qualification; never add `--fallback`; gateway path is distinct | Unknown; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-42 |
| `antigravity` | IN | runtime-configured-only | R: `agy -p` stream-json per provider-contract; fixture-qualified flags only; soft tool denials may coexist with exit zero; never add `--dangerously-skip-permissions` | Unknown; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-43 |
| `deepseek-harness` | IN | runtime-configured-only | R: `dsh --profile headless` + validated Cordis route patch (model/effort live in the patch, no guessed `--model` flag); `DSH_PERMISSION_MODE=workspace-write`, telemetry disabled | Unknown: enforcement/child control and terminal parsing unqualified; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-44 |
| `pi` | IN | runtime-configured-only | R: `pi --mode json --model/--thinking/--tools`; `--no-approve` is a safety hazard needing explicit semantics; no budget/max-turn controls; JSON mode has no stdin abort | Unknown; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-45 |
| `omp` | IN | runtime-configured-only | R: `omp --mode json --model/--thinking/--profile`; `--no-tools` for text-only; no max-turn flag assumed; do not assume Pi parser/flags are identical | Unknown; blocks strict use | authorized (operator, 2026-10-07; titan, noodle): 3 / 30000 | B-OG-45 |
| `local` (ollama / llama-server / OpenAI-compatible) | IN | unavailable | H: ollama 0.33.3 and llama-server installed but not running — stopped endpoint excluded without startup; bounded HTTP (`/api/generate` or equivalent), exact model in request body, effort null when unsupported; required profile: text-only roles and no cloud transfer (unproven) | Unknown fan-out and processing: endpoint ownership, upstream forwarding/redirects, cloud fallback, tools, telemetry and enforced egress controls unresolved; local-only whole path unproven; blocks strict use. Required: disable cloud inference/tools/telemetry and enforce egress; never start servers, download weights, or kill a shared server to cancel one request; health ≤60s old per 07 | authorized (operator, 2026-10-07; titan, noodle): 2 / 20000 | B-OG-09 |
| `windsurf` | OUT | unavailable | R: no verified headless Desktop worker command; IDE startup is not inference; MCP client config is not worker serving | Unknown; recheck B-OG-47 before any scope change | authorized (operator, 2026-10-07; titan, noodle): 1 / 0 | B-OG-47 |
| `grokbot` | OUT | unavailable | R: desktop CreateAgent/registered-machine capabilities establish no headless subprocess contract; connectors consume tools | Unknown; recheck B-OG-47 | authorized (operator, 2026-10-07; titan, noodle): 1 / 0 | B-OG-47 |
| `openhuman` | OUT pending evidence | unavailable | R: `agent list/dump-prompt/dump-all` inspect prompts, do not launch workers; headless core/RPC deployment alone establishes no one-shot CLI/MCP call | Unknown; promote into S1 if qualifying evidence appears (B-OG-47) | authorized (operator, 2026-10-07; titan, noodle): 1 / 0 | B-OG-47 |
| `generic` | OUT | unavailable | Registry-only fallback, no binary or flags; custom adapters remain extensible through the existing factory | N/A — not an executable route | authorized (operator, 2026-10-07; titan, noodle): 0 / 0 | — |

Machine-readable scope/identity/channel/fan-out/budget rows for the 18
matrix providers live in `agentic/code/providers/capability-matrix.yaml`
(`route_feasibility`, typed via `getRouteFeasibility` in
`src/providers/capability-matrix.ts`). `generic` and `local` are
registry/docs-only rows by design: `generic` has no matrix entry and local
endpoints are ordinary members, not registry providers.

## Source anchors used

Ralph adapters: `codex-adapter.mjs:74`, `muse-adapter.mjs:125`,
`claude-adapter.mjs:50`, `factory-adapter.mjs:69`,
`opencode-adapter.mjs:81`, `pi-adapter.mjs:45`, `omp-adapter.mjs:12`,
`deepseek-harness-adapter.mjs:17`, factory `provider-adapter.mjs:95`
(registration) and `:228` (local transport). Model discovery:
`src/models/model-discovery.ts`, `src/models/provider-policy.ts:107`
(`openai` excluded from harness policy), `src/cli/handlers/models.ts:37.
Executor/control evidence: adapter `getCapabilities`/`buildSessionArgs`
plus 03 §11.3 health extension columns.

## Findings for the conductor

1. `src/cli/handlers/models.ts:37` omits `muse` from its provider set
   despite the registry entry — consumer mismatch already noted in 03 §10;
   fix belongs to S1 (B-OG-02/04), recorded here, not changed in this pass.
2. Codex `ultra` ("automatic task delegation") and Hermes native
   moa/fallback are evidenced hidden fan-out: deny or externally bound
   before any strict use.
3. Codex ships a stale-default hazard (hidden gpt-5.5 remains the config
   default) and Muse a contributor-default policy hazard: S1 profiles must
   pass model and effort explicitly, resolved from policy.
4. No backend-attested identity exists for any target in this pass;
   backend attestation, where possible, is S1 qualification work.

## Open questions

- Who records the version/account/profile scope of each paid probe during
  S1 live qualification on the authorized hosts titan and noodle?
- Should the OUT recheck budgets (1 call / 0 tokens, help/version only)
  also cover a fake-MCP `tools/list` pin where a native server is claimed?
