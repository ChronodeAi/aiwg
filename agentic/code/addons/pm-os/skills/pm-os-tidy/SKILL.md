---
name: pm-os-tidy
description: >-
  Use when the user wants to sync Context with Work, tidy up orphaned
  artifacts, route files into project folders, or says '/tidy' or 'clean
  up'. Not for creating or archiving the project folders themselves
  (`pm-os-project`) or capturing a specific decision or update into memory
  (`pm-os-capture-memory`).
---

# /tidy — Drift

## What it does

1. Ensures `📂 Context/Work/.hook-state/` exists (first-run safe).
2. Reads `📂 Context/Work/.hook-state/tidy.json` for the last run timestamp.
3. Detects **orphans** — files sitting at `📂 Context/Work/` root or in legacy type-based folders (`PRDs/`, `Research/`, `Decisions/`, `Strategy/`, `Measurements/`) — and proposes routing them into project folders.
4. Detects **drift** — Context-namespace `.md` files the canonical save guard would relocate (issue #35), each with a precomputed canonical `target`. This catches what the write-time guard misses (Edit-created files, saves made in distributions without the live hook, and the stray non-emoji `Context/` twin).
5. Finds all files modified in `📂 Context/Work/` since the last tidy and cross-references them against the 5 core Context files.
6. Presents proposed orphan moves, drift relocations, and Context updates in a structured table.
7. Applies only the changes you explicitly confirm.
8. Suggests cleanup for stale or empty artifacts.
9. Writes updated state to `tidy.json`.

Done when every proposed move and Context update has been shown to the user and applied only where explicitly confirmed, and `tidy.json` reflects the run.

## When to use

- Start of day — keep Context files fresh before diving into work.
- After completing a workflow — propagate decisions, research, or strategy changes.
- When `/status` reports context drift or stale goals.
- When the sessionStart hook reminds you that orphans exist or it's been 12+ hours.

## Procedure

Run:

```bash
bash bin/tidy.sh
```

Use the JSON report from `bin/tidy.sh` as the primary data source:

- `current_project`
- `total_modified`, `total_orphans`, `total_drift`
- `stray_context_dir` — `true` when a non-emoji `Context/` twin exists
- `modified_files[]`
- `orphans[]` — a `.md` file directly at `📂 Context/Work/` root, or inside a legacy type-based folder (`PRDs/`, `Research/`, `Decisions/`, `Strategy/`, `Measurements/` — pre-v1.8 layout). Files in `Coaching/`, `Drills/`, `Reviews/`, `.archive/`, or any existing project folder are **not** orphans.
- `drift[]` — each entry is `{path, target, branch}`. `target` is the canonical destination the save guard computed; `branch` is `slug_hint`, `single_active`, or `quarantine` (a `.inbox/…` target the user should later sort into a real project).

For each orphan, read a short preview (first 20 lines) to infer which project it belongs to — look for a project name in the title, frontmatter, or body, and cross-reference with existing project folders. If uncertain, ask once: "Where should `{filename}` go? Options: {list existing project slugs}, or `new`, or `skip`."

For each modified file, cross-reference it against the 5 core Context files using the filename suffix convention workflows already write (`*-strategy.md` → `COMPANY.md`/`PRODUCTS.md`/`GOALS.md`; `*-research-*.md`/`*-jtbd*.md`/`*-interview*.md` → `PRODUCTS.md`/`GOALS.md`/`STAKEHOLDERS.md`; `*-decision*.md` → `GOALS.md`/`CONSTRAINTS.md`; `*-assumption*.md`/`*-opportunity*.md` → `GOALS.md`/`PRODUCTS.md`; `PRD*.md` → `PRODUCTS.md`; `*-meeting*.md`/`*-summary*.md`/`*-stakeholder*.md` → `STAKEHOLDERS.md`; `*-measurement*.md`/`*-metric*.md` → `GOALS.md`).

Present proposed orphan moves, **drift relocations**, and Context updates together for confirmation. Apply only changes the user explicitly confirms. For confirmed orphan moves, use `git mv` if the file is tracked, else plain `mv`; remove any empty legacy folders (`rmdir` ignoring errors) afterward.

### Relocating drift (issue #35)

For each `drift[]` entry, show `path → target` (note when `branch` is `quarantine`, i.e. the engine couldn't place it confidently and proposes `.inbox/`). On confirmation, perform the move with the same engine that computed it — never hand-move:

```bash
bash bin/memory/relocate-into-canonical.sh --path "<path>" --apply --json
```

It is collision-safe (never overwrites; dedupes byte-identical; suffixes on conflict) and fail-closed.

### Resolving the `.inbox` quarantine

If `📂 Context/Work/.inbox/` is non-empty, surface it here (this is the single place the inbox is resolved — `/project` only reports that it's non-empty). For each quarantined file, propose a destination project and, on confirmation, relocate it with `resolve-project.sh` + a safe move, or have the user pick a project. Do not leave the inbox to grow unbounded.

### Stray non-emoji `Context/`

If `stray_context_dir` is `true`, the canonical root is `📂 Context/` — a plain `Context/` is drift. Offer to relocate any `.md` it holds (already surfaced in `drift[]`) and then remove the empty `Context/` (and any stray `📂/`) directory once cleared. (The historical cause — an unquoted `mkdir` in `bin/tidy.sh` — is fixed, so it will not reappear.)

### Cleanup pass

If stale or empty artifacts are found (empty files, drafts unmodified for 90+ days, duplicate content), offer to archive them to `📂 Context/Work/.archive/` or delete empty scaffolds. Never touch anything without confirmation.

## State

Write `📂 Context/Work/.hook-state/tidy.json`:

```json
{
  "lastRunAt": "2026-04-18T10:00:00Z",
  "filesReviewed": [],
  "contextUpdates": [],
  "orphansRouted": []
}
```

If the state file or its directory is missing, create them on first run — do not error out. `bin/tidy.sh` handles this automatically (mode=`full` when no prior state, mode=`incremental` otherwise).

## Automation

A `SessionStart` hook declared in `hooks/hooks.json` runs `tidy-reminder.sh`. It injects a reminder to run `/tidy` when:
- `/tidy` has never been run, OR
- More than 12 hours have passed since the last run AND there are modified files, OR
- Orphans are detected at `Work/` root or in legacy type folders (regardless of last run time).

No action is required after the hook is trusted; it runs automatically. For recurring checks outside session start, use the host's scheduled-task feature or an external scheduler to invoke the PMOS tidy workflow. Do not assume a provider-specific `/loop` command exists.
