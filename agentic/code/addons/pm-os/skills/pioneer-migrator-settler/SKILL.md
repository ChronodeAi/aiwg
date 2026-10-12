---
name: pioneer-migrator-settler
description: >-
  Use when a company's growth options need the Pioneer-Migrator-Settler map — the current *portfolio* placed on it first, the imbalance read, then growth ideas generated to fill the gap. Fires on "are we too red-ocean," "PMS map," or Blue Ocean portfolio reviews. Not for the growth model and its constraint (`growth-strategy`), counter-positioning ideation (`disruption-what-ifs`), or SWOT-derived moves (`swot-moves`).
---

# Map the portfolio and generate ideas to rebalance it

The PMS map sorts a *portfolio* by innovation level: **pioneers** create new market space, **migrators** offer more value inside the existing shape, **settlers** are me-too offerings in the red ocean. A healthy mix has settlers and migrators funding today while pioneers build the future — so the ideas come after the map, aimed at whatever the map shows missing. Framework per Kim & Mauborgne's Blue Ocean work.

## Step 1 — List the current portfolio

Ask for the company's offerings and in-flight initiatives — products, tiers, major bets. The map is only as honest as this list; a flagship-only list hides the settler bulk.

Done when the offerings and initiatives are listed, including the unglamorous ones.

## Step 2 — Place each on the map

Categorize every item: pioneer, migrator, or settler, each with a one-line reason. The pioneer bar is strict — it creates new market space and reaches people who weren't buying in this category at all. "Better than competitors" is a migrator; "as good as" is a settler. Expect most claimed pioneers to demote on inspection.

Done when every item has a category and a reason, and every pioneer names the new market space it created.

## Step 3 — Read the imbalance

State what the map shows: settler-heavy means profit today and no future; pioneer-heavy means a future nothing is funding; migrator-only means comfortable decline in slow motion. Name which of these the company is, and what that costs if unchanged.

Done when the imbalance is one named condition with its consequence.

## Step 4 — Generate ideas aimed at the gap

Generate ~12 growth ideas skewed toward what the map lacks. For each: a name, a one-line mechanism, its PMS category with the reason, and — for every pioneer claim — the noncustomers it unlocks: who isn't buying in this category today that would. A pioneer claim without named noncustomers is a migrator wearing a costume. Range deliberately from safe to strange; the strange ones exist to stretch the space even if they don't ship.

Done when there are ~12 ideas, the skew matches the Step 3 gap, and every pioneer claim names its noncustomers.

## Step 5 — Recommend the rebalancing move

Pick the 2–3 ideas that best rebalance the portfolio and sequence them with the funding logic explicit: which settlers and migrators pay for which pioneer, and what gets starved or sunset to make room. A rebalancing plan that adds pioneers without naming their funding source is a wish list.

Done when the recommendation names its funded-by chain and anything sunset to make room.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-pioneer-migrator-settler-{company-slug}.md`. Never hand-build the path.

The doc holds: the portfolio with placements and reasons, the imbalance and its cost, the 12 ideas with categories and noncustomer claims, the rebalancing recommendation with funding logic.
