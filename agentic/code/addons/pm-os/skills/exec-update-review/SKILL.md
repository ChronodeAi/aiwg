---
name: exec-update-review
description: >-
  Use when an update or deck outline is drafted and needs a senior exec's read *before* you deliver it — a three-bullet TL;DR rewrite, an issue→fix pass over the vagueness and hedging, a clean narrative, and three-minute speaking notes. Also /stakeholder Step 7. Not for writing the update from scratch (`status-update`), planning the multi-channel rollout around it (`comms-plan`), or stress-testing an investment case against the objections it will meet (`exec-deck`).
---

# Review a draft update as a senior exec

Read the draft the way an exec with eleven minutes and four other topics reads it. They are looking for the ask. Everything that delays them finding it is the defect.

## Step 1 — Take the draft and the room

Get the draft update or deck outline, who is in the room, how long the slot is, and what decision or resource the user actually wants out of it. An update with no ask is the first thing to name — say so before reviewing anything else.

Done when the draft is in hand and the ask is one sentence naming a decision, a resource, or a date.

## Step 2 — Rewrite the TL;DR in three bullets

Replace whatever opens the draft with exactly three: **what I want**, **why now**, **what changes**. If any of the three cannot be filled from the draft's own content, that gap is the review's headline finding.

Done when three bullets exist, each under twenty words, and the first one states the ask.

## Step 3 — Diagnose issue by issue

Work the draft with issue → fix callouts, covering the five recurring failures: vagueness, defensiveness, a buried lead, over-detail, and a missing risk or ask. Quote the offending line for each. Replace hedging and passive voice with firm phrasing the user could still defend under challenge — confidence that outruns the evidence gets found out in the room.

Done when every issue names the quoted line and its concrete fix, and the draft's own words appear in each callout.

## Step 4 — Rebuild the narrative and the core section

Restructure to hook, stakes, options with trade-offs, recommendation, ask. Then rewrite the draft's core section in ≤200 words of plain language, connecting the work to a business goal the room already cares about and ending on a visible next action.

Done when the rewrite is under 200 words, follows the five-part arc, and closes on a named next action with an owner.

## Step 5 — Script the three minutes

Write speaking notes: opening 15 seconds, body 2 minutes 30, close 15 seconds. Include one story or data point, one risk stated before anyone else raises it, and one clear ask. Then cut the deck — what to merge, what to drop, and a one-slide exec summary layout that would work alone if the meeting ran short.

Done when the notes fit three minutes read aloud, the risk is volunteered rather than defended, and the one-slide layout carries the ask without the rest of the deck.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-update-review-{topic-slug}.md`. Never hand-build the path.

The doc holds: the three-bullet TL;DR, the issue→fix table with quoted lines, the narrative structure, the core rewrite, the three-minute speaking notes, and the slide economy with the one-slide layout.
