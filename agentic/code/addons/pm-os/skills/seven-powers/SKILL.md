---
name: seven-powers
description: >-
  Use when a business needs auditing against Hamilton Helmer's 7 Powers — each power scored present, emerging, or absent on falsifiable tests, then acquisition playbooks written for the ones missing. Not for generating new defensibility strategies from a research bundle (`moats`), tearing down one named competitor (`netmba-competitor-analysis`), or distilling the loop behind past wins (`flywheel`).
---

# Audit the business against Helmer's 7 Powers

Helmer's discipline is one rule: every claimed **benefit** must be paired with a specific **barrier** to imitation, or it is not Power. A benefit alone is a good quarter. A benefit behind a barrier is a moat.

The seven powers, their falsifiable tests, their common false positives, and the plays that acquire each are in [`references/powers.md`](references/powers.md) — read it before Step 2 and score against it, not from memory.

## Step 1 — Fill the inputs

Get: business name and one-liner; stage (Origination / Takeoff / Stability); business model; unit economics (price, gross margin, CAC, LTV, payback, fixed vs variable drivers); scale (customers, revenue, geographies, capacity); product usage (retention, DAU/MAU, cohorts, key workflows); data, IP, and resources; go-to-market (channels, contracts, terms); the top three competitors with their strengths and likely constraints; constraints (capital, regulation, supply, partners); and the 12–24 month goals.

If anything is missing, ask up to seven high-leverage questions before proceeding.

Done when stage, unit economics, and competitors are all filled — those three drive phase fit and barrier strength, and the audit is unreliable without them.

## Step 2 — Score each of the seven

For every power, run its tests from the reference and check its false positives before claiming it. State the benefit, state the specific barrier preventing imitation, and cite 2–3 metrics as evidence. Apply the rubric — benefit clarity, barrier strength, evidence quality, phase appropriateness, durability in years protected, each 0–3 — and map the /15 to a 0–100 confidence. Mark the trend ↑/→/↓.

Weight by phase: Counter-Positioning and Cornered Resource carry Origination; Scale, Network, and Switching carry Takeoff; Brand and Process carry Stability. Do not force Brand or Process onto an early-stage business.

Done when all seven carry a status, a paired benefit-and-barrier, metric evidence, a confidence score, and a phase-fit note — including the ones scored Absent.

## Step 3 — Write acquisition playbooks for what is missing

For each Absent or Emerging power worth pursuing: prerequisites, 3–5 concrete plays drawn from the reference, a 12–24 month roadmap, KPIs and leading indicators, risks with countermeasures, and stop/kill criteria. If no power qualifies today, say so plainly and prioritise the single path to a first durable Power with the smallest credible experiment.

Done when every Absent or Emerging power either has a playbook with kill criteria or an explicit reason it is not worth pursuing.

## Step 4 — Red-team the audit

Give three reasons this analysis could be wrong and the test that would invalidate each. Check the standard illusions: brand is not ad spend, network is not virality, scale is not purchasing power, process is not checklists, switching cost is not a contract penalty. Two-sided markets get evaluated per side.

Done when three falsifying tests are named, each specific enough to run.

## Output

Sections in this order: (A) summary table — power, status, benefit, barrier, evidence and metrics, confidence, trend, stage fit; (B) verdict on sustainability of advantage in ≤120 words; (C) acquisition playbooks; (D) 30/60/90 with top three actions per horizon, each with owner, resources, and success metric; (E) red team. Keep every claim tied to a metric.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-seven-powers-audit.md`. Never hand-build the path.
