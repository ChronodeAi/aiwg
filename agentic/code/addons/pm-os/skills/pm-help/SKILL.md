---
name: pm-help
aliases: [help]
description: >-
  Use when the user wants a live system tour, asks what PM OS can do, or
  says '/help' or '/pm-help'. Not for orienting on current state and a
  recommended next action (`pm-status`), matching one task to one skill
  (`pm-os-skill`), or browsing everything visually (`skill-browser`).
---

# /help — System Tour

**Tour.** Do not generate output from memory or hardcoded content. Read the actual project structure first.

Before writing anything visible to the user, execute the following reads in order:

1. List all folders in `plugins/` to identify which plugins are active
2. For each plugin folder (excluding `core/`), read its `agents/*.md` file to get the current persona and capabilities
3. List all files in `plugins/*/skills/` to build the complete current command list
4. Read `knowledge/INDEX.md` to get the current framework and content counts
5. Check if `knowledge/Writing-Styles/` exists — if so, note 4 writing style guides are available
6. Check if `examples/` exists — if so, note example PRDs are available
7. Check if `📂 Context/STAKEHOLDERS.md` exists and is filled — if so, note stakeholder profiles are active
8. Read `📂 Context/GOALS.md` — if it does not contain placeholder text, use the user's stated focus to personalize the recommendation at the end

Only after completing all reads above, generate the tour below. Everything you present must come from what you actually found in those files — not from what you recall or what was true when this command was written.

Done when all 8 reads above have completed and the tour below is generated from their actual results.

---

## Tour Structure

### 1. What this system is

Open with 3 bullet points that accurately describe the PM OS based on what you found:
- What it contains (plugins, frameworks, skills — use real counts)
- How it works (AI reads context + knowledge files, routes to the right plugin)
- What it is not (a generic chatbot — it's grounded in your specific situation)

Draw from `README.md` if needed for positioning language, but verify counts against what you actually found.

### 2. Plugins

For each plugin you found in `plugins/` (excluding `core/`), present:
- Plugin name (as found in the folder)
- What it does — pulled from that plugin's `agents/*.md` file, not paraphrased from memory
- Which commands are available — pulled from that plugin's `skills/` folder (PM OS merged commands into skills in v2.1.0-beta.1; there is no separate `commands/` folder)

Format this as a clean table or structured list.

### 3. Commands reference

List every slash command found across all `plugins/*/skills/` files, including `skills/`.

Group them logically:
- **Setup:** /start, /help
- **Strategy:** any commands found in pm-strategy
- **Research:** any commands found in pm-research
- **Specs:** any commands found in pm-specs
- **Influence:** any commands found in pm-influence
- **Career:** any commands found in pm-career

For each command: name + one-line description (from the command file's frontmatter `description` field).

### 4. How skills work

Explain that skills activate automatically based on what the user asks — no slash command needed. The user just describes what they want to do, and the right skill is invoked.

Give 2–3 concrete examples relevant to what you found in `📂 Context/GOALS.md`. If GOALS.md is not filled, give generic examples instead:
- "Create a stakeholder update" → activates a communication skill
- "Help me prioritize these 5 features" → activates a prioritization skill
- "I need to run a customer interview" → activates a research skill

For a visual browse of every skill grouped by category, mention `/skill-browser` — it opens an HTML catalog with search and a workflow showcase.

### 5. Context and resources

Report the current state of the user's context and available resources:

- **Mandatory context files** (COMPANY, PRODUCTS, GOALS, TEAM, CONSTRAINTS) — are they filled or still placeholders?
- **Stakeholder profiles** (`📂 Context/STAKEHOLDERS.md`) — filled / empty placeholders / not set up yet. If not set up, mention it can be added via `/start` (Phase 5).
- **Writing style guides** (`knowledge/Writing-Styles/`) — if present, mention 4 guides available (customer, executive, internal, technical). Invoke them with `/framework [audience]` or ask about tone — they are cited at drafting time, not auto-injected.
- **Example PRDs** (`examples/`) — if present, read `examples/README.md` to get the current count and titles. Suggest reading them before drafting a new PRD — not for format, but to calibrate the quality of evidence and language expected.

### 6. Pre-installed MCP servers

Check the active provider's MCP configuration: `.codex/config.toml` for Codex, `.cursor/mcp.json` for Cursor, or the provider-native equivalent. The PMOS source catalog is `.mcp.json`. For each configured server found, present:
- Server name
- What it provides (one sentence)
- Tools available

Distinguish cataloged from enabled servers. Only call a server live when it is configured, authenticated, and available in the current host.

If no provider MCP configuration exists or it has no servers, explain that integrations are optional and skip the server list.

### 7. Recommended next step

Based on what you found in `📂 Context/GOALS.md`:

- If GOALS.md is filled (no placeholder text): identify the user's stated quarterly focus and recommend the single most relevant command, with a one-sentence explanation of why it fits their situation.
- If GOALS.md is empty or placeholder: recommend `/start` to set up context, explaining that the system works best when it knows their specific situation.

Do not list multiple options here. One clear recommendation with a reason.
