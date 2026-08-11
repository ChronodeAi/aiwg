---
name: tickets-to-improvements
description: >-
  Use when a batch of support tickets needs turning into a prioritized
  product-improvement backlog — recurring trends named and ranked by
  frequency, severity, and effort. Not for open-ended survey text
  (`survey-to-actions`), the full post-launch feedback-to-roadmap
  sequencing across all sources (`v2-plan`), or setting up the ongoing
  feedback pipeline itself (`feedback-loop`).
---

# Turn support tickets into a ranked improvement backlog

## Step 1 — Take the tickets

Get the support tickets or complaints in scope.

Done when the full ticket set is in hand.

## Step 2 — Categorize and count

Sort tickets into recurring categories, count each category's frequency, and flag any severe or unusual outlier that doesn't fit a pattern but still matters.

Done when every ticket is categorized, each category has a count, and outliers are flagged separately.

## Step 3 — Rank into improvements

For each category above a meaningful frequency threshold, propose one improvement. Rank all proposed improvements by frequency, severity of impact, and rough effort to fix.

Done when at least 5 improvements are ranked, each justified by its category's frequency and severity against its effort.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-tickets-to-improvements-{scope-slug}.md`. Never hand-build the path.

The doc holds: the trend analysis by category with counts, and the ranked improvement list with justification.
