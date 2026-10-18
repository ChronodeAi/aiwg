# ADR: Rule activation and bound-rule delivery

Status: accepted
Date: 2026-10-18
Decision owners: AIWG maintainers
Related: #2935, #2936–#2945, #3222, #2562, #2839, #2645, #2646

## Context

Severity currently determines delivery through `isAlwaysOnRule` in
[`base.mjs`](../../tools/agents/providers/base.mjs). CRITICAL/HIGH and unclassified
rules pass; MEDIUM/LOW do not. `applies_to`, `scope`, and manifest `rules` arrays
do not deliver bindings. `showArtifact` in
[`query-engine.ts`](../../src/artifacts/query-engine.ts) returns artifact text
without its rules. The Cursor adapter's comments describe activation support,
but its current transform mostly forces `alwaysApply: true`; the implemented
exceptions recognize `globs`/`applyTo`, not the proposed five-mode schema.

The epic's October 17 baseline reports 207,444 B of rules and indexes plus
33,411 B of behavior context on `aiwg use sdlc --provider claude`: 240,855 B,
approximately 60K tokens, repeated in sessions and subagents. Its original
155,740 B measurement describes an older project-local deployment, not this
fresh SDLC profile. The corpus snapshot in that update is 159 rules; counts
and byte totals are measurements, not schema constants.

