---
name: find-the-strategic-crux
description: >-
  Use when a strategy problem is messy or underspecified and the PM needs the one *crux* — the structural reason the gap exists — found before any option is generated, then a recommendation stress-tested against it. Also `/strategy` Step 0, where it stops at the crux and hands off. Not for decomposing a problem into a full Why/What/How issue tree (`mckinsey-issue-tree`), writing the three-part strategy kernel (`strategy-kernel`), or MECE-checking a list you already hold (`mece-tree`).
---

# Find the strategic crux

The crux is the structural reason the gap exists — the thing that, once resolved, makes everything else tractable. Everything before it is search; everything after it is consequence. Do not generate options before naming it.

Read the room on how much the user has brought. Rich description: reflect back your reading, then sharpen it in Step 1. Almost nothing: open with Step 1's questions. At every step, offer your own analytical read *and* ask what they know that would complicate it.

## Step 1 — State the gap as one question

Pull two specifics from the user: what is happening today (metrics, behaviours, decisions, dynamics) and what they want true instead, time-bound where possible. Most people open with a solution dressed as a problem ("we need a strategy") or a symptom dressed as a cause ("engagement is dropping") — push past both.

Done when the gap is a single sentence the rest of the analysis has to answer.

## Step 2 — Map every place the problem could live

Build the candidate list with the user; they know their system. Locations only, not causes yet. Make it mutually exclusive and collectively exhaustive — invoke `mece-tree` if the list is contested. Push back if they are already narrowing toward a preferred answer, and add candidates the problem type implies.

Done when the list covers the territory and the user cannot name a missing candidate.

## Step 3 — Name the crux

Work the candidates: is this contributing to the gap, and through what causal chain? Not everything deserves equal depth — have the user rank which are most likely load-bearing and make that reasoning explicit so it can be challenged.

Done when the crux is stated in one or two sentences as a structural cause, not a symptom.

**Inside `/strategy`:** stop here. Hand forward the crux, the current-state/desired-future framing, and the constraints — Steps 1b–2 of that workflow generate and sharpen the options. Running Steps 4–5 below would pre-empt them.

## Step 4 — Generate options off the causal structure

Each option targets a specific lever in the Step 3 chain; an option that does not trace back to the crux does not belong. For each, work three things with the user: whether it is executable under their real constraints, whether it hits the root cause or a symptom, and its upside and downside. Feasibility is theirs to assess, not yours.

Done when every option names its lever, its feasibility verdict, and its downside.

## Step 5 — Stress-test, then recommend

Before committing, have them visualise the world with the change in place: what it looks like, what else must move, what numbers or behaviours change. Then run three risks — a key assumption proves wrong, execution succeeds but the gap holds, someone pushes back. Any risk severe enough to disqualify sends the choice back to Step 4.

Done when the recommendation states what to do, why over the alternatives, and the first concrete move.

## Output

Keep formatting minimal — step labels, prose for reasoning, flat bullets for the Step 2 and Step 4 lists. No bold, no sub-headers, no nesting.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-strategic-crux.md`. Never hand-build the path.
