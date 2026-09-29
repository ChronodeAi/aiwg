---
name: pm-os-upgrade
description: >-
  Use when the user wants to upgrade an existing pm-os workspace to a newer
  version, or says '/upgrade' or '/pm-upgrade'. Not for a fresh install
  (`pm-os-start`) or creating/managing project folders after the upgrade
  (`pm-os-project`).
---

# /upgrade — Merge

## OpenAI Codex / ChatGPT with AIWG

Codex installations use the versioned AIWG addon lifecycle, not the legacy provider ZIP merger. Do **not** run `bin/upgrade.sh` against an AIWG/Codex workspace.

From the target workspace:

```bash
# Preview the addon/provider deployment.
aiwg use pm-os --provider codex --dry-run --verbose

# Deploy the addon adapters, then regenerate the PMOS compatibility views.
aiwg use pm-os --provider codex --verbose
python3 bin/generate-codex-adapters.py

# Artifact evidence is mandatory; AIWG exit status alone is not enough.
bash bin/validate-codex-parity.sh
aiwg doctor --project-local
```

If the dry run prints `script not found`, or the deployment emits zero required PMOS artifacts, stop and use the repository generator/validator path above; do not report success. After changed skills or hooks, restart/reload the Codex session and review hook trust with `/hooks`.

The Codex lifecycle owns only PMOS-namespaced generated files. It must preserve `📂 Context/`, `📂 Context/Work/`, `.aiwg/`, AIWG-managed non-PMOS `.codex/` and `.agents/` files, operator content in `WORKSPACE.md`, custom addons, and external-skill registry state.

The remainder of this document is the legacy ZIP path for Claude Code and Cursor.

## Legacy ZIP path: who needs this

- You installed pm-os a while ago (any v2.x version) and downloaded a newer ZIP.
- You want the new system files merged into your existing workspace without losing your Context, Work, or customizations.

## Who does NOT need this

- **Fresh install:** unzip the distribution into a folder, open it in your tool, type `/start`. No `/upgrade` needed.
- **Cowork users:** Cowork plugin upgrades happen in the Cowork UI (re-upload the new plugin ZIP, which overwrites the previous version by name). The script below does not apply.

## Usage

The `/upgrade` command wraps a tool-aware script (`bin/upgrade.sh`) that:

1. **Detects what tool your workspace is set up for** — Cursor, Claude Code, or mixed (pre-v2.1 era when both .cursor/ and .claude-plugin/ shipped together).
2. **Detects what tool this distribution is for** — Cursor (`pm-os-cursor-X.Y.Z.zip`) or Claude Code (`pm-os-claude-code-X.Y.Z.zip`).
3. **Validates the match.** If you downloaded the wrong ZIP, the script refuses and tells you which one to grab — no files are modified.
4. **Applies the right merge:** replaces system files, preserves user data.
5. **If your workspace was the old "mixed" shape**, strips the other tool's surface so the workspace is committed to a single tool going forward.

Done when the merge has applied (or refused with a clear reason) and every file in "What gets preserved" below is unchanged on disk.

## How to run

Ask the user once for the path to their workspace, then run:

```bash
# Dry-run first (recommended) — shows what would change without writing.
bash bin/upgrade.sh --in-place /path/to/their/workspace --dry-run

# Apply.
bash bin/upgrade.sh --in-place /path/to/their/workspace
```

## What gets preserved

- `📂 Context/COMPANY.md`, `PRODUCTS.md`, `GOALS.md`, `TEAM.md`, `CONSTRAINTS.md`, `STAKEHOLDERS.md`, `MY_STYLE.md` — filled-in user data
- `📂 Context/Work/` — every project folder, `events.jsonl`, `DECISION-LOG.md`, recall packets, the `.current` file
- `📂 Context/Work/.hook-state/` — universal `user-memory.md`, daily-drip state, continual-learning state
- Custom plugins (anything you added under `plugins/` that isn't `core` or `pm-workflows`)
- Custom skills (anything not in the system skills registry)
- The user-customizable parts of `.claude/settings.json` (MCP servers, etc.) — merged, not overwritten, if `jq` is installed.

## What gets replaced

- ``, `` (or `.cursor/` for Cursor distributions)
- `knowledge/` — the curated Knowledge base
- `templates/`, `examples/`
- `bin/` — system helpers (your custom scripts under `bin/` get overwritten — back them up first if needed)
- `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/pm-os-core-rules.mdc`

## Wrong-ZIP detection

If you downloaded `pm-os-claude-code-X.Y.Z.zip` but your workspace was set up for Cursor, the script prints:

```
ERROR: You downloaded the wrong PM OS ZIP.

  Your workspace is set up for: cursor
  This distribution is for:     claude-code

  → Download pm-os-cursor-X.Y.Z.zip instead from:
    https://github.com/gnurio/pm-os/releases/latest

  No files were modified.
```

And exits with code 2. Same in reverse.

## Mixed-era transition note

If your workspace was set up under v2.0-alpha.x (which shipped both `.cursor/` and `.claude-plugin/`), running `/upgrade` commits you to one tool. Pick the ZIP for the tool you actually use:

- Use Claude Code? → `pm-os-claude-code-X.Y.Z.zip` (strips `.cursor/`)
- Use Cursor? → `pm-os-cursor-X.Y.Z.zip` (strips `.claude/`)

Your Context and Work data are preserved either way. You can run `/upgrade` again with the other ZIP later if you want to switch.
