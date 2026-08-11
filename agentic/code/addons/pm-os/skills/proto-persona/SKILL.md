---
name: proto-persona
description: >-
  Use when research exists but no persona does — interviews, analytics, market
  data, and demographics in, one proto-persona out where every line is tagged
  *evidence* or *assumption* with a source, carries a confidence rating, and the
  unknowns become prioritized probing questions. Not for upgrading an existing
  shallow persona into tasks and constraints (`user-profile`), mapping one
  audience's emotions around a topic (`create-empathy-maps`), or play-acting a
  customer's first-person voice (`icp-roleplay`).
---

# Build a first persona from research, tagged by evidence

## Step 1 — Take the inputs and tag the sources

Take whatever mix exists: interview notes and quotes, market data, behavioral analytics or JTBD observations, demographics, plus any constraints (industry, region, compliance, accessibility). Give each source a short tag — `[UR#3]`, `[GA]`, `[MD]` — so every later claim can cite one. Ask how many personas are wanted; default to one.

Done when every input has a tag, and any absent input type is named as absent rather than quietly skipped.

## Step 2 — Cluster the signals

Pull verbatim quotes, facts, and metrics out of the inputs, then cluster them into pains, goals, and observed behaviors. Behaviors are what the person does; goals are what they are after. Keep them apart.

Done when every cluster holds at least one tagged signal, and no behavior is phrased as a goal.

## Step 3 — Map the decision dynamics

Establish the person's decision-making authority (buyer, user, champion, blocker, none), who influences them, and the beliefs and risk posture they bring — heuristics, trust signals, what makes them say no.

Done when authority, influencers, and beliefs are each stated with a confidence rating of High, Med, or Low.

## Step 4 — Write the canvas

Write the persona under these headings, alliterative name first:

- **Bio & demographics** — age range, location, role or life stage, income band, channel habits, notable constraints.
- **Representative quotes** — three, each with its source tag.
- **Pains**, **behaviors and jobs**, **goals** — from Step 2.
- **Attitudes & influences** — from Step 3.
- **Purchasing signals** (optional) — triggers, selection criteria, objections, how they judge value.
- **Accessibility & inclusion** (optional) — access, language, bandwidth, cognitive load.

Every line ends in `[evidence|assumption, confidence, source|TBD]`. Anything with no data is written `TBD`, never invented. Keep the whole canvas under 400 words unless deep output was asked for.

Done when every line carries its evidence/assumption tag, confidence, and source or `TBD`, and no demographic trait is asserted without one.

## Step 5 — Run the honesty checks

Test the canvas against itself: do the quotes actually substantiate the pains and goals, or were they assumed? Is the decision role compatible with the stated criteria and objections? Does any demographic line stereotype without evidence? Then collect every `TBD` and every Low-confidence line into a prioritized probing-question list, highest-value unknown first.

Done when each failed check is fixed or re-tagged as an assumption, and every `TBD` and Low-confidence line appears in the probing-question list.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-proto-persona-{persona-slug}.md`. Never hand-build the path.

The doc holds: the tagged source list, the canvas, the evidence and confidence summary, and the prioritized probing questions.
