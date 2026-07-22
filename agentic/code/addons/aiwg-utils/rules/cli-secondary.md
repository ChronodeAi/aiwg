---
enforcement: high
---

# Use Local or Discovered Skill Over Raw CLI

**Enforcement Level**: HIGH
**Scope**: All agents on AIWG-managed projects
**Addon**: aiwg-utils (core, universal)
**Issue**: #1272; #1480

## Overview

AIWG is **agentic-first**. Skills/agents carry the priming (rules, gates, preservation logic, recovery); the CLI sits *underneath* as the imperative tool the skill calls. Raw CLI commands augment skill workflows; they do not replace skills. The skill is the driver and owns orchestration, formatting, synthesis, gates, and recovery.

## The Hierarchy

Preferred path for any action, strict priority order (P1→P4):

| Priority | Surface | When |
|---|---|---|
| **1. Local skill or agent** | Already loaded in your context (kernel skills, framework quickrefs, deployed agents) | Always check here first — these are free to invoke |
| **2. Discovered skill or agent** | Reachable via `aiwg discover "<need>"` + `aiwg show <type> <name>` | When no local skill matches; query the index before improvising or falling to the CLI |
| **3. Raw CLI command** | Imperative invocation of `aiwg <command>` | Only when no skill exists, OR you are on the discovery surface, OR you are inside a skill that is calling the CLI as its implementation step |
| **4. Manual file operations** | Direct edits without going through skill or CLI | Last resort — bypasses both priming AND registry update logic |

Reaching for raw CLI for an *action* (mutation, deploy, scaffold, regenerate)? First ask "is there a skill — locally or via `aiwg discover`?" If yes, route through it. **Sole exception**: discovery/finder commands (Rule 2) are the priming entry points — primary and direct-callable; they bridge P2 to P1.

## Mandatory Rules

### Rule 1: Local Skill First, Then Discovered Skill, Then CLI

Walk **local skill → discovered skill → raw CLI** in order; never jump to CLI. (1) Check context — kernel skills (`use`, `aiwg-doctor`, `aiwg-refresh`, `aiwg-regenerate`, `aiwg-status`, `steward`), framework quickrefs, deployed agents (`aiwg-steward`, `aiwg-finder`). (2) No local match → `aiwg discover "<need>"` (~385 of 400 skills are out of context but one query away). (3) Fall to raw CLI only per Rule 7. The skill carries the priming; the CLI alone does not.

**Example** — "refresh AIWG": **FORBIDDEN** = run `aiwg refresh` directly (skips preservation logic, doctor pre-check, provider verification). **REQUIRED** = invoke the `aiwg-refresh` skill, which loads that priming then calls `aiwg refresh` with the right flags.

### Rule 2: Discovery Commands Stay Primary

These are the priming entry points and MUST remain direct-callable (read-only / list-only). They have NO paired skill — they ARE the priming:

| Command | Purpose |
|---|---|
| `aiwg discover` | Capability search across skills, agents, commands, rules |
| `aiwg show` | Fetch the body of a discovered artifact |
| `aiwg list` | List installed frameworks and addons |
| `aiwg catalog` | Search/list marketplace packages |
| `aiwg features` | List capability features |
| `aiwg help` | CLI command reference |
| `aiwg status` | Workspace health snapshot |
| `aiwg version` | Version + channel info |
| `aiwg runtime-info` | Provider + environment detection |
| `aiwg agentcard` | List installed agent capability cards |
| `aiwg-doctor` (read-only) | Health check without repair |
| `aiwg ralph-status`, `mc status`, `cost-report`, `metrics-tokens` | Read-only status |
| `aiwg index query/deps/stats`, `packages list/info`, `storage show/list-backends` | Discovery within a multi-subcommand surface |

### Rule 3: Mixed Subcommands — Classify Per Subcommand

Commands carrying both discovery and action subcommands — classify per subcommand:

