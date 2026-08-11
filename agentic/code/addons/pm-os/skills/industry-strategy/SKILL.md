---
name: industry-strategy
description: >-
  Use when a company's strengths need to be pointed at a specific industry
  trend to find strategic options — not the full 7-part product strategy,
  just the trend/strength intersection. Not for the full structured
  strategy document (`product-strategy`), diagnosing the strategic problem
  itself (`strategy-kernel`), or the complete strategy workflow
  (`/strategy`).
---

# Point company strengths at an industry trend

## Step 1 — Name the trend and its effect

State the trend precisely, not as a category label, and how it's actually reshaping the industry — who's winning, who's losing, what's becoming table stakes.

Done when the trend is named specifically and its industry-level effect is stated with evidence, not assumed.

## Step 2 — Test the strengths against it

List the company's real strengths — capabilities, assets, position — the kind that would make a competitor PM wince, not a generic "great team." Test each against the trend: does this strength actually apply here, or is it strength pointed in the wrong direction?

Done when every listed strength is tested against the trend, and any that don't apply are cut, not padded.

## Step 3 — Generate strategies at the intersection

For each surviving strength, propose one strategy that rides the trend using that strength toward the stated goal — name the mechanism, not just the direction.

Done when at least 3 strategies are named, each tracing to a specific strength and a stated mechanism.

## Step 4 — Name what could kill each one

For each strategy, name the biggest risk or obstacle and whether it's addressable.

Done when every strategy has a named risk and an addressable/not-addressable call.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-industry-strategy-{company-slug}.md`. Never hand-build the path.

The doc holds: the trend and its effect, the tested strengths, the strategies with mechanisms, and each strategy's risk.
