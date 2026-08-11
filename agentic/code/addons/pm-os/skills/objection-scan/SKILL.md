---
name: objection-scan
description: >-
  Use when you need to anticipate and prepare for stakeholder objections
  using the MOO (Most Obvious Objection) approach — a proposed initiative
  in, ranked objections per stakeholder group with counter-moves and
  pre-wire scripts out. Not for per-person motivation and fear mapping
  (`hidden-agendas`), auditing a specific PRD for circulation risk
  (`stakeholder-risk`), or generating training-only flawed solutions
  (`solution-flaws`).
---

# Surface the most obvious stakeholder objections before they derail your product

## Step 1 — Take the initiative and intake

Get the initiative name, its one-sentence goal, the audience, the stage, the proposed solution, key assumptions, the success metric, the timeline, cost, known constraints, and the top 3 stakeholders by title. Ask up to 5 crisp follow-ups for anything missing.

Done when every intake field is filled or explicitly marked unknown.

## Step 2 — Rank objections per stakeholder group

For each relevant group (Exec/Finance, Eng/Infra, Data/AI, Design/UX, Sales/CS, Marketing, Legal/Privacy/Security, Ops/Support, Analytics), list 3–7 objections with: type, MOO rank (1–5, 1 = most obvious), the question behind the question, loss-vs-gain framing, frequency × magnitude, the evidence they'll demand, and a specific counter-move.

Done when every listed stakeholder group has at least 3 ranked objections, each with a named counter-move.

## Step 3 — Build the proof and pre-wire plan

Design the smallest tests that answer the top objections, list the artifacts to prepare (1-pager, FAQ, ROI sheet, risk register), and write pre-wire scripts: an email/Slack template, a 60-second opener, and if-they-say-X-you-say-Y snippets for the top 3 objections.

Done when the top 3 objections each have a scripted counter and a named proof step.

## Step 4 — Assemble the executive slide and risk register

Write one slide (why now, top objection plus the question behind it, evidence to date, next proof step, the ask) and a risk register (trigger, early warning signal, owner, mitigation, kill-switch) for the top risks.

Done when the slide has all 5 elements and every top risk has an owner and a kill-switch.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-objection-scan-{initiative-slug}.md`. Never hand-build the path.

The doc holds: the intake, the ranked objections per group, the proof/pre-wire plan, the executive slide, and the risk register.
