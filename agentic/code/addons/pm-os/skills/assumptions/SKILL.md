---
name: assumptions
aliases: [assumption-mapping]
description: Surface, prioritize, and find early signals for the riskiest assumptions in your product strategy — from assumption generation through prioritization to identifying the easiest validation signal. Use when mapping product assumptions, prioritizing risk, or designing validation experiments.
---

# /assumptions — Assumption Mapping

Walk the user through a 3-step assumption mapping session. Each step invokes a skill from `skills/`. Pass the output of each step as input to the next. Confirm with the user before advancing unless they request end-to-end.

---

## Before starting

Surface the most relevant frameworks for this workflow. Scan these Knowledge files and note 3-5 that apply to the user's assumption landscape:

- `knowledge/Frameworks/validation/` — 33 validation frameworks; surface those relevant to assumption testing and risk assessment
- `knowledge/Prioritization/` — scan tag metadata for frameworks that help prioritize which assumptions to test first

Present the relevant framework names (not full content) to the user before Step 1. One line each: name + when to use. Ask which, if any, they want applied during the workflow.

---

## Step 1: Generate product assumptions

**Skill:** `product-assumptions`
**Folder:** `skills/product-assumptions/SKILL.md`

Read and invoke this skill. Goal: systematically generate the full set of product assumptions embedded in the current strategy — across desirability, feasibility, viability, and usability.

**Output to carry forward:** Full assumption inventory, each assumption tagged with its lens and its impact if wrong.

---

## Step 2: Prioritize risky assumptions

**Skill:** `risky-assumptions`
**Folder:** `skills/risky-assumptions/SKILL.md`

Invoke this skill using the assumption inventory from Step 1. Goal: rank assumptions by risk on severity, uncertainty, and irreversibility, using QuickSort pairwise comparisons. Identify the top 1–3 that most threaten the strategy.

**Output to carry forward:** Ranked assumption list with the top 1–3 critical assumptions identified.

---

## Step 3: Work backwards to an easy validation signal

**Skill:** `work-backwards`
**Folder:** `skills/work-backwards/SKILL.md`

Invoke this skill for each of the top critical assumptions from Step 2. Goal: identify the cheapest, fastest signal that would confirm or refute each assumption before committing resources.

**Output:** Assumption → Signal map with validation approach for each critical assumption.

---

## Save output

Offer to save the assumption map and validation plan. **Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask "Which project does this belong to? (or type `new`)". Save to `{project_path}/YYMMDD-assumption-map.md`.
