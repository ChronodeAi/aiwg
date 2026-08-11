# PMOS AIWG addon

This is the project-local, promotion-ready AIWG packaging of PMOS 2.6.0. It keeps the original PMOS implementation as the authority while arranging it into AIWG artifact directories and self-contained runtime resources.

## Inventory

- Source skills: 230
- Addon kernel skills: 1 (`pm-os-quickref`)
- Packaged `SKILL.md` files: 231
- Agents: 12
- Skill-backed invocation surfaces: 26 (15 core and 11 workflows)
- Runtime rules: 1
- Hook scripts: 3, with the provider hook source in `hooks/hooks.json`
- MCP server definitions: 6 in `.mcp.json`

The canonical invocation surfaces remain PMOS skills. `registry/commands.json` is their auditable interface registry, including `skill-browser` as the fifteenth core surface; `commands/` contains the exact 26 thin Codex adapters derived from that registry.

## Layout

```text
pm-os/
├── manifest.json
├── skills/             # 230 PMOS skills + one AIWG kernel quickref
├── agents/             # 12 PMOS agents
├── commands/           # 26 deterministic, PMOS-namespaced Codex adapters
├── rules/              # addon runtime and safety rule
├── hooks/              # three scripts plus Claude hook configuration
├── registry/           # capability, skill, workflow, command, and agent registries
├── references/         # shared PMOS references
├── knowledge/          # PM frameworks, interview prompts, metrics, and resources
├── templates/          # PRD and planning templates
├── examples/           # example PM artifacts
├── bin/                # PMOS runtime and maintenance scripts
├── docs/               # provider, memory, MCP, and upgrade guidance
├── CLAUDE.md           # Claude plugin runtime instructions
├── runtime/CLAUDE.md   # provider-neutral retained runtime copy
├── tools/              # fail-closed, addon-root-aware Codex deploy shims
├── .claude-plugin/     # original Claude plugin metadata
└── .mcp.json           # six optional MCP server definitions
```

Runtime references inside copied skills, agents, registries, and provider instructions are normalized to these addon-local subtrees. Original installation and upgrade documents may still describe the standalone repository layout. Skill-owned assets, references, and scripts remain next to their `SKILL.md` files.

## AIWG lifecycle

Run from the PMOS project root:

```bash
aiwg list --project-local
aiwg doctor --project-local
aiwg use pm-os --provider claude --dry-run --verbose
aiwg use pm-os --provider codex --dry-run --verbose
aiwg promote pm-os --dry-run
```

After reviewing the dry run, deploy with `aiwg use pm-os --provider <provider>` or promote into the AIWG fork with `aiwg promote pm-os`.

Use local-index discovery in this fork:

```bash
aiwg discover "PMOS product strategy" --backend local --limit 5
aiwg show skill strategy --backend local
```

## Provider status

Claude is declared `full`: the bundle preserves Claude skill, agent, hook, plugin, and MCP source conventions. Hook activation and MCP authentication remain explicit operator steps.

Codex is declared `full` for the bounded PMOS surface. The validated project-local dry run resolved all 26 PMOS command adapters into `.codex/commands/`, the single `pm-os-quickref` kernel skill into `.agents/skills/`, 12 agents, and the runtime rule, with `pruned=0`. The other 230 PMOS skills remain index-discoverable in the addon instead of being injected into Codex's startup skill budget.

The two bundle-local Codex shims resolve the project root only from a validated `<project>/.aiwg/addons/pm-os` source, require exact nonzero source counts, preflight every owned destination before writing, and never prune. They preserve all non-PMOS commands and skills and fail nonzero on unsafe targets, unowned collisions, stale managed artifacts, or count drift. Dry-run mode is strictly read-only. Test them with `node --test tools/tests/codex-helper-shims.test.mjs`.

The `additionalFiles` manifest list records resources that promotion must retain; it does not claim those resources are copied into every provider's deployment directory.
