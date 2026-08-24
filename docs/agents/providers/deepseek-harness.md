---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.dsh
---

# DeepSeek Harness Operational Reference

> **First time using AIWG?** Begin with [Install, Connect, and Verify](https://docs.aiwg.io/pages/getting-started--install-connect-verify.html). This guide assumes AIWG is already installed, `all` is deployed for your provider, and `aiwg-regenerate` has connected the agent to this project.

Integrate AIWG with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — a skills-only file deployment plus an **AGENTS.md** context bridge.

DeepSeek Harness is a plugin-based agent harness built on the Cordis kernel ("everything is a plugin", currently in developer preview). It natively discovers `SKILL.md` directory bundles from project `.agents/skills/` and user `$DSH_AGENTS_HOME|~/.agents/skills/` (its `skill-filesystem` provider), and loads workspace `AGENTS.md` prose into the system prompt. Those are exactly the surfaces AIWG deploys — no adapter layer is required for skills or context.

> **DeepSeek Harness integrates like Codex/OpenCode: shared `.agents/skills/` canonical path, AGENTS.md context, discover-first CLI.** Agents are *not* deployed as markdown directories because DSH subagents are cordis.yml plugin compositions; dispatch AIWG personas through skills instead. Rules surface through the generated `AGENTS.md` sections and `aiwg show rule <name>`.

---

## Architecture

```
[dsh web UI / CLI / ACP automation]
                │
                ▼
      DeepSeek Harness (host)
        ├── Cordis kernel: every capability is a plugin (cordis.yml presets)
        ├── Skill catalog ← .agents/skills/ (project) + ~/.agents/skills/ (user)
        ├── Context ← workspace AGENTS.md (prose-directive)
        ├── Native MCP client (@deepseek-ai/dsh-mcp-client)  [optional seam]
        └── Session log: append-only, replay/fork/search
                │
                ▼
        AIWG (CLI + corpus at $AIWG_ROOT)
          ├── Deployed skills (.agents/skills/)
          ├── aiwg discover / aiwg show for the long tail (~460 skills)
          └── .aiwg/ artifacts, workflows, templates
```

**DeepSeek Harness owns**: the agent loop, session log, tool execution, sandboxing, subagent/workflow orchestration, skill loading, model wiring (cordis.yml llm plugins).

**AIWG owns**: workflow content, SDLC/marketing/etc. skill bodies, agent personas (dispatched as skills), artifact output in `.aiwg/`, templates.

**The seams are the skill directory and AGENTS.md.** Coexistence with clear boundaries — not system unification. DSH does not need to know how AIWG produced a skill body; AIWG does not need to know how DSH schedules or sandboxes a run.

### Recommended Model Strategy

DSH wires models per preset through cordis.yml llm plugins — one model per session composition, shared by every agent in it.

| Role | Model | Notes |
|---|---|---|
| Coding + general | `deepseek-chat` | Default V3-class chat model |
| Reasoning-heavy | `deepseek-reasoner` | Swap the llm plugin's `model` field |
| Any OpenAI-compatible endpoint | custom id | Set `DEEPSEEK_BASE_URL` / plugin config |

Model selection is global to the session (no per-agent pins); an unavailable configured model fails loud at load.

---

## Install & Deploy

**1. Install DeepSeek Harness**

```bash
# Quick start from npm (starts Web UI at http://127.0.0.1:3080)
npx @deepseek-ai/dsh web

# Or from source
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness && pnpm install && pnpm run build && pnpm dsh web
```

**2. Install AIWG**

```bash
npm install -g aiwg
```

**3. Deploy to your project**

```bash
cd /path/to/your/project
aiwg use all --provider dsh
```

Or deploy once for every project on the machine (skills land in `~/.agents/skills/`, which DSH scans at user level):

```bash
aiwg use all --provider dsh --global
```

**4. Connect the context**

Run `aiwg regenerate --provider dsh` inside a DSH session in the project (or invoke the `aiwg-regenerate` skill). This generates/refreshes the managed AIWG section in the workspace `AGENTS.md`. Reopen the session so the harness reloads its system prompt.

**5. You're ready.** Run `dsh` in the project; the AIWG skills appear in the `<available_skills>` catalog and every other AIWG capability resolves through the CLI.

---

## What Gets Created

Project-scope deploy (`aiwg use all --provider dsh`):

```text
.agents/skills/     # Canonical kernel/quickref skill inventory (flat, natively scanned)
.dsh/.aiwg/skills/  # Bulk framework/addon payload (index-discoverable via aiwg discover/show;
                    #   deliberately NOT flat-scanned — keeps the session catalog lean)
AGENTS.md           # Managed AIWG context section (via aiwg-regenerate)
.aiwg/              # SDLC artifacts (use cases, ADRs, work breakdowns, ...)
```

User-scope deploy (`--scope user` mirrors to, `--global` targets directly):

```text
~/.agents/skills/   # Kernel surface at user level; scanned by every DSH session
```

Set `DSH_AGENTS_HOME` when your DSH install uses a non-default agents home; AIWG resolves user-scope paths through the same variable.

---

## Capability Details

| AIWG Artifact | Path | How DeepSeek Harness Uses It |
|---------------|------|------------------------------|
| Skills | `.agents/skills/` (project), `~/.agents/skills/` (user) | Natively discovered `SKILL.md` bundles; appear in the `<available_skills>` catalog with model/user invocation flags honored |
| Agent personas | Not deployed | DSH subagents are plugin compositions; dispatch AIWG personas by invoking their skill, or `aiwg run skill <name>` |
| Commands | Not deployed | No separate command surface; user-invocable skills serve as commands |
| Rules | `AGENTS.md` sections | Generated `### Rule:` blocks; fetch full rule bodies with `aiwg show rule <name>` |
| Project context | `AGENTS.md` | Loaded verbatim into the system prompt (prose-directive; no include syntax) |
| Framework artifacts | `.aiwg/` | Read/written by skills through ordinary file tools |

### Optional enrichment: MCP

DSH ships a first-class MCP client plugin (`@deepseek-ai/dsh-mcp-client`). Point one instance at AIWG's MCP server for tool-level access beyond skills:

```yaml
# cordis.yml
plugins:
  - id: aiwg-mcp
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: aiwg
      transport: stdio
      command: npx
      args: ['aiwg', 'mcp', 'serve']
```

Inspect the server surface first with `aiwg mcp info`. This seam is optional — the skill deployment above already covers framework workflows without MCP.

---

## Verification

```bash
# From the project root:
aiwg status                          # shows installed frameworks + deployment inventory
aiwg doctor --provider dsh           # health check incl. user-scope registry when deployed
ls .agents/skills | head             # deployed skill bundles present

# Inside a DSH session:
# - the available-skills catalog lists the deployed AIWG skills
# - ask the agent: aiwg discover "<capability>" then aiwg show <type> <name>
```

## Diagnostics & Recovery

| Symptom | Cause | Recovery |
|---|---|---|
| Deployed skills missing from the DSH catalog | Session started from a different working directory (project skills are cwd-scoped) | Relaunch from the project root, or redeploy with `--scope user` / `--global` |
| Skills present but stale after `aiwg refresh` | DSH caches discovery until the watcher fires; long-running sessions may hold the old snapshot | Restart the session, or touch a skill directory to trigger `skills/change` |
| User-scope deploy invisible | Custom `DSH_AGENTS_HOME` on the DSH side that AIWG did not see | Export the same `DSH_AGENTS_HOME` before running `aiwg use ... --scope user`, then re-run |
| `AGENTS.md` section drifts from the corpus | Manual edits inside the managed block | Re-run `aiwg regenerate --provider dsh`; keep manual content outside the managed markers |

## Provider Notes

- Status is **experimental**: DeepSeek Harness itself is a developer preview with compatibility-breaking changes expected; treat redeployments as cheap.
- DSH ranks project `.agents/skills` above user `~/.agents/skills`, so a project-local skill shadows a user-scope skill of the same name — same precedence AIWG documents for Codex.
- Kernel skills stay flat while the bulk of the corpus remains at `$AIWG_ROOT` behind `aiwg discover` / `aiwg show` (#1217 kernel pivot). Do not flatten the whole corpus into `.agents/skills/`; it bloats every session's catalog.
