# Harness specs — how agents work in OpenAI Codex, Claude Code, Cursor, and Cowork

Distilled from live-docs research (mid-2026). Read only the section for the target harness. Where a fact is version-dependent or unconfirmed, it says so — don't assert past the evidence.

**Re-verify before writing.** These provider schemas are versioned and can drift. Confirm current fields against live official docs before Step 6; live docs win over this reference.

Codex, Claude Code, and Cursor are file-based but use different schemas. Cowork has no loose-agent authoring — an agent ships only inside a plugin the user uploads.

---

## OpenAI Codex / ChatGPT desktop

**Agent file homes:**

| Path | Scope | Upgrade-safe? |
|---|---|---|
| `.codex/agents/*.toml` | project | AIWG/PMOS may manage namespaced files here |
| `~/.codex/agents/*.toml` | personal, all projects | **Yes — default for a user's custom agent** |

Every standalone TOML file requires `name`, `description`, and `developer_instructions`:

```toml
name = "Research Reviewer"
description = "Use for read-only product-research critique and evidence gaps"
developer_instructions = """
One job, boundaries, process, and structured output contract.
"""
sandbox_mode = "read-only"          # optional; inherits when omitted
model_reasoning_effort = "medium"    # optional; inherit by default
```

Omit `model` unless the user has chosen a currently available Codex model. Other session settings, MCP servers, skills configuration, sandbox, and approval policy inherit from the parent when omitted.

**MCP:** declare servers in the active Codex `config.toml` layer or an enabled plugin. Never embed credentials in the agent file; verify authentication separately.

**Invocation:** Codex may delegate by description from natural language. The CLI/desktop agent panel can inspect and steer active agent threads. The parent owns user interaction, approval handling, and synthesis.

**Upgrade-safe default for this skill:** `~/.codex/agents/<name>.toml`. Use `.codex/agents/` only when the user explicitly wants a version-controlled, project-scoped agent and understands that AIWG/provider generation owns that surface.

---

## Claude Code

**Agent file homes** (highest priority first):
| Path | Scope | Upgrade-safe? |
|---|---|---|
| `.claude/agents/*.md` | project (walks up from cwd) | No — inside the workspace |
| `~/.claude/agents/*.md` | user, all projects | **Yes — outside the workspace, `/upgrade` can't reach it. DEFAULT.** |
| `plugins/*/agents/*.md` | plugin (`plugin:agent-name`) | Only if it's a *custom* plugin (not `pm-os`) |

