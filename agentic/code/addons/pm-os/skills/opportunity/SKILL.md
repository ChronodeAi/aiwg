---
name: opportunity
aliases: [opportunity-mapping]
description: Map product opportunities systematically — from structured OST intake through opportunity tree construction, optional MECE refinement, to selecting one prioritized target opportunity. Use when mapping product opportunities, building an opportunity solution tree, or selecting initiatives to pursue.
---

# /opportunity — Opportunity Mapping

Walk the user through a 3-step opportunity mapping session. Each core step invokes a skill from `skills/`. Pass the output of each step as input to the next. Confirm with the user before advancing unless they request end-to-end.

**Optional between Steps 2 and 3:** Offer a MECE pass when sibling opportunities overlap, coverage gaps are suspected, or the team wants a formal mutually exclusive / collectively exhaustive check before prioritization. The OST skills use Torres-style distinctness but do not run the MECE skill.

---

## Before starting

Surface the most relevant frameworks for this workflow. Scan these Knowledge files and note 3-5 that apply to the user's opportunity space:

- `knowledge/Frameworks/discovery/` — 69 discovery frameworks; surface those relevant to opportunity identification and sizing
- `knowledge/Prioritization/` — scan tag metadata for frameworks matching the user's prioritization needs

Present the relevant framework names (not full content) to the user before Step 1. One line each: name + when to use. Ask which, if any, they want applied during the workflow.

---

## Step 1: Interactive OST intake

**Skill:** `ost-intake`
**Folder:** `skills/ost-intake/SKILL.md`

Read and invoke this skill. Goal: elicit and normalize the four inputs an Opportunity Solution Tree needs — the business outcome, the journey nodes (moments in time), the interview material, and any constraints.

**Output to carry forward:** The confirmed four-variable block (`business_outcome`, `journey_nodes_as_list`, `interview_transcripts_or_story_snippets`, `constraints_or_principles`).

---

## Step 2: Build the Opportunity Solution Tree

**Skill:** `ost`
**Folder:** `skills/ost/SKILL.md`

Invoke this skill using the four variables from Step 1. Goal: construct the OST — the outcome at the top, opportunities at the leaves, grouped by moment in time. The tree holds opportunities only; anything a customer voiced as a solution gets reframed into the need beneath it. Solution generation comes after a target is selected in Step 3.

**Output to carry forward:** The opportunity inventory table and the structured OST JSON, with traceability to quotes.

---

## Optional: MECE check on opportunities (between Steps 2 and 3)

**Skill:** `mece-tree`
**Folder:** `skills/mece-tree/SKILL.md`

**When to offer:** Overlapping siblings, suspected gaps in coverage for a branch, or explicit request for a MECE audit before four-factor comparison.

**How:** Extract a flat list of opportunity statements for one slice of the tree (e.g. all siblings under one parent). Invoke this skill with that list. Use its conclusions to refine the OST (split, merge, reframe). If the change is large, consider re-running Step 2.

**Output to carry forward:** Revised OST for Step 3, or the Step 2 OST unchanged if the user skips this step.

---

## Step 3: Prioritize and select one target opportunity

**Skill:** `ost-prioritize`
**Folder:** `skills/ost-prioritize/SKILL.md`

Invoke this skill using the OST from Step 2, optionally revised after the optional MECE step. Goal: apply Teresa Torres's four-factor framework (opportunity sizing, market factors, company factors, customer factors) to compare candidates qualitatively and select a single target opportunity to explore.

**Output:** Four-factor analysis, compare-and-contrast summary, one target opportunity recommendation with rationale, distinctness check, key unknowns, and next steps.

> **No scoring.** The skill reasons qualitatively by design — Torres treats a weighted formula over these four factors as false precision. It takes the Step 2 OST JSON directly, so no separate mechanical pass is needed.

---

## Save output

Offer to save the OST and selected opportunity. **Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask "Which project does this belong to? (or type `new`)". Save to `{project_path}/YYMMDD-opportunity-map.md`.
