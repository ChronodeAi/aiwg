---
name: make-great-decisions
description: Make high-quality product decisions by working through root causes, classifying reversibility, journaling the decision, structuring the problem, synthesizing recommendations, and defining decision rights. Use when making a tradeoff, classifying reversibility, or running a structured decision audit.
---

# /decisions — Make Great Decisions

Walk the user through a 6-step decision-making session. Each step invokes a skill from `skills/`. Pass the output of each step as input to the next. Confirm with the user before advancing unless they request end-to-end.

---

## Before starting

Surface the most relevant frameworks for this workflow. Scan these Knowledge files and note 3-5 that apply to the user's decision:

- `knowledge/Prioritization/pivot-triggers.md` — if the decision involves whether to pivot or persevere
- `knowledge/Prioritization/` — scan tag metadata for frameworks matching the decision type (reversibility, trade-offs, resource allocation)

Present the relevant framework names (not full content) to the user before Step 1. One line each: name + when to use. Ask which, if any, they want applied during the workflow.

---

## Step 1: Analyze root causes and consequences

**Skill:** `causal-tree`
**Folder:** `skills/causal-tree/SKILL.md`

Read and invoke this skill. Goal: build a rigorous causal map — work backwards from the presenting problem to identify root causes, and work forwards to trace consequences of each option.

**Output to carry forward:** Root cause map + consequence tree for the decision at hand.

---

## Step 2: Classify the decision as reversible or permanent

**Skill:** `two-way-door`
**Folder:** `skills/two-way-door/SKILL.md`

Invoke this skill using the root cause map from Step 1. Goal: classify the decision on the reversibility spectrum (Type 1 vs Type 2) from first principles — this determines how much deliberation is warranted and what process to use.

**Output to carry forward:** Reversibility classification + recommended decision process (fast/solo vs slow/collaborative).

---

## Step 3: Create a structured decision journal entry

**Skill:** `decision-journal`
**Folder:** `skills/decision-journal/SKILL.md`

Invoke this skill using the causal map and classification from Steps 1–2. Goal: write a structured decision journal entry capturing the decision, reasoning, expected outcomes, and success criteria — creating accountability and enabling future review.

**Output to carry forward:** Decision journal entry draft.

---

## Step 4: MECE analysis

**Skill:** `mece-tree`
**Folder:** `skills/mece-tree/SKILL.md`

Invoke this skill using the options identified in Steps 1–2. Goal: ensure the option space is Mutually Exclusive, Collectively Exhaustive — no overlaps, no gaps. Build a logical tree to expose hidden options or collapsed distinctions.

**Output to carry forward:** MECE option tree.

---

## Step 5: Structure complex problems into actionable recommendations

**Skill:** `structure-problem`
**Folder:** `skills/structure-problem/SKILL.md`

Invoke this skill using the MECE option tree from Step 4 and the causal map from Step 1. Goal: synthesize all analysis into a clear, pyramid-structured recommendation with the top answer stated first, then supporting logic.

**Output to carry forward:** Structured recommendation (Pyramid Principle format).

---

## Step 6: Define decision rights using DAVCI

**Skill:** `davci`
**Folder:** `skills/davci/SKILL.md`

Invoke this skill using the recommendation from Step 5. Goal: clarify who Decides, Approves, Vetoes, is Consulted, and is Informed — preventing ambiguity about ownership before the decision is communicated.

**Output:** Decision + DAVCI matrix + communication plan.

---

## Save output

Offer to save the full decision analysis and journal entry. **Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask "Which project does this belong to? (or type `new`)". Save to `{project_path}/YYMMDD-decision-title.md`.
