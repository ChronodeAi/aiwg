---
name: impact-sizing
description: >-
  Use when you need a top-down estimate of whether a feature is worth building — a funnel from exposed users down to actual adopters, converted into rough engagement and revenue impact, with the riskiest assumptions named. Not for a per-KPI arithmetic model that defends a number to execs (`impact-model`), defining the success metric for a change (`success-metric`), or the full measurement workflow (`/measure`).
---

# Size the opportunity with a funnel

## Step 1 — Get the feature and the base numbers

Ask for the feature and whatever real metrics exist: user counts, traffic to the relevant surface, current engagement and revenue figures. Real numbers anchor the funnel; note which ones you're missing.

Done when the feature is stated and every base number is either a real figure or explicitly marked missing.

## Step 2 — Build the exposure-to-use funnel

Start from everyone who could encounter the feature and step down: exposed → notice → try → use repeatedly. Give each step a rate with the reasoning behind it — comparable features, placement, friction. Elicit rates from the user where they have data; label every rate you had to assume.

Done when the funnel runs from total exposure to repeat use, and every rate carries either a source or an "assumed" label with reasoning.

## Step 3 — Convert adopters into impact

Take the repeat-use number and estimate what it moves: engagement (DAU/MAU, retention), top-line (revenue, GMV), bottom-line (margin) — whichever apply. Show the conversion arithmetic; don't invent a metric the product doesn't track.

Done when each applicable impact has a rough number with its arithmetic visible.

## Step 4 — Name the riskiest assumptions

Rank the funnel rates and conversion assumptions by how much the final number swings if they're wrong. For the top 2–3, say how to de-risk cheaply — existing data to pull, a usability test, a fake-door — before anyone commits a quarter to this.

Done when the 2–3 highest-swing assumptions each have a named de-risk method.

## Step 5 — Call it

State the takeaway: the impact range (not a single confident number), whether it clears the bar for building, and what would change the verdict. If the range spans "skip it" to "top priority," say the de-risking comes first.

Done when the verdict is a range plus a build/de-risk-first/skip recommendation.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-impact-sizing-{feature-slug}.md`. Never hand-build the path.

The doc holds: the base numbers and gaps, the funnel with per-step rates and sources, the impact arithmetic, the ranked risky assumptions with de-risk methods, and the verdict.
