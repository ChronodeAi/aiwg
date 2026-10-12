---
name: via-negativa
description: >-
  Use when a product, offering, doc, or flow is bloated and you want to improve it by *subtraction* — name the one core purpose, then cut every element that doesn't serve it. Not for cutting steps from a specific multi-step flow (`friction-reduce`), deciding what makes a release (`p0-p1-p2`), or pricing a proposed scope addition (`scope-defense`).
---

# Improve by subtraction (Via Negativa)

## Step 1 — Name the core purpose

State in one sentence the single thing this must achieve. Every element gets judged against it; a fuzzy purpose makes every cut arguable.

Done when the core purpose is one sentence.

## Step 2 — List every element

Inventory the components, sections, or features as they are now — the honest full list, including the ones that feel load-bearing.

Done when every element is listed.

## Step 3 — Judge each against the purpose

Tag each element: **keep** (directly serves the purpose), **cut** (doesn't), or **risky-cut** (removing it has a real downside). "Nice to have" is a cut.

Done when every element is tagged, with one line on each cut and risky-cut.

## Step 4 — Decide the risky cuts

For each risky-cut, name the downside and make the call — remove or keep, not "maybe." Sunk cost and "someone might want it" are not reasons to keep.

Done when every risky-cut is resolved to keep or remove with a stated reason.

## Step 5 — Present the stripped version

Give the simplified version — essentials only — plus what was removed and why, and the one signal you'd watch to confirm a cut didn't hurt.

Done when the stripped version is shown, removals are listed with reasons, and a watch signal is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-via-negativa-{subject-slug}.md`. Never hand-build the path.

The doc holds: the core purpose, the element inventory with keep/cut/risky-cut tags, the resolved risky cuts with reasons, and the stripped version with its watch signal.
