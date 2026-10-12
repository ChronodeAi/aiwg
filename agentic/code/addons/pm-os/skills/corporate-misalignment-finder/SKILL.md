---
name: corporate-misalignment-finder
description: >-
  Use when teams are stuck, decisions aren't being made, meetings are
  dysfunctional, or there's confusion about who has authority — a
  misalignment situation in (description, transcript, decision log, or vague
  complaint), a root-cause diagnosis and level-specific fixes out. Not for
  assigning decision rights going forward (`davci`), proposing a convergence
  point when there's no process or authority at all (`focal-point-finder`),
  or mapping per-person motivation instead of structural process
  (`hidden-agendas`).
---

# Diagnose organizational misalignment by stack level

Read `references/roberts-rules-framework.md` before beginning — it holds the diagnostic tools and procedural frameworks from Robert's Rules of Order this stack maps to.

## Step 1 — Take the situation and run the stack diagnostic

Get what's wrong: a description, a transcript, a decision log, or a vague complaint — interview if it's vague. Diagnose top-down through the Misalignment Stack, stopping at the first "no":

| Level | Question | If "no" |
|---|---|---|
| 1. Goals | Does everyone agree on what success looks like? | Goal Alignment |
| 2. Information | Does everyone have the same facts? | Info Sync |
| 3. Process | Is there agreement on how this gets decided? | Process Clarification |
| 4. Authority | Is it clear who decides? | Authority Resolution |
| 5. Decision | Is there a clear, documented decision? | Decision Capture |

Misalignment cascades upward — a broken lower level often explains an apparently-broken higher one. List every level that fails, ordered by severity.

Done when every level has a stated pass/fail with reasoning, and the root cause level(s) are named.

## Step 2 — Trace symptoms to the real root cause

A symptom ("meetings go in circles") and its root cause (no clear process) are rarely the same statement. Map each complaint to the actual broken level rather than prescribing a fix for the symptom itself.

Done when every named symptom is mapped to a specific stack level, not treated as self-explanatory.

## Step 3 — Prescribe fixes by level

For each broken level, propose the matching fix — a goal-alignment session, a single source of truth, a decision-making protocol, documented decision rights, or immediate decision capture. Split into immediate actions (this week) and process fixes (ongoing).

Done when every broken level has both an immediate action and a durable process fix.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-misalignment-{situation-slug}.md`. Never hand-build the path.

The doc holds: the stack assessment, the root cause(s), the symptom-to-cause map, and the prescribed fixes.
