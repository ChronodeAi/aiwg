---
name: moats
description: >-
  Use when research has piled up and needs converting into candidate *moats* — ten distinct defensibility strategies scored on time-to-moat, cost, and probability, then narrowed to a three-strategy portfolio with kill criteria and a six-month sequence. Not for diagnosing which of Helmer's 7 Powers the business already holds (`seven-powers`), distilling the loop behind past wins (`flywheel`), or calling match/differentiate on one competitor feature (`parity-vs-differentiation`).
---

# Convert research into candidate moats

A moat is not an advantage — it is an advantage that *compounds* and that a competitor cannot copy quickly. Every strategy below must name the compounding mechanism, or it is a feature, not a moat.

## Step 1 — Gather the app context and the research

Pull the app context: what it does, target users, primary value proposition, current traction (users, revenue, retention), constraints (team size, budget, horizon, compliance, stack), competitors and alternatives, and what the company can uniquely access — data, distribution, partnerships, domain expertise. Then take the research bundle: excerpts, summaries, bullets, citations, links.

Done when all eight context fields are filled and the research bundle is in hand — ask for whichever are missing rather than inferring them.

## Step 2 — Extract insights that bear on defensibility

Produce 8–15 insights, each with an id (`I1`, `I2`, …), the insight in one sentence, the evidence (quote or paraphrase plus where it came from), and the implication — what this enables or suggests. Drop anything interesting that does not bear on competitive advantage.

Done when every insight carries an id, sourced evidence, and an implication.

## Step 3 — Generate ten distinct moat strategies

Each strategy names a `moat_type` from: data moat, network effects, switching costs, distribution moat, brand, scale economies, ecosystem/platform, regulatory/permissions, IP/know-how, community. No type appears more than twice.

For each: title; mechanism (how it compounds over time, 1–3 paragraphs); `research_link` (the insight ids it uses); implementation plan across now-30d / next-90d / next-12m, 3–6 concrete steps each; prerequisites; 3–6 measurable leading indicators with targets; 3–6 risks with mitigations; `time_to_moat` (<3 months / 3–6 / 6–12 / 12–24 / 24+); `estimated_cost` (low/medium/high); `defensibility_score` 1–10 with a brief justification; and `probability` (0.0–1.0) that this becomes a durable moat given the inputs.

Push into the tail of the distribution: every probability below 0.15, at least three below 0.07, and at least two strategies that would not be the default answer for a startup in this space. Reason privately about what is feasible under the constraints, what compounds, and what competitors cannot copy quickly — then produce the strategies without narrating that reasoning.

Done when ten strategies exist, each with a compounding mechanism and linked insight ids, and the type and probability constraints hold.

## Step 4 — Cut to a portfolio

Recommend three strategies to pursue in parallel, each with a 2–4 sentence rationale. For each, define 2–3 **falsifiable** kill criteria — the observations that would stop the work. Then sequence the three month by month across six months, showing what depends on what.

Done when every recommended strategy has kill criteria that could actually be observed, and the sequence shows its dependency order.

## Output

Valid JSON only, keyed `moat_strategies` (list of ten), plus `recommended_portfolio`, `kill_criteria`, and `sequencing`. Probabilities as decimals, calibrated relative to each other — they need not sum to 1. Implementation-ready language, no vague advice.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-moat-strategies.md`. Never hand-build the path.
