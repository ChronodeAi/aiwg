# Install PM OS in Cowork

PM OS ships as a custom plugin you upload through Cowork's UI. Two-step install: plugin first, then workspace content.

---

## What you download

From your customer-access link, grab `pm-os-cowork-<version>.zip`. The outer ZIP contains two things you upload to different places:

```
pm-os-cowork-<version>.zip
├── pm-os.zip               ← the plugin (goes through Customize → Upload custom plugin)
├── workspace/              ← knowledge + templates (goes into your Cowork project folder)
│   ├── knowledge/
│   ├── 📂 Context/
│   ├── templates/
│   ├── examples/
│   └── README-cowork.md
└── README.md               ← the install instructions you're reading the long form of
```

The inner `pm-os.zip` is the plugin. The `workspace/` folder is the user-facing content the plugin reads at runtime (frameworks, templates, the empty Context files you'll fill in).

---

## Step 1: Upload the plugin

1. Open Cowork. Go to **Customize → Upload custom plugin**.
2. Drop in `pm-os.zip` (the inner one — not the outer release ZIP).
3. Cowork validates the plugin's `.claude-plugin/plugin.json` manifest. If validation fails, see Troubleshooting below.
4. On success, you'll see `pm-os` listed in your installed plugins.

The plugin auto-registers:
- 230 skills (15 system, 11 workflows, 204 reusable)
- 10 sub-agents (routing, knowledge, context, 7 review personas)
- 2 SessionStart hooks (tidy-reminder, drip-reminder)
- 1 MCP server (`lenny-podcast`)

---

## Step 2: Drop the workspace content

1. In Finder (or your file manager), open the extracted `workspace/` folder.
2. Locate your Cowork project folder (the folder you pointed Cowork at as your "project").
3. Move (or copy) the contents of `workspace/` into your project folder:
   - `knowledge/` — frameworks, interview questions, drills, north-star examples
   - `📂 Context/` — the 5 mandatory context files (empty placeholders to fill)
   - `templates/` — 7 PRD formats
   - `examples/` — 2 example PRDs
   - `README-cowork.md` — quick-reference

Cowork reads these files at runtime. The plugin's skills reference them via paths like `📂 Context/COMPANY.md` and `knowledge/Frameworks/discovery/strategy-kernel.md`.

---

## Step 3: Verify

In any Cowork session, type `/` to open autocomplete. Look for:

- **System skills, prefixed** (10): `pm-os-start`, `pm-os-tidy`, `pm-os-upgrade`, `pm-os-feedback`, `pm-os-project`, `pm-os-skill`, `pm-os-framework`, `pm-os-capture-memory`, `pm-os-daily-drip`, `pm-os-testimonial`. The `pm-os-` prefix makes them self-identifying in Cowork's prefix-less dropdown.
- **System skills, already-prefixed** (2): `pm-help`, `pm-status`. Carry the shorter `pm-` prefix because they originally needed to dodge Claude Code built-ins.
- **System skills, unprefixed** (1): `import-ai-memory`. Specific enough on its own.
- **Workflows** (10): `strategy`, `opportunity`, `assumptions`, `research`, `decisions`, `stakeholder`, `meeting`, `coaching`, `measure`, and `pm-review` (the `pm-` prefix is on this one for the same CC-builtin-collision reason as `pm-help`).
- **Reusable** (213): mostly long descriptive names — `find-the-strategic-crux`, `mckinsey-issue-tree`, `verbalized-sampling`, …

If you type `pm-os` in the autocomplete filter, all PM OS skills surface.

The Lenny MCP appears in Cowork's connected-tools list. First search after idle takes ~15–30 seconds (cold-start on Render free tier).

---

## Your first session

```
/pm-os-start
```

Walks you through filling `📂 Context/COMPANY.md`, `PRODUCTS.md`, `GOALS.md`, `TEAM.md`, `CONSTRAINTS.md`. The skill writes back into your Cowork project folder — Cowork's filesystem access makes this work natively.

Then ask something real:

```
I need to figure out what to prioritize for Q2. Here are the 6 things on the table: …
```

---

## Troubleshooting

### "Plugin validation failed" on upload

This usually means the plugin ZIP is malformed. Confirm you're uploading the **inner** `pm-os.zip`, not the outer `pm-os-cowork-<version>.zip`. The inner ZIP has `.claude-plugin/plugin.json` at its root.

If you're sure you uploaded the right file: the version you have may pre-date the canonical fix for stricter Cowork validation. Re-download from your customer-access link and retry with the latest release.

### Skills appear but don't run

Try uploading the plugin again — Cowork sometimes registers the manifest without loading the skill bodies on first attempt.

If a specific skill consistently fails, check whether the workspace `📂 Context/` files are filled. Most workflow skills (especially `pm-os-start`, `pm-status`, `strategy`) depend on context being set.

### Hooks don't fire visibly

Cowork's chat UI may not render hook output the same way Claude Code's CLI does. The hooks (`tidy-reminder`, `drip-reminder`) still execute server-side — you may see their effects in subsequent responses rather than as separate messages. This is a known Cowork rendering quirk, not a plugin bug. Detail in [`limitations-cowork.md`](limitations-cowork.md).

### Some skills show with weird names

If you see skills like `assumption-mapping`, `make-great-decisions`, `multi-perspective-review` (instead of `assumptions`, `decisions`, `pm-review`) — that's Cowork rendering the `name:` field from the skill's frontmatter rather than the directory name. The slash you actually type is the directory name. Type the latter and the skill resolves correctly.

---

## Upgrading

When a new PM OS version drops:

1. Download the new `pm-os-cowork-X.Y.Z.zip`.
2. **Re-upload the plugin** via Customize → Upload custom plugin. Same plugin name overwrites the previous version.
3. If the `workspace/` structure changed (rare), copy the new `workspace/` content into your existing Cowork project folder. Preserve your filled-in `📂 Context/*.md` files.

There is no `/pm-os-upgrade` slash in Cowork — the plugin re-upload is the migration path. Detail in [`upgrade.md`](upgrade.md).

---

## Uninstall

Cowork → Customize → Plugins → find `pm-os` → Remove. Your project folder's `📂 Context/`, `knowledge/`, and other workspace content stay where they are (you can delete them manually if you want a clean slate).

---

## Next

- [`install-claude-code.md`](install-claude-code.md) — same source, runs in Claude Code's CLI.
- [`install-cursor.md`](install-cursor.md) — Cursor distribution.
- [`limitations-cowork.md`](limitations-cowork.md) — what Cowork doesn't yet support.
- [`upgrade.md`](upgrade.md) — version-to-version migration details.
