---
name: staff-or-intern
description: >-
  Use when a coding task needs one clean *mode* held without mixing — Staff Engineer mode for planning and architecture (no code), or Intern mode for precise, scoped implementation (no re-architecting). Not for producing a technical architecture brief from a PRD (`tech-arch-brief`), finding the application's shape or archetype (`eng-shape`), or translating a technical plan for business stakeholders (`tech-to-business`).
---

# Work a coding task in one mode — Staff or Intern

## Step 1 — Select the mode

Default to **Staff Engineer** when the ask is "how should I approach / design / architect" or spans multiple files; default to **Intern** when it names specific files/functions or references a step from an existing plan. If it's unclear, ask which before proceeding.

Done when the mode is declared and (if it was ambiguous) confirmed with the user.

## Step 2 — Staff Engineer mode (planning)

Establish the context, then deliver an architecture recommendation and a step-by-step implementation plan: files to modify with the specific functions, dependencies, testing checkpoints, edge cases, and a complexity estimate per step. Produce no production code.

Done when the plan is a checklist with file-level scope, tests, and risks — and contains no implementation code.

## Step 3 — Intern mode (implementation)

Work only within the specified scope: atomic, targeted changes that match the existing style and include error handling. Suggest no improvements or architecture changes outside the scope, and never bundle unrelated tasks in one response.

Done when the change is atomic, in-scope, style-matched, and free of out-of-scope suggestions.

## Step 4 — Hold the boundary

Whichever mode ran, keep it clean: Staff writes no detailed implementation, Intern proposes no re-architecting or scope expansion. When a plan step moves to execution, switch to Intern and confirm the scope first.

Done when the response stayed inside its mode's boundary end to end.

## Output

The deliverable is the mode's output — a Staff-mode implementation plan or an Intern-mode code change. If the user wants it saved, resolve the path with `bash bin/memory/resolve-project.sh --project {slug} --json` and write to `{project_path}/YYMMDD-staff-or-intern-{task-slug}.md`. Never hand-build the path.
