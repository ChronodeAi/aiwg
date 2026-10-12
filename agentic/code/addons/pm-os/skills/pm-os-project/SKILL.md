---
name: pm-os-project
description: >-
  Use when the user wants to create, list, switch, activate, or archive a
  PM OS project folder, or says '/project'. Not for routing orphaned files
  into the folders this creates (`pm-os-tidy`) or capturing an event into
  the project once it exists (`pm-os-capture-memory`).
---

# /project — Anchor project state

## Usage

| Form | What it does |
|------|--------------|
| `/project` | Show the current active project and list all existing projects |
| `/project new [name]` | Create a new project folder (slug is inferred from name) |
| `/project list` | Enumerate all project folders and their PRDs if any |
| `/project switch [slug]` | Mark a project as the current active one |
| `/project archive [slug]` | Move project folder to `📂 Context/Work/.archive/` |
| `/project current` | Print only the current active project slug |

If the user types `/project` alone with no sub-command, default to showing current + list.

## Project folder layout

```
📂 Context/Work/
  {project-slug}/                 ← project folder (may be nested, e.g. parent/child)
    PRD.md                        ← anchor (optional but recommended)
    events.jsonl                  ← project memory (canonical)
    DECISION-LOG.md               ← human projection of events
    YYMMDD-strategy.md
    YYMMDD-research-synthesis.md
    YYMMDD-assumption-map.md
    YYMMDD-decision-pricing.md
    YYMMDD-meeting-summary.md
    YYMMDD-measurement.md
    sub-project/                  ← nested sub-project (own events.jsonl)
    ...
  Coaching/                       ← non-project (cross-cutting)
  Drills/                         ← non-project
  Reviews/                        ← non-project
  .archive/                       ← archived projects live here
  .inbox/                         ← quarantine for saves that can't be auto-placed
  .current                        ← state file: one project slug per line
```

## Slug rules

- Kebab-case per segment, max 40 characters per segment.
- Alphanumeric + `-` and `_` only inside a segment; first character must be alphanumeric.
- Forward slashes (`/`) compose segments into nested project paths, e.g. `mobile-payments/checkout`.
- Lowercase is preferred but uppercase is allowed per-segment when the user explicitly wants it.
- "Mobile Payments Revamp" → `mobile-payments-revamp`.
- Strip emojis, punctuation, and articles (a/an/the) from the start of each segment.
- First top-level segment cannot collide with reserved siblings: `Coaching`, `Drills`, `Reviews`, `.archive`, `.current`, `.inbox`, or any name starting with `.`.
- Path traversal (`..`), leading slash, trailing slash, and double slashes are rejected.
- If the user's chosen slug would collide with an existing project, append `-v2`, `-v3`, etc. and confirm.

### Memory invariant

Each project folder — leaf or otherwise — owns at most **one** `events.jsonl`. Nested
sub-projects keep their own canonical memory, parents keep theirs. Hierarchical recall
cascades parent context into child sessions automatically (see "Memory cascading" below).

## Behaviour: `/project new [name]`

1. If no name was supplied, ask: "What's the name of this project? (Short working name is fine — you can rename later.)"
2. Derive the slug. Show both: `Name: "Mobile Payments Revamp" → Slug: mobile-payments-revamp`.
3. For nested slugs (`parent/child/...`), confirm that the parent project already exists — if not, ask whether the user wants to create the entire chain in one go.
4. Ask: "Create folder `📂 Context/Work/mobile-payments-revamp/`? (Y/n)"
5. On yes:
   - Create the folder with `mkdir -p` so any missing parent segments are created at the same time. Each parent and the leaf each end up as a real project folder.
   - For each newly created folder along the chain, leave it eligible for its own `events.jsonl` (created lazily by `/capture-memory`).
   - Update `📂 Context/Work/.current`:
     - If the file is missing or empty, write the new slug as the single line.
     - If the file already lists slugs, append the new slug only when the user confirms "make this active too". Otherwise replace the file with just the new slug.
     - Prune lines whose folder no longer exists or fails slug validation while you're at it.
   - Drop a `README.md` inside the folder with a minimal header:
     ```markdown
     # {Project Name}

     *Created {YYYY-MM-DD}*

     ## Anchor
     - PRD: [link or pending]
     - Goal:
     - Timeline:

     ## Artifacts
     All strategy, research, decision, meeting, and measurement files for this project live in this folder. Run `/strategy`, `/research`, `/decisions`, `/measure`, etc. and they will save output here automatically.
     ```
   - Confirm: "Created `mobile-payments-revamp/`. Any workflow you run now will save output here. Type `/project` anytime to see where you are."
6. If the user has not yet anchored the project with a PRD, offer once (and only once): "Want me to scaffold a PRD for this project using one of the templates in `templates/`? (Y/n)". On yes, ask the gate question before drafting.

Done when the folder (and every missing parent segment) exists on disk, `.current` reflects the confirmed choice, and the user has been told where output will land.

## Behaviour: `/project list`