| Command | Discovery subcommands | Action subcommands (skill-first) |
|---|---|---|
| `aiwg index` | `query`, `deps`, `stats` | `build` |
| `aiwg packages` | `list`, `info` | `remove`, `install` |
| `aiwg ops` | `status`, `list` | `init`, `adopt`, `discover --register`, `push` |
| `aiwg storage` | `show`, `list-backends`, `test` | `migrate` |
| `aiwg activity-log` | `show`, `stats` | `append`, `rotate` |
| `aiwg memory`/`reflections`/`kb`/`provenance`/`research-store` | `path`, `list`, `get` | `put`, `delete`, `append-log` |

### Rule 4: Action Commands — Always Prefer Skill

The following CLI commands have paired skills/agents. When the user's intent maps to one of these, invoke the skill — not the raw CLI. Legacy provider slash commands and prompts are aliases into this same skill-first surface, not a separate preferred entry point.

| CLI command | Paired skill/agent | Why the skill matters |
|---|---|---|
| `aiwg use <framework>` | `use` skill | Deployment validation, conflict resolution, registry update gates |
| `aiwg refresh` | `aiwg-refresh` skill | Pre-flight doctor check, dry-run preview, provider verification |
| `aiwg regenerate` | `aiwg-regenerate` skill | Preserves team directives, AGENTS.md link integrity, AIWG.md pipeline |
| `aiwg doctor` (repair mode) | `aiwg-doctor` skill | Diagnoses *and* invokes correct remediation skill per failure class |
| `aiwg init` | `intake-start` / project-init skills | Solution profile validation, intake gate |
| `aiwg new my-project` | `new-project` skill / intake-wizard | Scaffold + intake guidance |
| `aiwg promote` | promote skill | Hash verification, source preservation invariant |
| `aiwg remove` | use/remove skill | Reverts cleanly without orphaning |
| `aiwg add-agent` / legacy `add-command` / `add-skill` / `add-behavior` / `add-template` | AgentSmith / CommandSmith / SkillSmith / template-engine | Scaffold validation, metadata pre-fill, deployment wiring |
| `aiwg scaffold-{addon,extension,framework}` | scaffold skills | Manifest validation, naming conventions, deployment path |
| `aiwg ralph` | `ralph` skill | Completion-criteria validation, recovery protocol, anti-laziness gates |
| `aiwg mc start/dispatch` | `mission-control` skill | Concurrency budget, supervisor wiring |
| `aiwg doc-sync` | `doc-sync` skill | Drift assessment, interactive reconciliation |
| `aiwg lint` / `aiwg cleanup-audit` / `aiwg best-practices-audit` | lint / audit skills | Threshold config, false-positive handling |
| `aiwg sdlc-accelerate` | `sdlc-accelerate` skill | Phase-gate orchestration, multi-agent dispatch |
| `aiwg execution-mode` / `snapshot` / `checkpoint` / `reproducibility-validate` | reproducibility skills | Mode-appropriate priming |
| `aiwg steward` | `steward` agent | Provider-aware routing, fallback logic |
| `aiwg index build` | the index-refresh patterns in `post-commit-index-refresh` rule | Targeted-graph rebuild, incremental mode |
| `aiwg ops <action>` (init, adopt, push) | ops framework skills | Workspace context, multi-repo discipline |
| `aiwg storage migrate` | storage skills | Per-subsystem migration, backend validation |

### Rule 5: CLI Augments; Skill Drives

For paired action surfaces, raw CLI examples are implementation affordances only. They show what the skill may call, or what an explicit human operator may type, but they MUST NOT be documented as replacing the skill workflow.

The skill is responsible for:

- interpreting user intent and selecting the correct workflow path
- running pre-flight checks, dry runs, preservation logic, and authorization gates
- calling raw CLI commands as bounded execution steps when useful
- synthesizing results from commands, files, agents, and validation output
- producing final formatting, presentation, and user-facing conclusions
- recording state, reports, and recovery guidance

