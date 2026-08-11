---
name: stakeholder-copilot
description: Navigate stakeholder complexity end-to-end — from power mapping and risk review through message framing, challenging meeting prep, difficult conversations, and executive presence review. Use when mapping power dynamics, planning influence strategy, or navigating organizational politics.
---

# /stakeholder — Stakeholder & Politics Copilot

Walk the user through a 7-step stakeholder management session. Each step invokes a skill from `skills/`. Pass the output of each step as input to the next. Confirm with the user before advancing unless they request end-to-end.

---

## Fast path — are you under pressure right now?

The 7-step session below is for **planful** stakeholder work. If the user is in an acute moment, route to the matching operating skill first; return to the full flow only if they then want to plan.

- "should I fight this / escalate / push back on this decision / go over someone's head?" → **pick-your-battles** (`skills/pick-your-battles/SKILL.md`) — a GO/NO-GO with a capital budget *before* sinking effort into mapping and comms.
- "this just happened / I just got bad feedback / someone's being difficult right now" → **respond-under-fire** (`skills/respond-under-fire/SKILL.md`) — triage plus an immediate script. The reactive counterpart to Step 6's planful `difficult-conversation`.
- "I need to commit a date / write the exec update / leadership wants this template filled in / contain this process" → **manage-the-upward-channel** (`skills/manage-the-upward-channel/SKILL.md`) — a two-date plan, an optics artifact, or a containment setup. The upward-comms counterpart to Step 7's `exec-update-review`.

These operating skills advise and draft only — they never send, escalate, or execute a move on the user's behalf. If none apply, proceed with the deliberate session below.

---

## Before starting

Surface the most relevant frameworks for this workflow. Scan these Knowledge files and note 3-5 that apply to the user's stakeholder situation:

- `knowledge/Frameworks/` — scan for frameworks related to influence, communication, and organizational dynamics

Present the relevant framework names (not full content) to the user before Step 1. One line each: name + when to use. Ask which, if any, they want applied during the workflow.

---

## Before Step 1: Load stakeholder context

Read `📂 Context/STAKEHOLDERS.md` if it exists. If it contains filled-in profiles (real names and priorities, not just `[Stakeholder name]` placeholders), use that data to pre-populate Step 1's power dynamics map — don't ask the user to re-enter information they've already provided. Name stakeholders by their real names and reference their communication preferences, decision styles, and priorities throughout all 7 steps.

If the file is absent or contains only placeholders, proceed with Step 1 as normal (the skill will gather stakeholder context from the user).

---

## Step 1: Map power dynamics before meetings

**Skill:** `power-map`
**Folder:** `skills/power-map/SKILL.md`

Read and invoke this skill. Goal: understand who has formal authority, informal influence, and decision-making power in the relevant stakeholder system before taking any action.

**Output to carry forward:** Power dynamics map — stakeholders, their incentives, relationships, and influence pathways.

---

## Step 2: Stakeholder Power-Interest & Influence Map

**Skill:** `stakeholder-map`
**Folder:** `skills/stakeholder-map/SKILL.md`

Invoke this skill using the power dynamics map from Step 1. Goal: plot stakeholders on a Power-Interest grid and add an influence layer — determining who to manage closely, keep satisfied, keep informed, or monitor.

**Output to carry forward:** Power-Interest-Influence map with engagement strategy per quadrant.

---

## Step 3: Stakeholder risk review

**Skill:** `stakeholder-risk`
**Folder:** `skills/stakeholder-risk/SKILL.md`

Invoke this skill using the stakeholder map from Step 2 and the feature or decision at hand. Goal: identify which stakeholders pose the highest risk of blocking, reframing, or derailing the work — and pre-plan mitigations.

**Output to carry forward:** Stakeholder risk register with mitigation moves.

---

## Step 4: Message framing and comms plan

**Skill:** `comms-plan`
**Folder:** `skills/comms-plan/SKILL.md`

Invoke this skill using the stakeholder map and risk register from Steps 2–3. Goal: pick a frame, draft the message for both ICs and execs in the user's voice, then build the sequenced comms plan around it — channels in order, an owner and timing per step, what to leave out, and the success signals that say it landed.

**Writing style note:** After the comms plan is drafted, reference `knowledge/Writing-Styles/` to match tone to the audience for each message:
- Executive / board / VP → `writing-style-executive.md`
- Internal team / colleagues → `writing-style-internal.md`
- Customers / external users → `writing-style-customer.md`
- Engineers / developers → `writing-style-technical.md`

**Output to carry forward:** Audience-specific message drafts plus a sequenced comms plan (step, channel, owner, timing, emphasis, CTA), an omit list, and three success signals.

---

## Step 5: Prepare for a challenging meeting

**Skill:** `meeting-prep`
**Folder:** `skills/meeting-prep/SKILL.md`

Invoke this skill using the comms plan and risk register from Steps 3–4. Goal: walk through the meeting scenario — anticipated objections, counter-arguments, room dynamics, and desired outcomes — so the user enters the meeting prepared.

**Output to carry forward:** Meeting preparation brief with objection handling and desired outcomes.

---

## Step 6: Difficult conversation script

**Skill:** `difficult-conversation`
**Folder:** `skills/difficult-conversation/SKILL.md`

Invoke this skill when a specific difficult conversation needs to be scripted. Use the meeting prep from Step 5 as context. Goal: write a structured script using the 5-step framework (open, explore, share, problem-solve, close) for the hardest conversation the user is anticipating.

**Output to carry forward:** Conversation script.

---

## Step 7: Executive update review

**Skill:** `exec-update-review`
**Folder:** `skills/exec-update-review/SKILL.md`

Invoke this skill once the user has drafted the update or deck outline this session's work leads to — before you deliver it, not after. Goal: read the draft as a senior exec would, rewrite the TL;DR down to what I want / why now / what changes, diagnose the vagueness, hedging, and buried leads line by line, and script the three minutes of speaking notes.

**Output:** A three-bullet TL;DR, an issue→fix table on the draft's own lines, a ≤200-word core rewrite, three-minute speaking notes, and the one-slide exec summary layout.

---

## Save output

Offer to save the stakeholder plan and comms strategy. **Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask "Which project does this belong to? (or type `new`)". Save to `{project_path}/YYMMDD-stakeholder-plan.md`.
