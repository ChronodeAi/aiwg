---
name: core-strategy-development
description: Build a grounded product strategy from first principles — from identifying the strategic crux through competitive analysis to a limit-based strategy and value chain map. Use when developing product strategy, identifying the strategic crux, or doing competitive analysis.
---

# /strategy — Core Strategy Development

Walk the user through a 4-step strategy build. Each step invokes a skill from `skills/`. Pass the output of each step as input to the next. Confirm with the user before advancing unless they request end-to-end.

---

## Before starting

Surface the most relevant frameworks for this workflow. Scan these Knowledge files and note 3-5 that apply to the user's situation:

- `knowledge/Prioritization/` — scan tag metadata for frameworks matching the user's strategic context
- `knowledge/Frameworks/discovery/strategy-kernel.md` — if strategy formation is involved
- `knowledge/Frameworks/discovery/` — broader discovery frameworks for competitive positioning

Present the relevant framework names (not full content) to the user before Step 0. One line each: name + when to use. Ask which, if any, they want applied during the workflow.

### Lenny's Podcast (optional enrichment)

If the `lenny-podcast` MCP server is available, search for podcast episodes relevant to the user's strategic context using `search_transcripts`. Look for episodes about the user's industry, competitive dynamics, or strategy approach. Surface 1-2 relevant episode titles and guests — offer to pull key quotes if the user wants them woven into the strategy work.

---

## Step 0: Find the strategic crux

**Skill:** `find-the-strategic-crux`
**Folder:** `skills/find-the-strategic-crux/SKILL.md`

Read and invoke this skill. Goal: surface the pivotal obstacle between today's state and the desired future. This becomes the anchor for all subsequent strategy work. The skill stops at the crux inside this workflow — its own option-generation and recommendation steps are what Steps 1b–2 below do with fuller context.

**Output to carry forward:** Identified crux + current state / desired future framing + key constraints.

---

## Step 1: Competitive analysis + structured product strategy

Run both skills at this step. They are complementary — competitive analysis provides external grounding; the structured strategy skill uses that alongside the crux to build the initial strategy frame.

### Step 1a: NETMBA competitor analysis

**Skill:** `netmba-competitor-analysis`
**Folder:** `skills/netmba-competitor-analysis/SKILL.md`

Invoke this skill using the crux and context from Step 0. Goal: tear down the competitor most relevant to the crux on Porter's four components — objectives, current strategy, assumptions, capabilities — and read those into their likely moves.

**Output to carry forward:** Likely-moves matrix + the differentiation gaps those moves leave open.

### Step 1b: Create a structured product strategy

**Skill:** `product-strategy`
**Folder:** `skills/product-strategy/SKILL.md`

Invoke this skill using Step 0 crux + Step 1a competitor analysis. Goal: produce an initial structured strategy document.

**Output to carry forward:** Strategy document draft (vision, positioning, guiding policy).

---

## Step 2: Limit-based strategy

**Skill:** `limit-strategy`
**Folder:** `skills/limit-strategy/SKILL.md`

Invoke this skill using the strategy draft from Step 1b and the crux from Step 0. Goal: sharpen the strategy by working through constraint-imposed choices to an execution plan.

**Output to carry forward:** Limit-based strategy with execution moves.

---

## Step 3: Value chain mapping

**Skill:** `value-chain`
**Folder:** `skills/value-chain/SKILL.md`

Invoke this skill using the strategy from Steps 1–2. Goal: map value chain from end-user needs to core value generators, confirming the strategy targets the right leverage points.

**Output:** Final value chain map + annotated strategy with value flow.

---

## Save output

Offer to save the full strategy. **Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask "Which project does this belong to? (or type `new`)". Save to `{project_path}/YYMMDD-strategy.md`.