The CLI is responsible for narrow imperative execution. It should return structured facts, perform bounded mutations, or expose status that the skill can use. It should not be treated as the presentation layer for agent work.

Documentation MAY keep CLI examples, but paired action examples must be framed as one of:

1. a step the skill calls internally,
2. an explicit raw CLI invocation typed by the user, or
3. a diagnostic/status command from the discovery surface.

If docs imply `aiwg <action>` is the agent's preferred path while a paired skill exists, file/fix drift under #1480.

### Rule 6: Skill Documentation Must Say So

Every skill with a paired CLI command MUST carry a one-line note: *"Prefer invoking this skill over running `aiwg <command>` directly. The skill carries the priming this CLI command needs."* Every CLI reference doc (e.g. `docs/cli-reference.md`) MUST, for paired commands, link the skill: *"Agents: invoke via the `[skill-name]` skill rather than calling this CLI directly. See `aiwg show skill <name>`."*

### Rule 7: When Raw CLI Is Acceptable

The agent may invoke the CLI directly without going through a paired skill ONLY when:

1. The user explicitly typed the raw CLI invocation (`"run aiwg refresh"`, not `"refresh AIWG"`)
2. No paired skill exists for the command
3. The command is on the discovery surface (Rule 2)
4. The agent is inside a paired skill, and that skill is calling the CLI as its imperative step
5. The CLI is being used in a documented diagnostic-only mode (e.g. `aiwg doctor` for read-only health check, with no repair)

## Detection Heuristics

You may be in violation of this rule if:

| Symptom | Likely cause |
|---|---|
| Agent ran `aiwg refresh` without first checking `aiwg refresh --dry-run` | Skipped the refresh skill's priming |
| Agent ran `aiwg regenerate` and overwrote team directives | Skipped the regenerate skill's preservation logic |
| Agent ran `aiwg use` and the workspace ended up in a half-deployed state | Skipped the use skill's verification gates |
| Agent ran `aiwg ralph` without a measurable `--completion` argument | Skipped the ralph skill's completion-criteria validation |
| Agent invoked CLI on a paired command without naming the skill that wraps it | Treated CLI as primary surface |

## Recovery

About to invoke a paired CLI command directly? STOP → `aiwg discover "<purpose>"` → `aiwg show skill <name>` → invoke the skill. If the paired skill genuinely doesn't exist (rare), file an issue to add the pairing.

## Interaction with Other Rules

Layers with `skill-discovery` (discovery is the encoded exception), `self-maintenance` (skills-first routing), `research-before-decision` (the skill IS the priming research), and `human-authorization` (gates live in the skill — bypassing it bypasses the gate). Universal across all AIWG providers.

## Checklist

Before invoking any CLI command, walk the hierarchy in order:

- [ ] Priority 1: Is there a **local skill** in my context (kernel skill, framework quickref entry, deployed agent) that does this? If yes, invoke it.
- [ ] Priority 2: If no local skill, run `aiwg discover "<need>"`. Did discovery return a paired skill? If yes, fetch it with `aiwg show` and invoke it.
- [ ] Priority 3: Only after priorities 1 and 2 are exhausted, consider running the CLI directly. Verify one of these holds:
  - This is a discovery/finder command (Rule 2 table)
  - This is a mixed command and I'm using a discovery subcommand (Rule 3)
  - No paired skill exists (Rule 4 table doesn't list one; discover returns no results)
  - I'm inside a paired skill that is calling the CLI as its step
  - The user explicitly typed the raw CLI invocation

If priority 1 or 2 has a match and I'm still reaching for the CLI — stop and route through the skill.

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/skill-discovery.md — Discovery-first protocol
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/self-maintenance.md — Self-maintenance routing (skill-first)
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/aiwg-utils-quickref/SKILL.md — Kernel quickref
- Issue #1272 — Origin of this rule

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-25
