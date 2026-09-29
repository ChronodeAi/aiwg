---
name: churn-reduction
description: >-
  Use when churned-user data and exit-survey responses need turning into
  a targeted reduction plan — each strategy tied to a specific stated
  reason for leaving, with a timeline and success metric. Not for the
  broader growth-loop diagnosis (`growth-strategy`), finding the
  activation moment that predicts retention (`aha-moment`), or reducing
  flow friction generally (`friction-reduce`).
---

# Tie every strategy to a stated reason for leaving

## Step 1 — Take the churn data and exit surveys

Get the churn data (rate, customer lifetime, characteristics of churned users) and the exit survey responses.

Done when both the quantitative churn data and the exit survey responses are in hand.

## Step 2 — Categorize reasons and find patterns

Group exit survey responses into themes (pricing, features, support, etc.), and check for correlations between user characteristics or timing and likelihood to churn.

Done when every response is categorized into a theme, and at least one pattern (or its absence) is stated.

## Step 3 — Rank the top insights

From the themes and patterns, name the top 3-5 insights about why users are actually churning, ranked by potential impact.

Done when 3-5 insights are ranked, each grounded in a specific theme or pattern from Step 2.

## Step 4 — Propose one strategy per insight

For each ranked insight, propose one specific, actionable strategy with a timeline and a metric that would show it's working.

Done when every insight has a strategy, timeline, and success metric — no insight left unaddressed.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-churn-reduction-{product-slug}.md`. Never hand-build the path.

The doc holds: the categorized reasons, the ranked insights, and the strategy/timeline/metric for each.
