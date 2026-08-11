---
name: meeting-prep
description: >-
  Use when you're walking into a genuinely adversarial meeting — stakeholders
  who are skeptical, tough, possibly unfair — and need to survive their
  hardest questions before you're in the room. Also /stakeholder Step 5,
  taking the comms plan and risk register as input. Not for a fast field-read
  on friendlier room dynamics (`prep-the-room`), the general pre-meeting
  brief (`meeting-outcomes`), or the difficult-conversation script itself
  (`difficult-conversation`).
---

# Prep for a challenging meeting

The value of this drill is in not softening the audience. Prep for the room you're actually walking into — tough, skeptical, maybe unfair — not the easier one you'd prefer.

Inside `/stakeholder` this is Step 5: the comms plan and risk register from Steps 3–4 come in.

## Step 1 — Set the room's temperature

Name the stakeholders, adopt their actual posture — tough, possibly unfair, unfamiliar with your work, skeptical of your goals — and state what you want from them by the end. Don't soften the posture into an easy audience; the value here is stress-testing against the worst case.

Done when the stakeholders are named, their posture is stated as genuinely adversarial, and the desired outcome is named.

## Step 2 — Generate the hardest questions

Write at least 20 questions this audience could plausibly ask — covering financial impact, resource allocation, timeline, risk, competitive landscape, technical feasibility, past failures, and strategic alignment. Include the ones that feel personal or unfair; that's the point of the exercise.

Done when at least 20 questions are listed spanning at least five distinct angles.

## Step 3 — Draft the answer to the hardest three

Pick the three hardest questions from Step 2 and write the actual answer you'd give — not a category of answer, the words. An answer you can't draft yet is the real prep gap this exercise found.

Done when three questions have drafted answers, and any unanswerable one is named as a gap rather than skipped.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-meeting-prep-{meeting-slug}.md`. Never hand-build the path.

The doc holds: the stakeholders and desired outcome, the full question list, and the drafted answers to the three hardest with any named gap.
