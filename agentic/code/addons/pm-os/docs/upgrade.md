# Upgrading PM OS

PM OS ships a tool-aware in-place upgrade script for Claude Code and Cursor. Cowork upgrades go through Cowork's UI. Both preserve your `📂 Context/` data.

---

## Quick reference

| Distribution | Upgrade method | What gets preserved | What gets replaced |
|---|---|---|---|
| Claude Code | `git pull` (if cloned) OR `bash bin/upgrade.sh --in-place .` | Context, Work, custom plugins, custom skills | `plugins/`, `knowledge/`, `templates/`, `examples/`, `bin/`, `AGENTS.md`, `CLAUDE.md` |
| Cursor | `bash bin/upgrade.sh --in-place /path/to/workspace` | Context, Work, custom files | `.cursor/`, `knowledge/`, `templates/`, `examples/`, `bin/`, `AGENTS.md` |
| Cowork | Re-upload `pm-os.zip` via Customize → Upload custom plugin | Whatever is already in your Cowork project folder | The plugin overwrites by name |

---

## Claude Code & Cursor: `bin/upgrade.sh`

### Usage

```bash
bash bin/upgrade.sh --in-place /path/to/your/workspace
```

For a dry-run (preview changes without writing):

```bash
bash bin/upgrade.sh --in-place /path/to/your/workspace --dry-run
```

### What it does

1. **Detects the workspace tool.** Looks for `.claude-plugin/` (Claude Code), `.cursor/` (Cursor), or both (the mixed-v2.0-era shape that shipped before the v2.1 split).
2. **Detects the distribution tool.** Looks at the ZIP you've extracted (`pm-os-claude-code-X.Y.Z.zip` vs `pm-os-cursor-X.Y.Z.zip`).
3. **Validates the match.** If you've downloaded the wrong ZIP for your workspace, the script refuses with a friendly message pointing at the correct ZIP. No files modified.
4. **Applies the right merge.** Replaces system files; preserves user data.
5. **Strips the other tool's surface** if your workspace was the old mixed v2.0 shape. Going forward, your workspace is committed to one tool. You can switch by re-running with the other distribution.

### Preserved

- `📂 Context/COMPANY.md`, `PRODUCTS.md`, `GOALS.md`, `TEAM.md`, `CONSTRAINTS.md`, `STAKEHOLDERS.md`, `MY_STYLE.md` — every file you've filled in.
- `📂 Context/Work/` — every artifact in every project folder, including `.hook-state/` (user memory, drip state, tidy state).
- `external-skills/registry.json` — if you added custom external skill sources, they survive.
- Any custom plugins in `plugins/*/` not named `pm-os` (CC) or in `.cursor/skills/*/` not part of the bundled set (Cursor).

### Replaced

- `` (CC) or `.cursor/` (Cursor) — wholesale replaced with the new distribution.
- `knowledge/` — replaced. If you added custom knowledge files, copy them out before upgrading.
- `templates/`, `examples/` — replaced.
- `bin/` — replaced.
- `AGENTS.md` and `CLAUDE.md` — replaced. **If you customized AGENTS.md**, save your changes first; you'll need to re-apply them after the upgrade.

### Wrong-tool error

If your workspace looks like Cursor (`.cursor/` exists, no `.claude-plugin/`) but you downloaded `pm-os-claude-code-X.Y.Z.zip`:

```
ERROR: workspace is Cursor but distribution is Claude Code.
       Download pm-os-cursor-2.1.0-beta.1.zip and re-run.
       No files were modified.
```

The script exits with code 2. Workspace stays untouched.

### Mixed-v2.0 transition

If your workspace has both `.cursor/` and `.claude-plugin/` (the v2.0-era shape that shipped both surfaces), the upgrade commits you to one tool. Pick the ZIP for the tool you actually use:

- `pm-os-claude-code-X.Y.Z.zip` → strips `.cursor/`, keeps `.claude-plugin/` + `plugins/`.
- `pm-os-cursor-X.Y.Z.zip` → strips `.claude-plugin/` and `plugins/`, keeps `.cursor/`.

Your `📂 Context/` and `📂 Context/Work/` are preserved either way. You can re-run with the other ZIP later if you switch tools — your data follows.

### Tested scenarios

The script has 8 integration test scenarios that run on every release:

