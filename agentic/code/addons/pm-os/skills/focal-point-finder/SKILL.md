---
name: focal-point-finder
description: >-
  Use when multiple parties need to converge on a single choice without full
  communication, such as setting a standard, deadline, or meeting point — a
  coordination problem in, a stress-tested focal point recommendation out.
  Not for assigning explicit decision rights when authority exists
  (`davci`), diagnosing why a decision process is stuck
  (`corporate-misalignment-finder`), or mapping stakeholders' power and
  interest (`stakeholder-map`).
---

# Find a focal point for coordination without explicit agreement

Read `references/schelling-focal-points.md` for the full method, source quotes, and worked examples — Step 2's magnet tests and Step 4's creation techniques are defined there in depth.

## Step 1 — Map the coordination problem

Get the parties, what's being coordinated, the communication constraints, the cost of failing to converge, and whether interests are aligned, divergent, or mixed.

Done when all five are stated and confirmed with the user.

## Step 2 — Scan for an existing focal point

Check the five magnets — uniqueness, simplicity, precedent, symmetry, cultural salience — against any option already in play. Rate each candidate strong/moderate/weak. If a strong focal point already exists, stop here and present it; the job is to recognize it, not invent one.

Done when every candidate is magnet-tested and rated, or a strong focal point is confirmed and the skill stops.

## Step 3 — Diagnose why convergence is failing

If nothing strong exists, name why: too many equally-valid options, cultural salience differs across parties, the obvious answer discriminates, noise is drowning the signal, or the group is negotiating a continuum instead of a category.

Done when the specific failure mode is named, not just "coordination isn't happening."

## Step 4 — Create or propose a focal point

Apply the matching technique: be first with a visible specific proposal, recruit a mediator, reframe the problem, introduce noise defensively, or convert the question into a qualitative boundary. Never propose multiple "equally good" options — singularity is the point.

Done when exactly one focal point is proposed, not a menu.

## Step 5 — Stress-test and present

Run the proposal through all five tests: if-not-here-where, newcomer, breach, concession, stability. Present the recommendation with which magnets it activates, how to establish it, and the risks.

Done when all five stress tests have a stated pass/fail and the recommendation names its risks.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-focal-point-{situation-slug}.md`. Never hand-build the path.

The doc holds: the coordination map, the magnet ratings, the diagnosis (if needed), the recommended focal point, and its stress-test results.
