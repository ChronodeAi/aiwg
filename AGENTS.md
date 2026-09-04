# AGENTS.md
<!-- aiwg-managed -->
Operator additions: edit `AGENTS.override.md` (loaded after this file by Hermes).

<!-- AIWG:provider-bootstrap:start -->

# Provider workspace bootstrap

Read and follow [WORKSPACE.md](./WORKSPACE.md) first.
Then read [AIWG.md](./AIWG.md) for AIWG discovery, quickrefs, and framework routing.

These are explicit reading instructions. Plain Markdown links are not claimed to auto-load.

<!-- AIWG:provider-bootstrap:end -->

## Framework Context

See [AIWG.md](./AIWG.md) for the full AIWG framework context
(active frameworks, addons, agents, behaviors, rules).
Tracker and delivery source of truth: [.aiwg/aiwg.config](.aiwg/aiwg.config).

Deployed artifacts live under your provider's native directory
(for example `.codex/agents/`, `.warp/agents/`, `.github/agents/`).
Use `aiwg discover "<intent>"` and `aiwg show <type> <name>` to browse
skills, agents, rules, and commands across the installation.

## CRITICAL Rules (always apply)

These are the highest-enforcement AIWG rules. Full bodies are reachable without
MCP:
- Find rules: `aiwg discover "rule <topic>" --type rule`
- Fetch a rule: `aiwg show rule <name>`

If the optional MCP sidecar is configured, the same surface is available through
`mcp_aiwg_rule_list` and `mcp_aiwg_rule_show`.

### Rule: skill-discovery (discover-first protocol)
Before declining a user request as "outside AIWG's scope" or improvising a
workflow from training data, you MUST run `aiwg discover "<user need>"`
against the user's need. Most AIWG skills are not in your context; they reach
you through `aiwg discover` + `aiwg show <type> <name>`. If MCP is available,
`mcp_aiwg_discover` and type-specific show tools are equivalent. Run discover
whenever the user mentions AIWG, a framework name (sdlc, research, forensics,
ops, marketing, security-engineering, media-curator, knowledge-base), or
capability keywords (skill, agent, command, rule, workflow).

### Rule: no-attribution
Never add AI-tool attribution to commits, PRs, code, or docs. No `Co-Authored-By:`,
no "Generated with", no "Written by [AI tool]". The AI is a tool; tools don't sign
their output. Applies to ALL platforms (Claude, Codex, Copilot, Cursor, etc.).

### Rule: anti-laziness
Never delete tests to make them pass. Never skip/disable tests. Never remove
features instead of fixing them. Never weaken assertions to be meaningless.
Never suppress CI/pipeline signals (`continue-on-error`, `|| true`, `set +e`).
If stuck after 3 honest attempts: escalate with full context, don't shortcut.
Within scope: leave nothing half-done — code + tests + docs + verification.

### Rule: citation-policy
Never fabricate citations, DOIs, URLs, or page numbers. Only cite sources that
exist in the research corpus (.aiwg/research/sources/). Match claim strength
to evidence quality (GRADE): HIGH = "demonstrates"; MODERATE = "suggests";
LOW = "limited evidence"; VERY LOW = "anecdotal". Document research gaps in
.aiwg/research/TODO.md when no source supports a claim.

### Rule: token-security
Never hard-code tokens, API keys, or secrets in source files or commit messages.
Never pass tokens as CLI arguments (visible in process list). Never echo or log
token values. Load from secure files (mode 600) or environment variables. Use
heredoc scope for multi-step operations so tokens don't persist beyond use.
Token files must NEVER be tracked in git (.gitignore enforced).

### Rule: versioning
CalVer format: `YYYY.M.PATCH` (e.g., `2026.5.3`). NEVER use leading zeros
(`2026.01.5` is broken — npm semver rejects it). Tags use `v` prefix.
CHANGELOG must use same format. PATCH resets each month.

### Rule: ops-safety
Detect interactive commands and flag for human execution (passwords, LUKS
passphrases, MFA — agents cannot type these). Gate destructive operations
(`rm -rf`, `fdisk`, `mkfs`, partition table changes) behind explicit
human confirmation. Assess blast radius before execution (CRITICAL = multi-host
/ data loss; HIGH = single-host outage). Dry-run first when the tool supports it.
Never cross host boundaries without confirmation.

## Hermes Subagents (0.21+)

Use `delegate_task(goal="...", context="...", output_schema={...})` for AIWG workflows.
Hermes 0.21+ subagents embed the workspace's project context files (this
AGENTS.md) as binding conventions automatically — do not re-inline rules.
They still cannot call clarify/memory/cronjob/send_message: inline the AIWG
persona body and task specifics in `context`, and validate child returns
with `output_schema`.

---

*See `AGENTS.override.md` for operator-authored additions.*
