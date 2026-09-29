---
name: survey-to-actions
description: >-
  Use when a pile of open-ended survey responses needs turning into *pain points* with honest counts, verbatim quotes, and concrete action items. Fires on "analyze these survey results" or an exported CSV of free-text answers. Not for mixed-source research (`research-synthesis`), support tickets (`tickets-to-improvements`), or NPS programs (`nps-to-cx-plan`).
---

# Turn survey responses into pain points and actions

## Step 1 — Get the responses and the questions that produced them

Get the responses, the total count, and the exact wording of the survey questions — the wording shapes the answers, and a pain point that merely echoes a leading question is the question talking. Ask what decision this analysis feeds, if the user knows.

Done when the responses, total count, and question wording are in hand.

## Step 2 — Tag every response

Read all of them — no sampling the first fifty — and tag each with the theme or themes it touches. A response that fits nothing gets tagged unusable with a reason (blank, off-topic, gibberish). Keep a tally as you go.

Done when tagged-plus-unusable equals the total count.

## Step 3 — Cluster into pain points with counts and quotes

Group the tags into pain points. Each carries: an honest count ("12 of 80 responses," never "many users"), at least two verbatim quotes cited by response number, and the segment it concentrates in if the data shows one. Quotes stay whole — keep the hedges and the emotion; start where the thought begins.

Done when every pain point has a count, two-plus cited quotes, and no quote is stitched from separate responses.

## Step 4 — Mark act-on or verify-first

For each pain point, ask: is this actionable on stated evidence alone, or does it need behavioral confirmation first? Complaints about price and requests for features are notorious say/do gaps — mark those verify-first with the check (an analytics query, a support-ticket search, three calls). Bugs and comprehension failures are usually act-on.

Done when every pain point is marked act-on or verify-first, and each verify-first names its check.

## Step 5 — Write the actions

For each act-on pain point, write 1–3 concrete actions: what changes, roughly how big it is, and who could own it. An action must be specific enough to become a ticket — "improve onboarding" is a theme, not an action.

Done when every action names what changes and a plausible owner, and none restates its pain point as a verb.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-survey-to-actions-{survey-slug}.md`. Never hand-build the path.

The doc holds: the questions and response count, the pain points with counts and quotes, the act-on/verify-first marks with checks, the actions.