Discovered natively; directories scanned recursively (subfolders don't affect identity — only the `name` field does). File-watcher picks up changes within seconds; only creating the *first* agent in a brand-new `agents/` dir needs a restart.

**Frontmatter** (required: `name`, `description`; rest optional):
```yaml
---
name: unique-lowercase-id          # required
description: When to delegate here. # required — drives auto-delegation
tools: Read, Grep, Bash            # allow-list; omit = inherit ALL
disallowedTools: Edit, Write       # deny-list (applied before allow-list)
model: inherit | sonnet | opus | haiku | fable   # default: inherit
effort: low | medium | high | xhigh | max        # reasoning effort
readonly: true                     # convention in this repo's reviewer agents
color: blue | green | ...           # picker tint
---
System prompt in Markdown. Becomes the agent's whole system prompt.
Receives: this body + task message + CLAUDE.md + git status. NOT the conversation history.
```

**MCP:** reference as `mcp__servername` or `mcp__servername__tool`; `mcp__*` = all MCP. Plugin `.mcp.json` auto-registers on plugin enable. For an agent in `~/.claude/agents/`, the MCP server must already be configured in the user's settings.

**Invocation:** natural language (Claude decides), `@agent-name` (guaranteed), or `--agent name` / `agent:` in settings (session-wide).

**Delegation gotcha:** the `description` is what makes Claude auto-delegate. Write it with trigger phrasing ("Use proactively after…", "When handling…"). Vague description → never fires.

**Hard limit:** subagents **cannot** call `AskUserQuestion`, `EnterPlanMode`, `ScheduleWakeup`. An agent that needs to interview the user is the wrong tool — make that a skill instead.

**Upgrade-safe default for this skill:** `~/.claude/agents/<name>.md`. Offer a custom workspace plugin (`plugins/<user-plugin>/agents/`) only if the user wants the agent version-controlled with the workspace and shared — that dir survives `/upgrade` because it isn't a system plugin.

---

## Cursor

**Agent file home:** `.cursor/agents/*.md` (project-level). Custom *Modes* were removed in v2.1 — don't target them; subagents are the current primitive (v2.4+).

**Frontmatter:**
```yaml
---
name: agent-name           # required
description: when to use   # required
model: ...                 # per-agent model (shipped v2.4)
readonly: true | false
is_background: true | false
---
System prompt body.
```

**MCP:** Cursor reads `.cursor/mcp.json`. An agent references MCP tools the same way once the server is declared there.

**Adjacent primitives:** Skills live in `.cursor/skills/*/SKILL.md` (Cursor 2.4+; `disable-model-invocation: true` makes a skill fire only on explicit `/name`). Prefer a subagent for autonomous sub-tasks; a skill for a reusable procedure.

**Upgrade note:** PM OS's Cursor distribution is a re-downloaded ZIP; generated pm-os agents land in `.cursor/agents/` too. A user's own agent there is *usually* safe (the ZIP overwrites named system files), but there's no hard guarantee like Claude Code's `~/.claude/`. Tell the user to keep a copy, or prefix their agent name distinctly so it won't collide with a system file.

---

## Cowork

**The critical fact:** there is **no standalone "create a subagent" facility**. An agent exists only as a file bundled inside a **plugin** the user uploads. And Anthropic's own authoring guidance flags agents as *"uncommonly used in Cowork"* and steers authors to **Skills first** — skills run everywhere (plain Claude chat, Desktop, Cowork), agents/hooks are Cowork-only and grayed out in chat.

**So for Cowork, default to producing a Skill, not an agent** — unless the user genuinely needs an autonomous multi-step sub-task that only runs in Cowork.

**Plugin layout** (component dirs at plugin root, kebab-case, only create dirs you use):
```
plugin-name/
├── .claude-plugin/plugin.json   # REQUIRED manifest — min field: "name"
├── skills/skill-name/SKILL.md    # primary unit
├── agents/*.md                   # optional, Cowork-only, uncommon
├── .mcp.json                     # MCP defs
└── README.md
```
Use `${CLAUDE_PLUGIN_ROOT}` for intra-plugin paths; never hardcode absolutes.

**Agent frontmatter** (from Anthropic's `component-schemas.md`): required `name` (kebab, 3–50 chars), `description` (with `<example>` blocks showing triggers), `model` (`inherit`|`sonnet`|`opus`|`haiku`), `color`; optional `tools`. Body is the system prompt.

**Delivery (not a scanned dir):** package the plugin folder as a `.plugin` file (`zip -r name.plugin .`) → it appears in Cowork chat as a preview the user accepts, or upload a single skill via **Customize → Skills**. There is no local directory Cowork auto-scans.

**MCP:** declared in `.mcp.json`, but **auto-register-on-enable is NOT confirmed for Cowork** (it's confirmed for Claude Code only). Cowork routes external tools through **Connectors** the user adds manually (Customize → Connectors, URL + OAuth). Always tell a Cowork user their MCP/connector is a separate enable step.

**Upgrade-safe by separation:** the user's agent lives in *their own* plugin, distinct from the `pm-os` plugin. Re-uploading a new pm-os version never touches a different plugin. So: put the user's agent in a standalone plugin named for them (e.g. `george-agents`), not inside pm-os.

**Namespace note:** Cowork's `/` menu groups skills per plugin. A `plugin-name:` prefix disambiguates; the observed behavior is a grouped list, but explicit namespace-stripping in the dropdown is directionally-supported, not verbatim-confirmed. A distinctive skill/agent name is the safe hedge.
