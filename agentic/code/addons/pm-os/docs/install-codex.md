# Install PMOS for OpenAI Codex and ChatGPT Desktop

PMOS for Codex is developed as an AIWG addon. The complete 230-skill library stays in the addon/index; Codex loads one small PMOS quickref and provider-native adapters for commands, agents, and hooks.

## Requirements

- OpenAI Codex CLI, IDE extension, or ChatGPT desktop app with Codex support
- Python 3 and Bash
- AIWG installed from the intended fork
- a trusted project directory

ChatGPT desktop, Codex CLI, and the IDE extension share the same local Codex MCP configuration. ChatGPT on the web does not read local `.codex/config.toml`; a separately packaged OpenAI plugin is a future distribution option.

## Install in this development workspace

Run from the repository root:

```bash
aiwg status
aiwg list --project-local
aiwg index build

# Preview only. Inspect the output; a zero-artifact "success" is a failure.
aiwg use pm-os --provider codex --dry-run --verbose

# Deploy the bounded Codex surface from the self-contained addon helpers.
aiwg use pm-os --provider codex --verbose

# Acceptance evidence.
python3 bin/generate-codex-adapters.py --check
bash bin/validate-codex-parity.sh
aiwg doctor --project-local
```

The addon helpers fail closed on missing sources, count mismatches, path escapes,
collisions, symlinks, or a zero-artifact plan. They deploy exactly 26 PMOS
command adapters and the one `pm-os-quickref` kernel skill, never prune unrelated
Codex artifacts, and keep the other 230 PMOS skills available through AIWG's
index. The repository generator is the development source for those adapters;
`--check` proves the committed views are current without writing.

## Reload and trust

After installation or changes:

1. Restart/reload the Codex session so skills and custom agents are re-discovered.
2. In the Codex TUI, run `/hooks`, review the PMOS commands, and trust them if the paths and hashes match this repository.
3. Run `/mcp` to inspect configured MCP servers.
4. Ask: `Use PMOS to show my current product-management status.`

Codex requires explicit trust for changed non-managed hooks. Until trusted, reminder and save-guard hooks are skipped.

## PMOS entry points

- Natural language: `Use PMOS to run the strategy workflow.`
- Kernel skill: mention `$pm-os-quickref` or choose it from `/skills`.
- Command compatibility views: PMOS-namespaced files under `.codex/commands/`.
- Agents: 12 project agents under `.codex/agents/`, generated from the PMOS registry.

The 230 standard skills are not all placed in Codex's startup list. The router uses:

```bash
aiwg discover "<product-management need>" --backend local
aiwg show skill <name> --backend local --first
```

## Optional MCP integrations

PMOS catalogs six integrations: Lenny Podcast, Notion, Linear, Atlassian, GitHub, and Perplexity. They are not enabled automatically because most require OAuth or credentials.

Review `.codex/pm-os-mcp.example.toml`, then copy only the servers you want into the trusted project's `.codex/config.toml` or add them in ChatGPT desktop Settings → MCP servers. Authenticate HTTP servers separately (`codex mcp login <name>` where supported). For Perplexity, set `PERPLEXITY_API_KEY` in the environment; never write the secret into version control.

## Verification contract

A valid local installation has:

- 230 PMOS source skills plus one addon-only kernel quickref;
- 26 invocation adapters (15 system + 11 workflows);
- 12 valid Codex agent TOMLs;
- one Codex hook file covering tidy, daily-drip, and save guard;
- zero generated dependencies on Claude-only question tools, plugin roots, or `/pm-os:` namespaces.

Do not accept `aiwg use` exit code alone as proof. A valid dry-run reports 26
commands, one quickref, and zero pruned artifacts; the parity validator enforces
those counts.

## Upgrade

Use the AIWG lifecycle described in `skills/pm-os-upgrade/SKILL.md`. Do not run the legacy ZIP merger on a Codex/AIWG workspace. Preserve `📂 Context/`, `.aiwg/`, operator content in `WORKSPACE.md`, custom addons, and non-PMOS provider files.