Walk `📂 Context/Work/` recursively. Skip `Coaching`, `Drills`, `Reviews`, `.archive`, `.inbox`, anything beginning with `.`, and `.current` itself. Each directory below the root is its own project — including nested sub-projects. For each, show:
- Slug (use the path relative to `📂 Context/Work/`, e.g. `parent/child`)
- Has PRD? ✓/✗ (checks for any file matching `PRD*.md` or `prd*.md` in that exact folder, not recursively)
- Has `events.jsonl`? ✓/✗
- File count (own files only — exclude nested sub-projects so counts aren't double-attributed)
- Last modified date (most recent mtime in that folder)

Mark every active project (any slug listed in `.current`) with a `→` marker. Mark nested sub-projects with an indent matching their depth.

## Behaviour: `/project switch [slug]`

1. If slug is missing, present the list and ask which to switch to (structured question, single select).
2. Verify the folder exists. If not, offer to create it (`/project new`).
3. Replace `📂 Context/Work/.current` with the slug on a single line.
4. Confirm: "Current project is now `mobile-payments-revamp`. Cleared other active projects."

### Multi-project state

If the user wants to keep more than one project active at a time (e.g. they jump between `pricing-revamp` and `mobile-payments`), `.current` accepts one slug per line. Behavior:

- Reads ignore blank lines, comments (lines starting with `#`), and duplicates.
- `bin/memory/list-active-projects.sh` is the canonical reader. It returns each entry with `ok | missing_project | archived_project | invalid_target` so the AI can prune stale lines.
- When a workflow needs to persist memory and `.current` has more than one resolvable project, ask the user which one to attribute the update to. "all" routes the update to `📂 Context/Work/.hook-state/user-memory.md` via `bin/memory/append-user-memory.sh` instead of any single project's `events.jsonl`.
- `/project current` prints every line in `.current`, one per line, marking the first as the primary default. If only one is present, behaviour is unchanged.

## Behaviour: `/project activate [slug]`

Same as `switch`, but **adds** the slug to `.current` instead of replacing — useful for keeping a parent and one of its sub-projects active simultaneously.

1. Resolve the slug (must exist).
2. Append it to `.current` if it's not already there.
3. Confirm: "Added `parent/child` to active projects. Active list: parent, parent/child."

## Behaviour: `/project archive [slug]`

1. If the slug has live sub-projects under it, list them and warn: archiving the parent moves the entire tree.
2. Confirm: "Archive `mobile-payments-revamp/` to `.archive/`? This preserves every file — nothing is deleted. (Y/n)"
3. On yes, move the folder (and its descendants) to `📂 Context/Work/.archive/{slug}/`.
4. Remove every line in `.current` that points at this slug or any descendant. If `.current` ends up empty, leave it empty rather than deleting the file.

Done when the folder tree has moved to `.archive/` intact and no `.current` line still points at it or a descendant.

## Memory cascading

Project memory cascades **down**, never up:

- A nested project (e.g. `mobile-payments/checkout`) inherits every active recall packet field — decisions, risks, open questions, constraints, recent sources — from its parents (`mobile-payments`).
- `bin/memory/build-recall-packet.sh` performs the cascade automatically when given a nested slug. Override with `--no-cascade` for debugging or with `--cascade on` to force inclusion when otherwise off.
- A parent does **not** see child memory unless the user explicitly switches to the child. This protects parents from being polluted by experimental sub-project work.
- Cascade only loads parents that resolve cleanly. Missing or archived parents are skipped silently and recorded in the packet's `cascade_parents` / `cascade_loaded` fields for traceability.

## Behaviour: `/project` (no args) or `/project current`

- Read `📂 Context/Work/.current` via `bin/memory/list-active-projects.sh`.
- If `status=ok` and one project resolves: show `Current: {slug}` and a short summary (file count, last modified, cascade parents if nested).
- If multiple resolve: show every active slug with the cascade chain for each, mark the first as the default.
- If `status=missing_current`, `empty`, or `all_invalid`: say "No current project. Run `/project new` to create one or `/project list` to see existing ones." If `all_invalid`, also list which lines failed and why so the user can clean up `.current`.
- Then, always run `/project list` output below the current-project line.
- If `📂 Context/Work/.inbox/` exists and is non-empty, surface a one-line note: "N file(s) in `.inbox/` couldn't be auto-placed — run `/tidy` to sort them into projects." Do **not** resolve them here; `/tidy` owns the resolve-out flow.

## Detecting existing work

On first run (no `.current` file but project folders already exist in `Work/`), say:
> "I see existing project folders: `project-a`, `project-b`. Which one are you currently focused on? (Or type `new` to start a fresh project.)"

Use a structured question if possible.

## What this command does NOT do

- It does not automatically create a PRD — it offers to, and only on confirmation.
- It does not move existing type-based folders (`Work/Strategy/`, `Work/Research/`, etc.) — that legacy reshape lived in the pre-v2.1 `bin/migrate.sh`. If you have legacy folders, organize them by hand into project slugs.
- It does not delete anything. Archive only.

## Who calls this

- The user, explicitly: `/project new mobile-payments`, `/project list`, etc.
- The `/start` onboarding flow — offers to create a first project near the end.
- The AI proactively, when AGENTS.md's How to Use Project State and Save Artifacts → Proactive detection rule detects that the user has started work that doesn't map to any existing project. In that case the AI asks once: "This looks like a new project — want me to create `📂 Context/Work/{inferred-slug}/` so everything lands in one place? (Y/n)".

## Implementation notes for the AI

- You are the implementation. There is no separate CLI script. Use your file tools to create, read, and move folders directly.
- Always confirm before creating, switching, or archiving — no silent writes.
- When derived, always show the user the slug before creating the folder so they can correct it.
