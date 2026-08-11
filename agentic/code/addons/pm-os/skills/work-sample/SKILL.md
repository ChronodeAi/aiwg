---
name: work-sample
description: >-
  Use when you're building a PM work sample — a take-home, portfolio piece, or interview presentation — that has to show how you think and be *specific* to the company you're applying to. Not for writing the résumé (`resume`), preparing interview answers (`pm-interview`), building behavioral stories (`star-stories`), or drafting a real PRD (`prd-draft`).
---

# Build a PM work sample that lands the interview

## Step 1 — Frame it

Get what it's for (take-home / portfolio / interview presentation), the prompt if they gave one (or pick a type: strategy, feature recommendation, market opportunity, competitive analysis), what you know about the company, and the real experience you can draw on.

Done when the format, the topic, the company context, and your source experience are all in hand.

## Step 2 — Set the two-page structure

Page 1 is the thinking (problem/opportunity → analysis → recommendation); page 2 is the details (how it works, metrics, risks, next steps). Two great pages beat five mediocre ones.

Done when the piece is scoped to ~2 pages with the thinking/details split.

## Step 3 — Ground every insight in their company

Each insight names something specific about this company's product, market, or users and cites a data source or a real observation — never a claim that would hold for any company.

Done when every insight is specific to the company and carries a source, with no generic filler.

## Step 4 — Make the recommendation and trade-offs explicit

One clear "I recommend X because Y," the alternatives you considered and rejected with reasons, and what you'd validate before committing.

Done when there is one specific recommendation, named rejected alternatives, and a validation list.

## Step 5 — Skim-test and gut-check

Headers, bullets, and bold so a hiring manager skims it in ~10 minutes. Gut check: does it show how you think, and would you be proud to discuss it in the room?

Done when the piece is skimmable in ~10 minutes and passes the "shows my thinking / proud to discuss" check.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-work-sample-{company-slug}.md`. Never hand-build the path.

The doc holds: the framing, the two-page sample (thinking + details) specific to the company, the explicit recommendation with rejected alternatives, and the validation list.
