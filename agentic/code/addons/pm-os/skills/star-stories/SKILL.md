---
name: star-stories
description: >-
  Use when a vague work experience needs to become a tellable interview
  story — a raw achievement plus role, team and timeframe in, a polished
  Situation-Task-Action-Result story out, quantified, with your agency
  clear. Called by `pm-interview` Step 3 to build the stories its
  behavioral questions need. Not for anticipating the questions themselves
  (`pm-interview`), the résumé bullets (`resume`), or a written portfolio
  artifact (`work-sample`).
---

# Turn a vague experience into a quantified STAR story

## Step 1 — Ask 3-5 clarifying questions

Read the raw input, then pick the 3-5 questions from this bank that the input most needs. Ask them together, once.

- Baseline and target — problem magnitude and goal (users affected, revenue at risk, cycle time, NPS, crash rate)
- Stakeholders — Engineering, Design, Data, Sales, CS, Legal, and how you influenced them without authority
- Constraints and trade-offs — timeline, headcount, tech debt, compliance, platform limits
- Metrics moved — activation, retention, conversion, LTV, MAU/DAU, adoption by segment, and by how much
- Options rejected — what you compared, build vs buy, scope cuts, and why
- Risks and obstacles — what appeared, how you unblocked it
- Validation — user research, experiments, prototypes, telemetry
- What changed — before/after for users and for the business, qualitative feedback, support tickets

Done when 3-5 questions are asked and the answers give you at least one number and one decision you personally made.

## Step 2 — Write the story

Strict format:

- **Situation** — 2-3 sentences: role, company or team, timeframe, the problem
- **Task** — 1-2 sentences: the explicit goal, success criteria, constraints
- **Action** — 3-4 bullets opening on strong verbs: your decisions, trade-offs, influence, cross-functional leadership
- **Result** — 2-3 sentences quantifying impact, covering one user outcome and one business outcome, plus any follow-through or learning

Never invent a number. Where one is unknown, ask for it or give a reasoned estimate marked with `~`, a range, or an order of magnitude. Prefer comparatives (before → after), rates, and time deltas over absolutes. Confidential metrics generalize ("mid-seven-figures ARR"). A failed or mixed initiative states the result and the learning, briefly.

Tone is confident, concise, factual — no clichés. Acknowledge the team, then make your unique contribution unmistakable; for an IC role, lead with influence and decision quality. Use PM terminology precisely without reaching for jargon.

Done when every section meets its sentence or bullet count, both a user outcome and a business outcome appear in the Result, and every number is either sourced or explicitly marked as an estimate.

## Step 3 — Close the gaps

Where data is still missing, leave an explicit `[estimate needed: X]` placeholder in the story rather than a smoothed-over sentence, and end with a single follow-up question covering all of them.

Done when every placeholder is visible in the draft and one consolidated follow-up question is asked.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-star-story-{topic-slug}.md`. Never hand-build the path.
