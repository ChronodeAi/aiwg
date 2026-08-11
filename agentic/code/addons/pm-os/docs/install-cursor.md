# Install PM OS in Cursor

PM OS ships a Cursor-shaped distribution generated from the same canonical source as Claude Code and Cowork. Cursor reads `.cursor/` at workspace root — extract the ZIP and you're done.

---

## What you download

From your customer-access link, grab `pm-os-cursor-<version>.zip`.

Inside:

```
pm-os-cursor-<version>.zip
├── .cursor/
│   ├── skills/             # 230 skills (Cursor reads this directory)
│   ├── agents/             # 10 sub-agents
│   ├── hooks/              # SessionStart hooks (tidy-reminder, drip-reminder)
│   ├── hooks.json          # Cursor's hook declaration format
│   ├── mcp.json            # MCP servers (lenny-podcast)
│   └── rules/
│       └── pm-os-core-rules.mdc   # AGENTS.md wrapped with .mdc frontmatter
├── .cursor-plugin/
│   └── marketplace.json
├── knowledge/
├── 📂 Context/
├── templates/
├── examples/
├── external-skills/
├── bin/
├── AGENTS.md               # Cursor's project-context anchor (no CLAUDE.md needed)
├── README.md
└── CHANGELOG.md
```

The Cursor build is generated from the canonical source by `bin/build-cursor-zip.sh` at release time. The transform handles per-tool differences:

- `AskUserQuestion` → `AskQuestion` (Cursor's tool name)
- `` paths → `.cursor/` paths
- `${CLAUDE_PLUGIN_ROOT}` → the hook script directory
- Slash prefix strip: `/pm-os:pm-os-start` → `/start`, `/pm-os:pm-help` → `/help`, etc. (Cursor's plugin UI shows source clearly, so the disambiguation prefix isn't needed)
- AGENTS.md gets wrapped with `.mdc` frontmatter and saved as `.cursor/rules/pm-os-core-rules.mdc` (Cursor's persistent rule format)

---

## Install

Extract the ZIP into your workspace folder:

```bash
unzip pm-os-cursor-<version>.zip -d /path/to/your/workspace
cd /path/to/your/workspace
cursor .
```

Or drag-and-drop in Finder if you prefer.

Cursor picks up `.cursor/skills/`, `.cursor/agents/`, `.cursor/hooks.json`, `.cursor/mcp.json`, and `.cursor/rules/pm-os-core-rules.mdc` automatically on session start. No configuration needed.

---

## Verify install

In any Cursor session, type `/` to open the slash menu. You should see:

- **System skills** (13, bare names): `start`, `tidy`, `upgrade`, `feedback`, `project`, `skill`, `framework`, `capture-memory`, `daily-drip`, `testimonial`, `help`, `status`, `import-ai-memory`.
- **Workflows** (10): `strategy`, `opportunity`, `assumptions`, `research`, `decisions`, `stakeholder`, `meeting`, `review`, `coaching`, `measure`.
- **Reusable** (213): mostly long descriptive names — `find-the-strategic-crux`, `mckinsey-issue-tree`, `verbalized-sampling`, …

Total: 236 entries.

For the Lenny MCP: open Cursor's MCP server panel (Settings → MCP). You should see `lenny-podcast` listed and connected. First request after idle takes ~15–30 seconds while Render wakes the dyno.

---

## Your first session

```
/start
```

Walks you through filling `📂 Context/COMPANY.md`, `PRODUCTS.md`, `GOALS.md`, `TEAM.md`, `CONSTRAINTS.md`. About 5 minutes.

Then ask something real:

```
I need to figure out what to prioritize for Q2. Here are the 6 things on the table: …
```

The AI reads your filled-in Context files before every response.

---

## Cursor-specific notes

### Persistent rules

Cursor's `.cursor/rules/pm-os-core-rules.mdc` is loaded as a persistent rule with `alwaysApply: true` in the frontmatter. This means PM OS's operating rules (the routing rules, deliverable gating, journalist/spy rule, etc.) survive Cursor's context compaction — they get re-injected after the chat history is trimmed.

The `.mdc` file is auto-generated from `AGENTS.md` at build time. **Don't edit `.cursor/rules/pm-os-core-rules.mdc` directly** — your changes will be overwritten on the next release. Edit `AGENTS.md` if you have the source repo, otherwise wait for a release or open an issue.

### Auto model selector

Disable Cursor's Auto model selector. It may route to weaker models based on perceived message simplicity. PM OS messages are never simple — every turn requires multi-constraint reasoning. Pin to a capable model in Cursor's model settings.

### Hook execution

Cursor runs `.cursor/hooks/*.sh` scripts at session start via `.cursor/hooks.json`. These produce `[SESSION-START DIRECTIVE — …]` payloads that Cursor injects as additional context for the AI's first turn. The visible output in Cursor's chat depends on Cursor's rendering of the directive — usually you'll see the AI act on the directive (e.g., offer to run `/tidy` if Context drift is detected) rather than a literal echo of the script output.

---

## Skills don't appear

If autocomplete doesn't show the 236 entries:

1. Confirm `.cursor/skills/` exists and contains 230 subdirectories: `ls .cursor/skills | wc -l`.
2. Restart Cursor (sometimes the file watcher misses bulk file additions).
3. Confirm `.cursor-plugin/marketplace.json` is valid JSON: `cat .cursor-plugin/marketplace.json | jq empty`.

If the skills exist on disk but Cursor doesn't surface them, check Cursor's logs (Help → Toggle Developer Tools → Console).

---

## Upgrading

To upgrade an existing PM OS Cursor install to a newer version:

```bash
bash bin/upgrade.sh --in-place /path/to/your/workspace
```

The script detects Cursor's `.cursor/` shape and applies the right merge. Preserved: `📂 Context/`, `📂 Context/Work/`, custom files in your workspace. Replaced: `.cursor/`, `knowledge/`, `templates/`, `examples/`, `bin/`, `AGENTS.md`.

If you've downloaded the wrong-tool ZIP (e.g., the Claude Code ZIP for a Cursor workspace), the script refuses with a friendly message pointing at `pm-os-cursor-X.Y.Z.zip`.

See [`upgrade.md`](upgrade.md) for the full flow.

---

## Uninstall

Delete `.cursor/`, `.cursor-plugin/`, and the workspace folders you don't want (`knowledge/`, `templates/`, `examples/`, `external-skills/`, `bin/`, `AGENTS.md`). If you want to keep your context, leave `📂 Context/` and `📂 Context/Work/` alone.

---

## Next

- [`install-claude-code.md`](install-claude-code.md) — Claude Code CLI.
- [`install-cowork.md`](install-cowork.md) — Cowork.
- [`upgrade.md`](upgrade.md) — version-to-version migration.
