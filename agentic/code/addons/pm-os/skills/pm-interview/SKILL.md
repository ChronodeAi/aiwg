---
name: pm-interview
description: >-
  Use when preparing for a PM interview — a resume, JD, interview context
  (type, focus, duration), and specific concerns in, a tailored set of
  anticipated questions out, each with why it's asked, what's being
  evaluated, and an answer framework. Not for drafting the STAR stories
  those answers rely on (`star-stories`), tailoring the resume itself
  (`resume`), or broader career-direction guidance (`career-guidance`).
---

# Anticipate the questions a PM interview will actually ask

## Step 1 — Gather inputs

Collect the resume, the full JD, and the interview context: type (phone screen, hiring manager, panel, final round), who's interviewing, focus (fit, execution, strategic, behavioral), duration. Note any specific concern — a resume gap, a career transition, a weak area, less experience than required.

Done when resume, JD, interview context, and any named concern are in hand.

## Step 2 — Build the anticipated question set

Generate questions across four sources, each with why it's asked and what's being evaluated:
- **Universal openers** — background, motivation, "why this role"
- **Resume-specific** — a named project, a gap, a transition
- **JD-specific** — their stated problem, their product, their key metric
- **Concern-specific** — a direct question the named concern is likely to trigger

For each, give an answer framework (structure and what to hit) — not a full scripted answer.

Done when every source category has at least one tailored question, and every question has a stated framework, not a script.

## Step 3 — Map stories to behavioral questions

For "tell me about a time..." questions (failure, conflict, prioritization, working with engineers, influence without authority), don't draft the story here — name which of the candidate's real experiences could answer it, then hand off story construction to `star-stories`. Flag if fewer than 5-6 distinct experiences cover the full behavioral set.

Done when every behavioral question has a candidate experience mapped to it, or a gap is flagged.

## Step 4 — Prep questions to ask them

Draft 2-3 questions each about the role, the team, and the company — specific enough to show research, not generic ("what does success look like in the first 90 days" over "what's it like working here").

Done when questions are drafted for all three categories and none is generic enough to ask at any company.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-pm-interview-{company-slug}.md`. Never hand-build the path.

The doc holds: the question set by category with framework and evaluation criteria, the story-to-question map with any coverage gap, and the questions to ask them.
