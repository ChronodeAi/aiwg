---
name: prd-construction
description: Build a complete PRD end-to-end — from raw inputs (transcript, design, research) through use cases, user stories, and acceptance criteria to a drafted PRD reviewed by 9 specialised reviewers (2 PRD-specific personas + 7 cross-functional). Use when you need a full PRD, not just a one-shot draft.
---

# /prd — PRD Construction

Walk the user through a 9-step PRD build. Each step invokes a skill or subagent from PM OS. Pass the output of each step as input to the next. Confirm with the user before advancing unless they request end-to-end.

If the user just wants a one-shot draft from already-structured requirements, point them at `prd-draft` and stop. Use this workflow when raw inputs need to become a decision-ready, multi-reviewed PRD.

---

## Subagent execution contract

The review phase (Steps 7–8) is backed by read-only reviewer subagents:

| Step | Lens | Subagent |
|---|---|---|
| 7 | PRD strengths (optimist) | `prd-strengths-reviewer` |
| 7 | PRD flaws (critic) | `prd-flaws-reviewer` |
| 8 | Engineering | `engineering-reviewer` |
| 8 | Design | `design-reviewer` |
| 8 | Executive | `executive-reviewer` |
| 8 | Legal | `legal-risk-reviewer` |
| 8 | UX Research | `ux-research-reviewer` |
| 8 | Devil's Advocate | `devils-advocate-reviewer` |
| 8 | Customer Voice | `customer-voice-reviewer` |

Use these subagents when the environment supports native subagent invocation, including OpenAI Codex project agents. Dispatch independent reviewers in parallel. If subagents are unavailable, run each perspective inline using the persona prose in the corresponding agent file (`agents/<name>.md`).

Every subagent returns:

```text
STATUS: done | partial | blocked
SCOPE: PRD sections reviewed
FINDINGS: severity-ranked bullets with evidence
OPEN_QUESTIONS: blockers only
RECOMMENDED_NEXT_ACTION: one action or none
```

The parent agent owns user interaction, step sequencing, optional synthesis, and save confirmation.

---

## Before starting

Surface the most relevant frameworks and assets:

- `templates/` — 7 PRD formats; offer one for the drafting step
- `examples/` — example PRDs to calibrate quality
- `knowledge/Frameworks/build/` — building/scoping frameworks
- `knowledge/Frameworks/validation/` — for the acceptance-criteria step

One line each: name + when to use. Ask which, if any, the user wants applied.

---

## Step 1: Pick the input mode

Ask which input the user has. Run one (or more) of:

### 1a. Conversation transcript → requirements
**Skill:** `requirements-from-talk`
**Folder:** `skills/requirements-from-talk/SKILL.md`

Use when the user has a meeting transcript or interview notes and needs structured requirements extracted.

### 1b. Design asset → requirements
**Skill:** `requirements-from-design`
**Folder:** `skills/requirements-from-design/SKILL.md`

Use when the user has wireframes, mockups, or a Figma file and needs requirements reverse-engineered from the design.

### 1c. Research → use cases
**Skill:** `use-cases`
**Folder:** `skills/use-cases/SKILL.md`

Use when the user has research notes or an idea and needs Cockburn-style use cases as the foundation. If picked here, skip Step 3.

**Output to carry forward:** structured requirements or use cases.

---

## Step 2: Reconcile conflicts (optional)

**Skill:** `requirements-reconcile`
**Folder:** `skills/requirements-reconcile/SKILL.md`

Only run if multiple stakeholders provided conflicting input. Skip otherwise.

**Output to carry forward:** unified requirements with conflicts resolved.

---

## Step 3: Generate use cases

Skip if Step 1c already produced use cases. Otherwise re-invoke the `use-cases` skill (canonical file referenced in Step 1c) to turn the requirements into Cockburn-style use cases (who does what and why).

**Output to carry forward:** prioritized use case list.

---

## Step 4: Write user stories

Pick one of:

### 4a. Basic user stories
**Skill:** `user-stories`
**Folder:** `skills/user-stories/SKILL.md`

Use for agile-style role-goal-benefit user stories.

### 4b. User stories with Gherkin acceptance criteria
**Skill:** `gherkin-stories`
**Folder:** `skills/gherkin-stories/SKILL.md`

Use when the team wants INVEST-compliant stories with embedded Given/When/Then acceptance criteria.

**Output to carry forward:** atomic user stories tied to use cases.

---

## Step 5: UI acceptance criteria

**Skill:** `ui-acceptance-criteria`
**Folder:** `skills/ui-acceptance-criteria/SKILL.md`