1. CC distro → CC workspace (happy)
2. CC distro → mixed-v2.0 workspace (transition, strips Cursor)
3. CC distro → Cursor workspace (mismatch, exit 2)
4. Cursor distro → Cursor workspace (happy)
5. Cursor distro → mixed-v2.0 workspace (transition, strips Claude Code)
6. Cursor distro → CC workspace (mismatch, exit 2)
7. CC distro → unknown workspace (not-a-PM-OS-install, exit 3 with helpful message)
8. Dry-run does not modify files

If you hit a scenario that fails, open an issue with the script's full output.

---

## Cowork: re-upload the plugin

Cowork doesn't have a plugin upgrade slash. You re-upload the new plugin through the UI.

### Steps

1. Download the new `pm-os-cowork-X.Y.Z.zip` from your customer-access link.
2. Open Cowork → Customize → Plugins. Find the existing `pm-os` plugin.
3. **Re-upload** the inner `pm-os.zip` (not the outer release ZIP). Cowork overwrites by plugin name.
4. Verify the new version: `pm-os` should show `X.Y.Z` after re-upload.

### Workspace content

If the workspace structure changed (rare — happens only on major versions, not patches), copy the new `workspace/` content into your existing Cowork project folder:

- **Replace:** `knowledge/`, `templates/`, `examples/`, `README-cowork.md`.
- **Preserve:** `📂 Context/COMPANY.md` and the 4 other Context files you've filled in.
- **Preserve:** everything in `📂 Context/Work/`.

The CHANGELOG entry for each release notes whether workspace content needs to be refreshed. For patch and minor versions, plugin re-upload alone is usually enough.

### Why no script

The plugin format on Cowork is a sandboxed upload — the plugin can't trigger its own re-install from inside a skill. We can't ship an `/pm-os-upgrade` slash that just-works in Cowork without Cowork exposing a plugin-management API. We'll revisit if/when that lands.

---

## Version path

PM OS follows semantic versioning with `-alpha.N`, `-beta.N`, and `-rc.N` pre-release identifiers.

- **Patch** (`v2.1.0-beta.1` → `v2.1.0-beta.2`): bug fixes, doc updates, skill additions. Always safe to upgrade in place.
- **Minor** (`v2.1.0` → `v2.2.0`): new skills, new workflows, new features. Safe to upgrade; check CHANGELOG for any UX changes.
- **Major** (`v2.x` → `v3.0`): breaking changes — slash UX may change, workspace structure may change, plugin format may change. Read the CHANGELOG migration section before upgrading.

CHANGELOG entries always include a **Migration** subsection if anything user-visible changed.

---

## Manual upgrade alternative

If you don't trust the script and want to do it by hand:

1. **Back up your workspace** — `cp -R /path/to/your/pm-os /path/to/backup`.
2. Extract the new distribution ZIP to a fresh location.
3. From the fresh extract, copy these system files over your old workspace:
   - `` (or `.cursor/` for Cursor)
   - `knowledge/`
   - `templates/`
   - `examples/`
   - `bin/`
   - `AGENTS.md`, `CLAUDE.md` (CC) or `AGENTS.md` only (Cursor)
4. **Do not copy** these from the fresh extract (they belong to you):
   - `📂 Context/`
   - `📂 Context/Work/`
   - `external-skills/registry.json` (your custom sources)

The script does the above with safety checks. The manual path is fine if you prefer.

---

## Rollback

PM OS upgrades are one-way — there's no `--rollback` flag. To go back to a previous version:

1. Back up `📂 Context/` and `📂 Context/Work/` from your current workspace.
2. Delete the workspace (or move it aside).
3. Extract the previous version's ZIP into a fresh location.
4. Restore your backed-up `📂 Context/` and `📂 Context/Work/`.

This is rare — we don't recall a user needing to roll back yet. If you do, mention the version range when you open an issue and we'll add release-specific rollback notes.

---

## Next

- [`install-claude-code.md`](install-claude-code.md) — CC install + first session.
- [`install-cowork.md`](install-cowork.md) — Cowork two-step install.
- [`install-cursor.md`](install-cursor.md) — Cursor extract-and-go.
- [`limitations-cowork.md`](limitations-cowork.md) — what Cowork doesn't yet support.