An offline replay of the framework, addon, and extension rule deployment
passes at this worktree's `c59e7a9e1` reproduces **207,444 B** and all six
budget demotions. Its directory contains **39 bodies plus two indexes**, not
the update's reported 40 bodies. The appendix enumerates the actual files
rather than inventing a fortieth. The eight generated behavior files total
32,927 B in this replay (240,371 B combined); their wrappers contain deployment
paths, so retain the PO's 33,411 B as its original baseline, not a byte-exact
fixture for another target path. Phase 0 (#2936) must pin source, target-path
normalization, and counting method for reproducible comparisons.
These directory-byte measurements include native path-scoped files; actual
harness startup loading can defer those bodies. Keep the directory footprint
and observed context consumption separate in Phase 0 reports.

The 64,000-token default in #2562 uses estimated UTF-8 bytes / 4, not a 64 KB
limit. Largest-first reconciliation across deployment passes drops
`anti-laziness`, `auto-compact-continue`, `cli-secondary`,
`debug-source-not-output`, `delivery-policy`, and `subagent-scoping` into
discovery with no binding. This is a delivery defect even though an on-demand
index still calls them binding rules.

## Decision

### Activation selects delivery; severity selects consequence

Each authored rule and behavior declares exactly one activation mode. Severity
(`enforcement`) remains independent: a scoped CRITICAL rule can be bound, and a
HIGH universal rule can be kernel. Installation/trust selection still applies;
activation does not install an excluded addon or authorize an operation.

| Mode | Delivery obligation | Incremental global startup cost |
|---|---|---|
| `kernel` | Load the complete canonical rule body in every session and subagent before task execution. | Full body plus framing. |
| `summary` | Load one imperative summary and a full-rule pointer in the kernel index; deliver it through bindings as well when declared. | Summary (at most 240 characters), identity, and pointer, never the full body. |
| `bound` | Deliver when a declared skill, agent, or flow is loaded/invoked. | Zero rule text; bound blocks live inside artifact bodies, not their startup listings. |
| `paths` | Deliver the full rule when any declared project-relative path glob matches a file being read or changed; bindings can also deliver it. | Native loaders: no unmatched body, possibly native description/glob metadata. Emulated loaders: a compact glob/summary/pointer index, never unmatched bodies. |
| `on-demand` | Discoverable and explicitly fetchable; no automatic delivery. | Zero rule text; use the shared discovery entry point rather than a startup list of every rule. |

Provider skill/agent listings have their own cost; `bound` does not promise to
eliminate that existing cost. Invocation-time retrieval counts as task context.
Bootstrap retrieval of kernel bodies counts as startup context even if it uses
a file read rather than an inline import. Measurements must not hide either.

`bound_to` is an additional delivery route, not a sixth mode. The epic's
“bound + paths” means **`activation: paths` plus `bound_to`**, with OR semantics.
Either a matching file or a bound artifact activates delivery. Identity-based
deduplication prevents duplicate rule text within one artifact/show response.

### Frontmatter contract for #2938

This is the source shape; this ADR adds no parser, schema, or runtime behavior.
Existing rule identity, severity, description, and discovery triggers remain.

```yaml
---
name: debug-source-not-output
enforcement: high
activation: paths
summary: "Locate and fix canonical source before changing generated output; regenerate and verify the result."
bound_to:
  skills: []
  agents: [debugger, self-debug]
  flows: []
paths: ["tools/**", "src/**", "agentic/**", "dist/**"]
---
```

The example uses existing debugging agents. #2938 validates concrete targets
against the artifact index before accepting a migrated declaration.

| Field | Shape and validation |
|---|---|
| `activation` | Scalar enum: `kernel`, `summary`, `bound`, `paths`, `on-demand`. Required after migration. A sequence, combined string, or unknown mode is an error. |
| `summary` | Nonempty single-line imperative string, at most 240 Unicode code points after trimming. Required for `summary`, `bound`, and `paths`; optional for `kernel`/`on-demand`. Never synthesize it by truncating the body. |
| `bound_to` | Mapping with only `skills`, `agents`, `flows`; each value is a list of nonempty canonical artifact IDs. Missing lists mean empty. At least one target is required for `bound`; optional for `summary`/`paths`. Reject bindings on `kernel`/`on-demand` as contradictory or redundant. |
| `paths` | Nonempty list of project-relative glob strings, required for `paths` and rejected on other tagged modes. Match normalized `/` paths; reject absolute paths and parent traversal. Match reads and writes, including proposed new filenames. |

Bindings resolve by artifact type and canonical ID, using existing index
precedence and ambiguity errors. They are exact identifiers, not title guesses,
filesystem paths, or unresolved wildcard families. Tables below use `flow-*`,
`issue-*`, and role families as migration shorthand: each wave expands them to
concrete installed/indexed targets and lints them. A declared missing or
ambiguous target fails lint; there is no silently empty binding. A valid target
outside the selected deployment need not be copied just because a rule names it.

Flows retain their indexed identity even when a provider projects them as a
skill or command. The deployed representation receives the same block. An
artifact naming rules in its manifest does not create the reverse binding.
Migrate `applies_to`/`scope` intent to explicit `bound_to`; they remain descriptive
legacy metadata, not competing activation inputs. Manifest `rules` arrays remain
inventory only.

Reserve the exact key **`enforcedBy`** for #2839. Do not author it in this wave,
assign a value schema, dispatch hooks, or infer mechanical enforcement from it.
If encountered, preserve it as opaque reserved metadata and report that it has
no effect. #2839 owns its eventual type and enforcement semantics. Activation
delivers instructions; it is not proof that a runtime enforces them.

### Both binding delivery paths are required

**A — Deploy time:** the existing base deployer resolves reverse bindings and
adds a generated `Bound rules` block to each deployed skill, agent, and flow
body, after provider projection as needed. Kernel-listed artifacts need this
because native invocation can bypass `aiwg show`. Use managed delimiters,
replace rather than accumulate the block on redeploy, sort by canonical rule
ID, and preserve authored content. Do not add the block to artifact descriptions
or aggregate every bound body into provider startup files.

```markdown
<!-- AIWG:bound-rules:start -->
## Bound rules

- debug-source-not-output — Locate and fix canonical source before changing generated output; regenerate and verify the result.
  Fetch and follow before governed work: `aiwg show rule debug-source-not-output`.
<!-- AIWG:bound-rules:end -->
```

**B — Show time:** `showArtifact` resolves the same bindings for source artifacts
and appends the same summary/pointer block in text output. It covers discovered
artifacts whose source has no generated block. The JSON envelope adds
`bound_rules[]` for bound artifacts; keep `content` as authored source text.
Unbound artifact output remains unchanged, including no new empty JSON member.
The proposed opt-in `--with-rule-bodies` adds complete bodies (and text sections)
for callers that must forward a self-contained task to another agent.

```json
{
  "bound_rules": [{
    "name": "debug-source-not-output",
    "activation": "paths",
    "summary": "Locate and fix canonical source before changing generated output; regenerate and verify the result.",
    "show_command": "aiwg show rule debug-source-not-output"
  }]
}
```

With the flag, each item additionally has `content`, the complete rule body.
Summaries are priming, not substitutes for fetching detailed requirements:
invocation instructs the consumer to fetch the body before its governed work.
Default full-body injection would multiply context across many artifacts and
subagents. Explicit body expansion supports deterministic handoff at the cost
of larger task context. Never truncate an expanded body to fit a budget.

[`src/mcp/tools/discovery.mjs`](../../src/mcp/tools/discovery.mjs) already wraps
CLI JSON show. Extend its existing skill/agent/command (including projected
flow) tools with equivalent body-expansion input and return the identical
`bound_rules` shape; do not build another binding registry. `aiwg show rule X`
also lists its resolved bound targets. Source and deployed representations must
not cause double expansion; resolve one direct reverse lookup, not recursive
rule-to-rule inclusion. Missing declared rule content produces a diagnostic
and failure, not a successful artifact response with an incomplete contract.

Behavior contracts use the same resolver and block. Index their rule-facing
projection as `behavior/<name>` so, for example,
`aiwg show rule behavior/concierge` cannot collide with the `concierge` agent.
This reuses the existing artifact index/query path, not a separate subsystem.
Native behavior hook/script execution remains owned by its current runtime.

### Provider projection

These capability statements describe the checked-in adapters, not unverified
claims about future vendor releases. `support.rules: native` alone does not
establish native support for every activation mode. The target projections
below are work for #2939, not descriptions of already-shipping bindings.

| Provider and current source | `kernel` / `summary` target | `bound` / `on-demand` target | `paths` target |
|---|---|---|---|
| [Cursor](../../tools/agents/providers/cursor.mjs): native MDC rules; conventional agents/commands | Full kernel MDC with `alwaysApply: true`; always-applied summary index. Optional full summary-mode rule uses `alwaysApply: false` plus `description` for native auto selection. | Bound artifact blocks and show/MCP; no auto description or always-applied body for bound rules. On-demand bodies use explicit show/manual reference. | Native MDC `globs` from `paths`, `alwaysApply: false`; no severity prefilter. |
| [Claude](../../tools/agents/providers/claude.mjs): native `.claude/rules`, agents and skills | Complete kernel bodies and summary-only `RULES-INDEX.md` in native rules. | Blocks in native artifact bodies plus show/MCP. Keep bound/on-demand full bodies outside the recursively loaded rules tree. | Native rule frontmatter `paths`; preserve any tier. |
| [Codex](../../tools/agents/providers/codex.mjs): conventional `.codex/rules`, native skill/agent deployment | Managed startup context reached through `AGENTS.md` must carry full trimmed kernel bodies and the summary index; a conventional rules directory alone is insufficient. | Blocks in loaded artifacts plus show/MCP; no assumed rule-directory loader. | Emulated path index/check through the startup instruction; fetch matches before file work. No native glob attachment in this adapter. |
| [Hermes](../../tools/agents/providers/hermes.mjs): native home skills, aggregated agent routing, no rule loader | Startup context reached through `.hermes.md`/`AGENTS.md`. Replace hardcoded compressed CRITICAL directives with activation-selected kernel and summary content. | Blocks in skills and fetched agent/flow definitions plus show/MCP. Aggregated routing entries point to definitions rather than inlining bound blocks. | Emulated path index/check; no native glob loader in this adapter. |
| [Warp](../../tools/agents/providers/warp.mjs): native skills; agents/rules aggregated into `WARP.md` via setup script | Managed kernel/summary section in startup context reached through `WARP.md`. Include the aggregate writer in the change; discrete `.warp/rules` copies are insufficient. | Blocks in skills/fetched definitions plus show/MCP; keep only agent/flow routing pointers in startup aggregation. | Emulated path index/check; no native glob attachment in this adapter. |
| [OpenClaw](../../tools/agents/providers/openclaw.mjs): native rule/behavior directories, active workspace `AGENTS.md` bridge | Kernel/summary delivery through native rules and the active-workspace bridge; verify actual loading, not just home-directory file existence. | Blocks in artifact definitions plus show/MCP; native behavior activation remains available. | Emulated path index/check: the adapter has no path-condition translator despite its native rule directory. |

Cursor's `auto(description)` is a model-selected retrieval hint, not an exact
binding or a guaranteed policy gate. It supplements summary-mode delivery; it
cannot replace A or B. `on-demand` and `bound` must not accidentally become
auto rules merely because source discovery metadata has a description. Both
the adapter transform and external Cursor deploy script must honor the mapping;
remove the old blanket always-apply fallback for tagged rules.

For emulated `paths`, add a fixed instruction to the kernel index: before
reading/changing files, compare intended paths with the compact path-rule index,
then fetch matching bodies. The index contains ID, globs, summary, and pointer.
An agent-only task has no path match. If the task starts without known paths,
check when paths become known, before their first read/write. This is prompt
emulation, not an OS hook or mechanically guaranteed interception; fixtures
and positive/negative probes must expose that limitation. Do not inline all
path-rule bodies as a fallback.

Codex currently inlines no rule bodies: its benefit is compliance, not a
claimed token saving. Kernel parity may add text there; deduplicate existing
startup directives and measure total startup context, including bridge reads.
The epic's no-provider-regression gate still applies; an adapter that cannot
meet parity and its budget blocks that wave rather than claiming a free gain.
Keep Codex `AGENTS.md` below 32 KB. Hermes currently warns above 15,000 characters
and fails above 19,000; full kernel projection must fit those limits after
trimming, or report failure. Do not silently compress a tagged `kernel` rule
into `summary` to fit. Reuse the existing bootstrap/context owners and preserve
operator content instead of creating a second provider policy file hierarchy.

### Budget is a guard, never an activation selector

Resolve activation, bindings, and provider projection first; then calculate
startup cost across the final assembled deployment, including indexes,
behaviors, generated wrappers, and emulated path metadata. Intermediate addon
passes must not demote files or hide a final overrun.

#2938 introduces `rules.inline_budget_tokens` in `aiwg.config`; the existing
`AIWG_RULES_INLINE_BUDGET_TOKENS` override wins. Default remains 64,000, and zero
disables this configurable guard only, not provider hard caps. Invalid values
are diagnostics. Retain the documented bytes / 4 estimate with raw bytes in
reports so this is not mistaken for exact vendor token accounting.

The existing lint runner reports limit, selected total, provider, and per-file
contributors. CI/strict deployment fails on an overrun; migration/report-only
lint may warn. A warning preserves the entire activation-selected set. A
failure leaves the prior managed deployment intact by validating the planned
result before promotion. Neither outcome changes a rule's activation. Remove
the budget sidecar's authority to suppress files; reconcile old managed files
and retire stale `.aiwg-rules-budget.json` state during #2939 deployment.

Resolve the six existing demotions explicitly, with binding before removal:

| Previously demoted rule | Intended delivery |
|---|---|
| `anti-laziness` | `summary`, bound to code-producing/review/testing agents and iterative coding workflows; its detailed policy is scoped to implementation, not every conversational turn. |
| `auto-compact-continue` | `summary`, bound to Ralph, missions, and long-running flows. |
| `cli-secondary` | `summary`, bound to steward, finder, and maintenance artifacts. |
| `debug-source-not-output` | `paths` plus debugger/self-debug bindings. |
| `delivery-policy` | `summary`, bound to delivery/release/tracker artifacts. |
| `subagent-scoping` | `summary`, bound to orchestration artifacts. |

Until each move passes its behavioral gate, restore that rule's intended
pre-budget fallback delivery. If the restored set exceeds the guard, report or
fail explicitly; do not reintroduce discovery-only limbo. Raising a guard may
unblock a reviewed migration deployment but cannot override a provider cap.

### Untagged migration fallback

Missing `activation` produces a lint warning naming the file and inferred
delivery. Preserve the old **tier selection**, not its silent budget loss:
CRITICAL/HIGH, BLOCK, unknown, and absent enforcement remain kernel candidates;
MEDIUM/LOW remain on-demand. Generated indexes are structural exceptions, not
authored rules admitted by severity. Preserve existing provider behavior for
untagged rules, including legacy path transforms and Hermes directives, while
warning about gaps. Tagged `paths` rules bypass the tier filter, fixing
MEDIUM `sdlc-orchestration` and `voice-framework` when migrated.

An invalid explicit activation is an error, never “untagged.” Existing behavior
wrappers remain loaded until explicitly migrated; absent severity is not a
reason to drop them. #2945 and #3222 promote missing-activation warnings to
errors for the complete authored corpus. No permanent tier fallback remains
after coverage reaches 100%.

### Testable kernel admission

A proposed kernel rule must pass **all** of these review/fixture checks:

1. **Universal guard:** name the invariant every agent must preserve before
   knowing its task, tool, path, workflow, or daemon role. A rule whose only
   trigger is release, debugging, orchestration, a bot message, or a particular
   file tree fails. A universal prohibition can be dormant on a given turn;
   it must still constrain every role whenever that action arises.
2. **Retrieval cannot precede the need:** supply a counterexample where a
   compliant agent could violate the invariant before selecting any scoped
   artifact/path. If a binding/path can always deliver it first, choose that
   route instead. “HIGH” or “important” alone does not pass.
3. **Compact, self-contained authority:** put only the imperative core in the
   kernel rule, with no required dereference to learn that core. Move long
   examples/rationale into on-demand companions, without truncating the rule
   at deployment. Reject duplicate normative text already supplied by another
   kernel rule or startup template; verify generated startup output for repeats.
4. **Provider fit:** a deployment fixture for all six providers loads the
   complete selected kernel once, including subagent dispatch, and passes the
   configured guard and provider caps. References without demonstrated loading
   fail this check.
5. **Observed compliance:** provide positive probes for the universal invariant
   and ordinary tasks outside its originating workflow, n=5 each. Meet or
   exceed baseline with no probe below 80%. Failed admission retains the prior
   placement and blocks the move; word count or severity cannot waive it.

The five core candidates below satisfy the universal-guard rationale:
authorization limits any action; comprehension constrains every directive;
research-before-decision prevents unsupported decisions in any role;
skill-discovery establishes the universal routing obligation; artifact-output
policy constrains any artifact before its destination can be chosen. Their
long bodies still require trimming and validation in #2944. Additional
`no-attribution`, `token-security`, and `citation-policy` candidates cover output
authorship, secret disclosure, and fabricated claims across roles. Their
examples remain candidates for extraction in #2945, not blanket exemptions
for all CRITICAL rules. For example, CRITICAL `versioning` is release-scoped.

### Starting disposition: the epic's 20 rules

This preserves the epic's starting map and resolves its mixed-mode notation.
Targets are migration families subject to the exact-ID resolution above.

| Rule | Activation | Binding/path scope and reason |
|---|---|---|
| human-authorization | kernel | Universal action authority. |
| instruction-comprehension | kernel | Universal directive interpretation. |
| research-before-decision | kernel | Universal decision grounding. |
| skill-discovery | kernel | Universal capability routing guard. |
| artifact-output-policy | kernel | Universal artifact destination guard. |
| auto-compact-continue | summary | Ralph, aiwg-mission, long-running flows; continuity needs a startup reminder and scoped details. |
| delivery-policy | summary | aiwg-pr / aiwg-delivery-pr, issue-*, flow-delivery-track, release, steward; delivery is not every turn. |
| cli-secondary | summary | steward, aiwg-finder, maintenance; short routing reminder, details on use. |
| subagent-scoping | summary | aiwg-mission, mission-control, Ralph, rlm-*, orchestration flows; bind current text now, #2645/#2646 adopt schema later. |
| god-session | summary | agentsmith and agent-authoring artifacts; context limits matter when authoring/dispatching. |
| sdlc-right-sizing | summary | intake-*, flow-*, sdlc-accelerate; startup reminder prevents oversizing before workflow selection. |
| native-ux-tools | summary | interactive skills/commands; startup reminder guides tool selection. |
| respect-repo-access-manifest | summary | git/tracker/ops artifacts; short access reminder, details before repository operations. |
| vague-discretion | bound | Ralph, aiwg-mission, gate authoring; measurable completion criteria belong to bounded execution. |
| escalation-discipline | bound | Fleet/bot agents and model-tier routing; unattended escalation policy. |
| tool-quota | bound | Fleet/bot agents, Ralph, aiwg-mission; scoped loop/quota discipline. |
| quiet-mode | bound | Fleet/chat bot agents; general coding sessions must not adopt bot silence. |
| debug-source-not-output | paths | debugger and self-debug agents, resolved debugging skills, plus canonical/generated source globs; either route activates. |
| decision-offload | bound | Decision-engine skills only when installed; their existing `decision.enabled` check controls execution. No new conditional activation language. |
| agent-deployment | paths | Preserve existing agent/provider source globs, including agentic/** and AGENTS.md. |

### Behaviors inventory and #3222 disposition

The eight `.claude/rules/behaviors/*.md` files are generated by
`collectBehaviorDirs` / `deployEmulatedBehaviors` in the same base deployer.
The first four sources below are under `agentic/code/behaviors/`, two under
`agentic/code/frameworks/sdlc-complete/behaviors/`, and two under
`agentic/code/addons/aiwg-fleet/behaviors/`; each uses `<name>/BEHAVIOR.md`.

| Deployed file | Contract and actual runtime consumer | Proposed bound agents / reason |
|---|---|---|
| `concierge.md` | Daemon front desk: routing, tone, session memory; `concierge` agent. The executable daemon loader uses the separate addon `concierge.behavior.md` and `tools/daemon/concierge/orchestrator.mjs`, not this directory bundle. | `concierge`; bound to the daemon interaction role, not all sessions. |
| `test-watcher.md` | Source/test file-write triggers and two-hour test schedule; bundle scripts/native behavior runtime. No dedicated indexed watcher agent is declared today. | `test-engineer`; bound to test execution, with the daemon's model-assisted watcher task routed through this definition. |
| `build-monitor.md` | Build/tsc completion and four-hour build checks; bundle scripts/native behavior runtime, not an always-running coding agent. | `build-engineer`; bound to build monitoring tasks. |
| `security-sentinel.md` | File-change scans, post-deploy checks, six-hour audits; bundle scripts/native behavior runtime. | `security-auditor`; bound to scanning tasks. General secret safety remains kernel. |
| `artifact-sync.md` | SDLC artifact-write triggers; incremental/full index synchronization scripts. | `context-librarian` (also bind `build-artifact-index` skill); artifact indexing is scoped work. |
| `quality-gate-watcher.md` | Commit/PR gate checks and phase evaluation; scripts/native behavior runtime. | `quality-assessor`, `security-gatekeeper`; bind evaluation tasks, not every development turn. |
| `quiet-bot.md` | Fleet message-addressing policy; OpenClaw bot runtime. Fleet documentation names InfsolClaw as an example, not a shipped agent definition. | Proposed `fleet-quiet-bot` adapter agent; mention-only chat policy must not silence unrelated agents. |
| `quiet-business-bot.md` | Fleet addressing plus strict business domain; Quickbooksbot is the documented deployment example, not an indexed agent. | Proposed `fleet-business-bot` adapter agent; domain restriction belongs to that bot role. |

All eight use **`activation: bound`**; none passes kernel admission. These are
proposed bindings, not claims that watcher scripts currently invoke the named
SDLC agents. #3222 must wire model-assisted daemon/bot entry points to load their
selected agent definition and its bound rules before handling a matching event.
Script-only handlers continue to execute through existing hook/runtime owners;
prompt injection must not start a schedule or execute scripts at deployment.

The fleet addon ships behavior bundles but no agents. #3222 must add the two
small indexed adapter definitions named above (or resolve an explicit reviewed
project-owned equivalent), then validate bindings. Do not invent an unresolved
`agents: [Quickbooksbot]` binding or silently skip it. Keep old delivery until
the adapter and U3/U5 fixtures exist. This is ordinary agent authoring and
existing daemon dispatch, not a new behavior scheduler or binding service.

The daemon addon's `behaviors/concierge.behavior.md` is a distinct lifecycle
contract, not a ninth file in this measured Claude directory. Coordinate its
metadata with the `concierge` binding while retaining its module/hook behavior.
OpenClaw's native behavior installation and hooks are preserved; #3222 changes
Claude context placement, with other provider blocks owned by #2939.

## Alternatives and trade-offs

| Alternative | Benefit | Reason not selected |
|---|---|---|
| Continue tier-only loading plus largest-first budget demotion | Small implementation and bounded directory size. | Conflates severity with relevance and silently removes compliance; six rules already demonstrate the failure. |
| Only deploy-time blocks (A) | Native invocation carries policy without another query. | Discovered source artifacts bypass deployed copies. |
| Only show/MCP expansion (B) | One retrieval point and no generated block maintenance. | Native kernel skill/agent invocation can bypass show entirely. |
| Full rule bodies in every bound artifact by default | Self-contained invocation without a follow-up read. | Duplicates large bodies across artifacts and dispatches; explicit show expansion supplies this when needed. |
| Summary-only delivery with no full-rule fetch obligation | Lowest invocation cost. | A 240-character core cannot encode detailed compliance requirements. |
| Native provider modes only | Less emulation and closer harness integration. | Leaves Codex/Hermes/Warp without path parity and treats Cursor auto selection as guaranteed binding. |
| Make all CRITICAL rules kernel | Conservative severity handling. | Release-only and other scoped safety rules still inflate unrelated contexts; admission must be about universal applicability. |
| Drop untagged rules or default all to on-demand | Immediate startup reduction. | Breaks existing compliance during migration; tier fallback with warnings is explicit and reversible. |

Both delivery paths require idempotent generation and parity fixtures.
Summaries add a retrieval step and path emulation depends on agent compliance.
The guard can now block deployment instead of producing a smaller incomplete
one. Those costs are preferable to silently changing which instructions apply.

## Rollout and validation

Keep ownership in base/provider writers (including Warp/Cursor aggregate
scripts), the artifact index/query engine, MCP discovery wrappers, and the
existing lint runner. This ADR does not implement #2938–#2940 or #2839.

#2936 measures rules **and behaviors**, indexes, bootstrap duplication, and
per-provider/subagent context before moves. #2938 adds schema/lint/guard;
#2939 and #2940 supply both delivery paths before migration waves remove
startup bodies. #3222 completes behavior bindings alongside those changes.
Wave 3 binds existing orchestration text without waiting for #2645/#2646.

Retain U1–U9 as release gates: U1 ≤110,000 rule bytes after Wave 1 and ≤45,000
after Wave 4, with behavior bytes separately reported and included in total;
U2 complete activation coverage by migration end; U3 resolving bindings and
injected blocks on six providers; U4 CLI/MCP JSON parity; U5 n=5 compliance at
least baseline and ≥80%; U6 top-three natural-language rule discovery; U7 no
irrelevant fetch in at least 4/5 negatives; U8 full-deploy steward/mission
subagent dispatch headroom; U9 provider fixtures and Codex <32 KB.
The full-profile ~40–55 KB outcome remains a projection pending Wave 5 and
behavior validation, not an achieved result of this documentation change.

Add fixtures for each mode/provider, mixed paths/bindings, negative nonmatches,
invalid modes, missing summaries/targets, idempotent redeploy, unchanged unbound
show output, body-expansion opt-in, legacy fallback warnings, and budget overrun
without any demotion. Include behaviors and old budget-sidecar recovery.
Behavioral model probes belong to the authorized later validation run; this ADR
work uses offline inventory and tests only. A failing move reverts individually
to `activation: kernel`, removing incompatible binding/path fields as necessary;
the guard still reports any resulting overrun. No wave ships without U1–U9.

## Machine-readable starting map

This appendix is a disposition inventory, not authored frontmatter. `rules`
lists every body in the reproduced SDLC/Claude always-loaded directory;
`generated` lists its two indexes; `behaviors` lists all eight wrappers.
`budget_demoted` restores visibility of all six absent bodies. The epic's
`decision-offload` is included separately because its explicit-install addon is
absent from this profile. Group keys resolve beneath `agentic/code/`; rule keys
are `.md` stems. Behavior keys resolve to `<source_root>/<name>/BEHAVIOR.md` and
deploy as `.claude/rules/behaviors/<name>.md`. Bindings for the epic's 20 are
defined above; remaining corpus assignments are starting decisions for #2945,
subject to exact targets and probes before removal from startup.

```yaml
version: 1
profile: sdlc/claude
source_revision: c59e7a9e1
measurement:
  rule_body_count: 39
  generated_index_count: 2
  rules_and_indexes_bytes: 207444
  behavior_count: 8
  behavior_bytes: 32927
  total_bytes: 240371
  po_baseline_total_bytes: 240855
  behavior_wrapper_paths_affect_bytes: true
generated:
  RULES-INDEX.md: {activation: kernel, action: rewrite-as-summary-and-path-index}
  RULES-ONDEMAND.md: {activation: on-demand, action: replace-startup-list-with-discovery-pointer}
rules:
  addons/aiwg-utils/rules:
    agent-deployment: paths
    artifact-output-policy: kernel
    escalation-discipline: bound
    god-session: summary
    human-authorization: kernel
    instruction-comprehension: kernel
    native-ux-tools: summary
    quiet-mode: bound
    research-before-decision: kernel
    respect-repo-access-manifest: summary
    sdlc-right-sizing: summary
    skill-discovery: kernel
    tool-quota: bound
    vague-discretion: bound
  addons/browser-control/rules:
    browser-control-safety: bound
  addons/daemon/rules:
    daemon-interaction: bound
  addons/network-analysis/rules:
    network-analysis-safety: bound
  addons/prose-integration/rules:
    prose-resolution: bound
  addons/rlm/rules:
    rlm-context-management: bound
  addons/schema-governance/rules:
    schema-first: paths
  addons/testing-quality/rules:
    test-conformance-evidence: bound
  addons/twelve-factor/rules:
    twelve-factor-evidence: bound
  frameworks/sdlc-complete/rules:
    actionable-feedback: bound
    agent-fallback: bound
    agent-friendly-code: paths
    agent-generation-guardrails: paths
    artifact-discovery: summary
    citation-policy: kernel
    executable-feedback: bound
    failure-mitigation: bound
    hitl-gates: bound
    lfd-control-tiers: bound
    no-attribution: kernel
    provenance-tracking: bound
    reproducibility-validation: bound
    research-metadata: bound
    tao-loop: bound
    token-security: kernel
    versioning: paths
behaviors:
  source_roots:
    common: behaviors
    sdlc: frameworks/sdlc-complete/behaviors
    fleet: addons/aiwg-fleet/behaviors
  entries:
    concierge: {source: common, activation: bound, bound_to: {agents: [concierge]}}
    test-watcher: {source: common, activation: bound, bound_to: {agents: [test-engineer]}}
    build-monitor: {source: common, activation: bound, bound_to: {agents: [build-engineer]}}
    security-sentinel: {source: common, activation: bound, bound_to: {agents: [security-auditor]}}
    artifact-sync: {source: sdlc, activation: bound, bound_to: {agents: [context-librarian], skills: [build-artifact-index]}}
    quality-gate-watcher: {source: sdlc, activation: bound, bound_to: {agents: [quality-assessor, security-gatekeeper]}}
    quiet-bot: {source: fleet, activation: bound, bound_to: {agents: [fleet-quiet-bot]}, target_status: author-in-3222}
    quiet-business-bot: {source: fleet, activation: bound, bound_to: {agents: [fleet-business-bot]}, target_status: author-in-3222}
budget_demoted:
  addons/aiwg-utils/rules:
    auto-compact-continue: summary
    cli-secondary: summary
    debug-source-not-output: paths
    delivery-policy: summary
    subagent-scoping: summary
  frameworks/sdlc-complete/rules:
    anti-laziness: summary
epic_rule_outside_profile:
  addons/decision-engine/rules:
    decision-offload: bound
```
