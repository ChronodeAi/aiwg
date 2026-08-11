---
name: stakeholder-map
description: >-
  Use when you need to analyze and strategize on the power, interest, and
  influence of stakeholders in an initiative — an initiative and its
  stakeholder list in, a Power-Interest grid with an engagement plan out.
  Also `/stakeholder` Step 2, taking the power dynamics map from Step 1's
  `power-map`. Not for ranking raw formal/informal influence before this
  grid exists (`power-map`), auditing a specific PRD against this map for
  circulation risk (`stakeholder-risk`), or mapping motivation instead of
  power/interest (`hidden-agendas`).
---

# Map stakeholders on a Power-Interest grid

## Step 1 — Take the initiative and stakeholder list

Get the initiative description, objectives, timeline, and constraints, plus the stakeholder list (names, roles, org, relationships) and known allies/blockers. Ask up to 3 targeted questions if the list has critical gaps; otherwise state assumptions and proceed.

Done when every stakeholder has a name, role, and at least one known relationship or assumption noted.

## Step 2 — Build the Power-Interest grid and influence pyramid

Plot every stakeholder on a Power × Interest matrix (High/Low each). Add an Influence Pyramid (Top/Middle/Base) that captures informal power — gatekeepers, super-connectors, executive assistants — separately from the formal grid.

Done when every stakeholder sits in exactly one grid quadrant and the influence pyramid names any informal power the grid alone would miss.

## Step 3 — Profile every high-power stakeholder

For each High Power–High Interest and High Power–Low Interest stakeholder, capture their goals and success metrics, likely concerns (political, operational, reputational), preferred communication style, and the political risk their reaction poses to the user.

Done when every high-power stakeholder has all four fields filled, not left generic.

## Step 4 — Design the engagement plan

For each high-power stakeholder: set a cadence and channel, name who leads and who supports, the key message tied to their priorities, a quick win to offer, and a fallback if they resist. For high-interest/low-power stakeholders, note how to keep them informed and mobilize their advocacy.

Done when every high-power stakeholder has a complete engagement plan, and the low-power/high-interest group has a stated involvement approach.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-stakeholder-map-{initiative-slug}.md`. Never hand-build the path.

The doc holds: the Power-Interest grid, the influence pyramid, the high-power stakeholder profiles, and the engagement plan.
