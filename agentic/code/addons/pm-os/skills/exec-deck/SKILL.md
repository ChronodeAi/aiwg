---
name: exec-deck
description: >-
  Use when you have a deck or investment case and need to stress-test it through the executive's skeptical lens before you present — surfacing the assumptions that must hold, the ways it blows up, the analyses that would settle it, and the questions to expect. Not for building the deck (`problem-deck`, `presentation-narrative`), planning it for an audience (`strategic-deck`), or writing a status update (`status-update`).
---

# Pre-mortem the deck before the exec room

Executives don't ask whether your idea is good — they ask how it fails. This skill runs the *pre-mortem* on your own deck first, so nothing in the room is a surprise. It hardens the argument; it does not build slides.

## Step 1 — Get the deck and its hypothesis

Ask for the deck or case and the one thing it's asking the room to believe or fund. Everything downstream tests that hypothesis.

Done when the deck's context and its core hypothesis are both stated.

## Step 2 — Surface the load-bearing assumptions

List the assumptions that must be true for the hypothesis to hold. Ask the executive's question: "what do we need to believe for this to be a good investment?" Keep the few that, if false, sink the case.

Done when each listed assumption is one whose failure would break the hypothesis.

## Step 3 — Imagine the blow-up

Now flip it: "what are the ways this investment blows up?" Name the concrete failure modes — market, execution, cost, competition, adoption — not vague risks.

Done when each risk is a specific way the investment fails, not a hedge.

## Step 4 — Name the analyses and the questions

For the assumptions and risks, list the analyses that would confirm or kill them, and the sharp questions an exec will ask to dimension each. Match every risk to either an analysis that settles it or a question you must be ready for.

Done when every assumption and risk has a settling analysis or a prepared answer.

## Step 5 — Report and recommend fixes

Summarize what the deck must add or change to survive: which assumptions to evidence up front, which risks to name before they're raised, which slide to add. Be direct about the weakest link.

Done when the report names the specific deck changes and identifies the single biggest exposure.

## Output

This skill produces a review — no save is required. If the user asks to keep it, resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-exec-deck-{topic-slug}.md`. Never hand-build the path.
