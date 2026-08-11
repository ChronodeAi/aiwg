---
name: meeting-outcomes
description: >-
  Use when you need a full pre-meeting brief before a cross-functional or
  peer meeting — the decision it's meant to produce, who's in the room and
  what they want, a time-boxed agenda, and whether a meeting is even the
  right format. Not for objection-handling prep on a specific adversarial
  stakeholder meeting (`meeting-prep`), a fast field-read on the people in
  the room (`prep-the-room`), or the post-meeting summary (`meeting-summary`).
---

# Turn a scattered meeting plan into a brief

## Step 1 — Decide whether to meet at all

State the primary outcome wanted (max 2: discover / share / align / decide / unblock / negotiate) and whether a decision is needed, with the exact decider named. If nothing here actually requires synchronous conversation, stop and hand back an async plan — doc plus comments, a short recording, or a decision poll — instead of an agenda.

Done when the outcome and decision-need are stated, or the async alternative is delivered instead of a meeting.

## Step 2 — Map who's in the room

For each attendee: their interest, their influence (high/medium/low), and what they're likely to object to. Flag it — don't footnote it — if the actual decision-maker isn't invited.

Done when every attendee has interest, influence, and objection noted, and any missing decider is flagged.

## Step 3 — Build the time-boxed agenda

Sequence: frame the goal, key info to share (max 3 points), discovery questions (top 3), discussion toward the decision, then confirm decisions/owners/dates in the final minutes — or an explicit "no next steps" closure. When time is short and the request is really just "write me an agenda," skip straight to this step from a plain description.

Done when every agenda block has a time allocation and the close is either owners-and-dates or a stated no-next-steps reason.

## Step 4 — Write the follow-up email

Draft the send-after email: objective recap, what was covered, decisions with owner and due date, open items, and the next checkpoint.

Done when every decision and open item in the email has an owner and a date.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-meeting-outcomes-{meeting-slug}.md`. Never hand-build the path.

The doc holds: the outcome and decision-need (or the async alternative), the stakeholder map, the time-boxed agenda, and the follow-up email draft.
