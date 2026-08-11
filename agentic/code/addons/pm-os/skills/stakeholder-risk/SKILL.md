---
name: stakeholder-risk
description: >-
  Use when you need to review a product requirement document or feature
  description for potential stakeholder risks and politics — a PRD or
  feature description in, political risks with mitigations and a readiness
  checklist out. Also `/stakeholder` Step 3, taking the Step 2
  `stakeholder-map` snapshot as its starting point. Not for building the
  initial Power-Interest map from scratch (`stakeholder-map`), scanning for
  cross-functional objections before any specific doc exists
  (`objection-scan`), or ranking raw formal/informal influence (`power-map`).
---

# Audit a PRD for stakeholder risk before broad circulation

## Step 1 — Take the PRD and snapshot stakeholders

Get the PRD or feature description (goals, metrics, scope, rollout) and a Power-Interest snapshot of the stakeholders involved, including informal influencers.

Done when the snapshot names every stakeholder in scope by power/interest quadrant.

## Step 2 — Identify who feels threatened and why

For each stakeholder who might feel threatened, excluded, or overruled, name the specific fear or objection — turf, KPI cannibalization, support load, compliance — grounded in their actual role, not a generic worry.

Done when every flagged stakeholder has a specific, named fear tied to their role.

## Step 3 — Propose mitigations and framing

For each concern, propose a doc change (edit, added evidence, clearer ownership, a metric) and a 1:1 message (focus, proof point, artifact). Recommend the top 3 concrete actions to take before sharing broadly, and frame variations for execs vs. ICs.

Done when every flagged concern has a doc-level mitigation and a 1:1 message, and 3 pre-circulation actions are named.

## Step 4 — Set the comms sequence and readiness checklist

Lay out the minimal comms sequence to land the doc (who hears it, in what order), the top decision/optics risks with reductions (pilot scope, phased rollout, sunset criteria), and a readiness checklist (data, owners, dependencies, support plan, legal/privacy review as needed).

Done when the comms sequence is ordered, every top risk has a stated reduction, and the readiness checklist has no unaddressed item.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-stakeholder-risk-{feature-slug}.md`. Never hand-build the path.

The doc holds: the stakeholder snapshot, the per-stakeholder concerns and mitigations, the pre-circulation actions, the comms sequence, and the readiness checklist.