Only run when the PRD has UI scope. Translates stories into testable, measurable specifications covering all UI states, breakpoints, and edge cases.

**Output to carry forward:** UI acceptance criteria QA can validate without ambiguity.

---

## Step 6: Draft the PRD

**Skill:** `prd-draft`
**Folder:** `skills/prd-draft/SKILL.md`

Assemble everything from Steps 1–5 into a comprehensive PRD using one of the `templates/` formats. Offer to read an example from `examples/` first to calibrate quality.

**Output to carry forward:** drafted PRD ready for review.

---

## Step 7: Two-lens PRD review (parallel)

Dispatch both subagents in parallel against the drafted PRD. They are PRD-specialised reviewers — fast, in-context-aware, paired by design.

### 7a. PRD strengths review
**Subagent:** `prd-strengths-reviewer`
**Agent file:** `agents/prd-strengths-reviewer.md`

Optimist lens — surfaces positives, simplicity/systems-thinking, constructive suggestions, and concerns flagged with proposed mitigations.

### 7b. PRD flaws review
**Subagent:** `prd-flaws-reviewer`
**Agent file:** `agents/prd-flaws-reviewer.md`

Critic lens — finds every flaw, inconsistency, maintainability risk, and strategic pitfall. Harsh, nitpicky, evidence-grounded.

Present the contrast: where do the optimist and critic agree? Where do they diverge? The agreements are reliable signals; the divergences are choices for the PM.

**Output to carry forward:** contrasted findings + draft revision priorities.

---

## Step 8: Cross-functional review (parallel, optional)

After Step 7, ask the user:

> "I can also dispatch the 7 cross-functional reviewers — Engineering, Design, Executive, Legal, UX Research, Devil's Advocate, and Customer Voice. Each runs in its own context against the PRD and returns structured findings. Want all 7, a specific subset, or skip this step?"

Wait for the user's answer. If they pick subagents, dispatch the selected set in parallel:

### 8a. Engineering perspective
**Subagent:** `engineering-reviewer`
**Agent file:** `agents/engineering-reviewer.md`

Feasibility, complexity, dependencies, scale, edge cases, maintenance burden.

### 8b. Design perspective
**Subagent:** `design-reviewer`
**Agent file:** `agents/design-reviewer.md`

User experience, states, accessibility, consistency, information architecture.

### 8c. Executive perspective
**Subagent:** `executive-reviewer`
**Agent file:** `agents/executive-reviewer.md`

Strategic alignment, business impact, resource allocation, market positioning, risk.

### 8d. Legal perspective
**Subagent:** `legal-risk-reviewer`
**Agent file:** `agents/legal-risk-reviewer.md`

Privacy, compliance, terms, IP/licensing, security.

### 8e. UX Research perspective
**Subagent:** `ux-research-reviewer`
**Agent file:** `agents/ux-research-reviewer.md`

Research foundation, assumption inventory, segmentation, validation gaps, JTBD.

### 8f. Devil's Advocate perspective
**Subagent:** `devils-advocate-reviewer`
**Agent file:** `agents/devils-advocate-reviewer.md`

Challenges problem framing, solution choice, metric validity, assumption robustness.

### 8g. Customer Voice perspective
**Subagent:** `customer-voice-reviewer`
**Agent file:** `agents/customer-voice-reviewer.md`

The target user's first-person reaction — value, learnability, daily-use friction, comparison to alternatives, emotional response.

**Output to carry forward:** structured findings from each dispatched reviewer.

---

## Step 9: Synthesis (gated)

After Steps 7 and 8, ask:

> "All review perspectives are done — 2 PRD-specific and [N] cross-functional. Would you like me to synthesise the findings into a consolidated revision plan? This would surface: convergent findings (flagged by multiple reviewers), conflicting perspectives (where reviewers disagree), and a prioritised list of items to address."

**Only proceed with synthesis if the user explicitly says yes.**

If confirmed, produce:

### Convergent findings
Issues flagged by 2+ reviewers. These are high-priority — multiple lenses independently identified the same concern.

### Conflicting perspectives
Where reviewers disagree. State both positions clearly. Do not resolve the conflict — that's the PM's job. Note the trade-off.

### Prioritised action items
Rank by severity:
1. **Blockers** — Must address before proceeding
2. **Important gaps** — Should address before launch
3. **Enhancements** — Consider for v1 or defer to v2

### Open questions
Consolidate all "questions for the author" surfaced by reviewers that weren't answered during the session.

---

## Save destination

**Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this PRD belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask at save time: "Which project does this belong to? (or type `new` to create one)". Save the final PRD and review notes to `{project_path}/YYMMDD-prd-*.md`.
