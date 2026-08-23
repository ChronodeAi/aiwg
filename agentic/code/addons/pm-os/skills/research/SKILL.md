---
name: research
aliases: [research-to-feature]
description: Transform raw interview transcripts into a tested feature hypothesis — from transcript cleanup through JTBD extraction, clustering, hypothesis formation, and experiment design. Use when synthesizing user interviews, deriving jobs-to-be-done, or turning research into feature hypotheses.
---

# /research — Research to Feature

Walk the user through a 5-step research synthesis session. Each step invokes a skill from `skills/`. Pass the output of each step as input to the next. Confirm with the user before advancing unless they request end-to-end.

---

## Before starting

Surface the most relevant frameworks for this workflow. Scan these Knowledge files and note 3-5 that apply to the user's research topic:

- `knowledge/Interview-Questions/` — 100 questions across 6 categories; surface relevant question sets for the research domain
- `knowledge/Frameworks/validation/` — 33 validation frameworks; note any that match the hypothesis type

Present the relevant framework names (not full content) to the user before Step 1. One line each: name + when to use. Ask which, if any, they want applied during the workflow.

### Lenny's Podcast (optional enrichment)

If the `lenny-podcast` MCP server is available, search for podcast episodes relevant to the user's research topic using `search_transcripts`. Look for episodes about the research domain, JTBD methodology, or user research best practices. Surface 1-2 relevant episode titles and guests — offer to pull key quotes if the user wants them woven into the research synthesis.

---

## Step 1: Clean up raw interview transcripts

**Skill:** `transcript-cleanup`
**Folder:** `skills/transcript-cleanup/SKILL.md`

Read and invoke this skill. Goal: take messy, verbatim interview transcripts and produce clean, structured versions with speaker labels, timestamps normalized, and filler removed — ready for analysis.

**Output to carry forward:** Clean interview transcripts.

---

## Step 2: Extract customer insights using JTBD framework

**Skill:** `interview-insights`
**Folder:** `skills/interview-insights/SKILL.md`

Invoke this skill using the clean transcripts from Step 1. Goal: extract structured Jobs-to-be-Done insights — functional, emotional, and social jobs; struggles; workarounds; desired outcomes.

**Output to carry forward:** JTBD insight set per interview, tagged by job type and intensity.

---

## Step 3: Cluster JTBD forces

**Skill:** `jtbd-forces`
**Folder:** `skills/jtbd-forces/SKILL.md`

Invoke this skill using the JTBD insights from Step 2. Goal: cluster forces of progress (push, pull, anxiety, inertia) across interviews to reveal the strongest demand signals.

**Output to carry forward:** Clustered JTBD forces map showing dominant pushes, pulls, anxieties, and habits across participants.

---

## Step 4: Create structured product hypotheses

**Skill:** `product-hypothesis`
**Folder:** `skills/product-hypothesis/SKILL.md`

Invoke this skill using the clustered forces from Step 3. Goal: translate the dominant demand signals into 1–3 structured product hypotheses, each with a measurable success clause: "Currently, [user] is experiencing [problem]. We believe that by [change], we'll see [outcome]. We'll know we're right when [metric] changes by [amount]."

**Output to carry forward:** 1–3 testable product hypotheses, each with a measurement plan, ranked by confidence and impact.

---

## Step 5: Design robust experiments

**Skill:** `experiment-design`
**Folder:** `skills/experiment-design/SKILL.md`

Invoke this skill using the product hypotheses from Step 4. Goal: design the minimum viable experiment to test each hypothesis — method, metric, minimum detectable effect, sample size, stop/scale rules.

**Output:** Experiment designs (1 per hypothesis) with full test plans.

---

## Save output

Offer to save the full research synthesis and experiment plan. **Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask "Which project does this belong to? (or type `new`)". Save to `{project_path}/YYMMDD-research-synthesis.md`.
