---
name: meeting-mastery
description: Run high-impact meetings — surface hidden agendas before, apply influence principles during, and capture structured summaries after. Use when preparing a meeting agenda, summarizing a meeting, or preparing influence tactics.
---

# /meeting — Meeting Mastery

Walk the user through a standalone 3-step meeting session. Each step invokes a skill from `skills/`. Confirm with the user before advancing unless they request end-to-end.

## Fast path — imminent or already on fire?

The 3-step flow below is for deliberate prep. If the user is short on time or reacting to something live, route first:

- "prep me for this meeting / I'm walking in / I have a review with my VP in an hour / help me get ready for this 1:1" → **prep-the-room** (`skills/prep-the-room/SKILL.md`) — a fast read on the actors, a stance, opening moves, and what not to do. Stands alone, or feeds Step 1's `hidden-agendas`.
- "the meeting just went sideways / I got blindsided / someone snapped at me in the room" → **respond-under-fire** (`skills/respond-under-fire/SKILL.md`) — triage plus an immediate script.

These advise and draft only; they never send or act on the user's behalf. Otherwise, proceed with the full prep sequence below.

## Before Step 1: Load stakeholder context

Read `📂 Context/STAKEHOLDERS.md` if it exists. If it contains filled-in profiles (real names and priorities, not just `[Stakeholder name]` placeholders), identify which attendees appear in the profiles and use their communication preferences, decision styles, and priorities to inform Steps 1 and 2. Reference them by name throughout.

If the file is absent or contains only placeholders, proceed normally — the skills will gather context from the user.

---

## Step 1: Identify potential hidden agendas

**Skill:** `hidden-agendas`
**Folder:** `skills/hidden-agendas/SKILL.md`

Read and invoke this skill. Goal: surface what each attendee likely wants from the meeting beyond the stated agenda — their real objectives, fears, and motivations — so the user can navigate rather than react.

**Output to carry forward:** Hidden agenda map per key attendee with likely underlying motivations.

---

## Step 2: Apply Cialdini's influence principles

**Skill:** `cialdini`
**Folder:** `skills/cialdini/SKILL.md`

Invoke this skill using the hidden agenda map from Step 1. Goal: design influence strategies using Cialdini's 7 principles (reciprocity, commitment, social proof, authority, liking, scarcity, unity) tailored to each key attendee.

**Output to carry forward:** Influence strategy per attendee with specific tactics.

---

## Step 3: Create a structured meeting summary

**Skill:** `meeting-summary`
**Folder:** `skills/meeting-summary/SKILL.md`

Invoke this skill after the meeting using the transcript or notes provided by the user. Goal: apply the IDEAS framework (Insights, Decisions, Engagements, Actions, Summary) to produce a structured, actionable meeting summary.

**Output:** Meeting summary in IDEAS format with owners and deadlines for all actions.

---

## Save output

Offer to save the meeting summary. **Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask "Which project does this belong to? (or type `new`)". Save to `{project_path}/YYMMDD-meeting-summary.md`.
