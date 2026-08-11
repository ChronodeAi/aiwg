---
name: pm-status
description: >-
  Use when the user wants to orient on current state, asks 'where am I',
  wants a recommended next action, or says '/status' or '/pm-status'. Not
  for a full command tour (`pm-help`) or listing/switching project folders
  (`pm-os-project`).
---

# /pm-status — Orient

## What it does

1. Reads all `📂 Context/` files — `COMPANY.md`, `PRODUCTS.md`, `GOALS.md`, `TEAM.md`, `CONSTRAINTS.md`
2. Scans `📂 Context/Work/` for recently modified files (in-progress artifacts)
3. Resolves every active project from `.current`:
   ```bash
   bash bin/memory/list-active-projects.sh --json
   ```
4. Builds a compact active recall packet for **each** active project. Nested projects automatically cascade parent memory:
   ```bash
   bash bin/memory/build-recall-packet.sh --project "<slug>" --json
   ```
   The packet reports which parents were considered (`cascade_parents`) and which were actually loaded (`cascade_loaded`).
5. Cross-references active Work against `📂 Context/GOALS.md`
6. Delegates synthesis to `agents/context-manager.md`
7. Outputs: current state summary → active project(s) with cascade chain → project memory recall (per project) → goal coverage gaps → one recommended next action

Done when every active project has a recall packet reflected in the output and exactly one next action is recommended.

## When to use

- Start of a session — orient yourself before diving in
- After completing a workflow — see what is naturally next
- When you feel stuck or context has drifted — get a fresh read on priorities
- Periodically — check whether your GOALS.md still reflects reality
- Before a project-scoped workflow — recover prior decisions, risks, and open questions before asking generic intake questions

## If 📂 Context/ files are empty or contain placeholders

Redirect to `/start` to fill them first. `/status` cannot orient you without context.

## Memory behavior

- Include only compact recall: relevant decisions, risks, open questions, constraints, recent sources, and memory health.
- Always also read `📂 Context/Work/.hook-state/user-memory.md` if it exists. Treat it as universal memory that applies to every active project.
- When multiple projects are active, render each project's recall packet under its own heading and label inherited items (`from parent: <slug>`) so the user can see what came from cascade vs. the active project itself.
- Never paste raw `events.jsonl`, raw transcripts, full `DECISION-LOG.md`, or whole project folders into the response.
- If memory is missing, invalid, or unavailable, continue with normal context/project scan and state what was skipped.
- If `list-active-projects.sh` reports `partial` or `all_invalid`, surface the broken entries so the user can clean up `.current`.
