---
name: nps-to-cx-plan
description: >-
  Use when you have NPS scores and open-text feedback and want a prioritized set of CX initiatives — detractor and promoter comments split, themed with honest counts and verbatim quotes, then turned into ranked initiatives. Not for general survey open-text (`survey-to-actions`), defining the metric itself (`success-metric`), or the full measurement workflow (`measure`).
---

# Turn NPS feedback into prioritized CX initiatives

## Step 1 — Split detractors and promoters

Separate detractors (0–6) from promoters (9–10) and read all the open text in each — no sampling the first handful.

Done when the two populations are separated and every comment in each is read.

## Step 2 — Theme each side with counts and quotes

Pull the top ~5 detractor pain points and ~5 promoter benefits. Each carries an honest count ("14 of 60 detractors") and a representative verbatim quote — start where the thought begins, keep the hedges, don't stitch fragments together.

Done when each theme has a count and a verbatim quote, and no count is "many."

## Step 3 — Turn themes into initiatives

For each theme, name an initiative that reduces the pain or amplifies the benefit — concrete enough to act on, not "improve onboarding."

Done when every theme has a specific initiative attached.

## Step 4 — Prioritize

Score each initiative on frequency (how often the theme appears) × impact (how much it moves the experience) × feasibility. The top ones surface.

Done when every initiative has a frequency/impact/feasibility judgment and a resulting rank.

## Step 5 — Present the plan

Lay out the ranked detractor-fixing and promoter-amplifying initiatives, each with the theme it addresses, its priority, and its quote.

Done when the plan lists ranked initiatives for both populations, each tied to a themed count and quote.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-nps-to-cx-plan-{topic-slug}.md`. Never hand-build the path.

The doc holds: the detractor and promoter theme lists with counts and quotes, and the prioritized initiatives for each population with their scores.
