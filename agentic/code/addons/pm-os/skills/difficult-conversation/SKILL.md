---
name: difficult-conversation
description: >-
  Use when you need to produce a one-page prep doc, provide calm opening
  lines and questions, anticipate reactions with de-escalation responses,
  and close with clear next steps for a planned hard conversation. Also
  `/stakeholder` Step 6, following Step 5's `meeting-prep` brief. Not for a
  reactive incident that just happened (`respond-under-fire`), a fast
  field-read before any interaction (`prep-the-room`), or scripting a public
  outage update (`crisis-comms`).
---

# Script a planned difficult conversation

## Step 1 — Take the situation and prepare

Get the situation, the goal, the power dynamics, and what's worrying the user. Write prep notes: intent, non-negotiables, specific facts/examples, language traps to avoid, desired outcome, success criteria, and the right medium (in-person/video/async).

Done when intent, non-negotiables, desired outcome, and medium are all stated.

## Step 2 — Write openers and questions

Draft 3–5 opening lines: neutral, non-accusatory, tied to concrete impact, inviting their perspective. Write 5–7 questions using open what/how/when framing (never "why") — include one perspective-taking question and one constraints question.

Done when every opener avoids blame language and every question is open-ended, not why-framed.

## Step 3 — Anticipate reactions

For each likely reaction (denial, deflection, becoming emotional, counter-accusation), write the de-escalating response as a Reaction → Response table.

Done when every plausible reaction has a scripted, de-escalating response.

## Step 4 — Close and set next steps

Write a shared-goals statement, the options with trade-offs, the agreed commitments, an owner and timeline, and a follow-up check-in. Add a short self-management checklist (breathing, pace, pauses) and flag if the situation needs HR/compliance escalation.

Done when next steps have an owner and timeline, and any escalation need is explicitly flagged or ruled out.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-difficult-conversation-{topic-slug}.md`. Never hand-build the path.

The doc holds: the prep notes, openers, questions, the reaction/response table, the close and next steps, and the self-management checklist.
