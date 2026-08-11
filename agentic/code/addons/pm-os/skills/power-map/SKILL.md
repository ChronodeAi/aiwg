---
name: power-map
description: >-
  Use when you need to know who actually holds power in a stakeholder
  system before acting — a decision or initiative and the people involved
  in, a ranked power map out (formal authority, informal influence,
  incentives, relationships, and influence pathways). Also `/stakeholder`
  Step 1, the entry point before Step 2's `stakeholder-map` grid. Not for
  prepping the adversarial meeting itself (`meeting-prep`), plotting
  stakeholders on a Power-Interest grid (`stakeholder-map`), or surfacing
  what people want rather than how much say they have (`hidden-agendas`).
---

# Map who actually holds power before you act

## Step 1 — Take the decision and the people involved

Get the decision, initiative, or situation at hand, and the list of people involved — their formal roles and any known history, alliances, or conflicts between them.

Done when the decision at hand and every person involved are named.

## Step 2 — Rank formal and informal power

For each person, note their formal authority (title, reporting line) and informal power (expertise, relationships, gatekeeping) separately — the two don't always agree. Rank the full list by real influence over this specific decision, not org-chart seniority.

Done when every person is ranked by actual influence over the outcome, with formal and informal power noted separately.

## Step 3 — Map incentives and influence pathways

For each ranked person, note their incentive (what they gain or lose from the outcome), their relationships to others in the list, and the influence pathways connecting them — who they listen to, who listens to them.

Done when every person's incentive is stated, and the relationships and influence pathways connecting them are mapped.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-power-map-{situation-slug}.md`. Never hand-build the path.

The doc holds: the ranked power list (formal + informal), each person's incentive, and the relationships/influence pathways connecting them.
