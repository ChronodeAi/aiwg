---
name: impact-model
description: >-
  Use when a specific KPI number has to survive scrutiny — build the explicit arithmetic model of a feature's impact on named KPIs, every term a sourced or flagged assumption, with sensitivity ranges on the shaky ones. Not for a first rough is-it-worth-building estimate (`impact-sizing`), defining the success metric (`success-metric`), or designing the test that validates the assumptions (`experiment-design`).
---

# Model the KPI impact as equations

## Step 1 — Get the feature and the KPIs on trial

Ask for the feature and the specific KPIs someone wants estimated. Each KPI is a separate model; don't add KPIs nobody asked about.

Done when the feature is stated and each KPI is named with its current definition (what counts, over what window).

## Step 2 — Write the equation for each KPI

Express each KPI's change as an explicit formula — e.g. Δretention = (users reaching the feature) × (adoption rate) × (retention lift among adopters) ÷ (total users). Every term must be something that can be looked up, estimated, or argued about on its own.

Done when each KPI has a formula whose every term is individually nameable — no "impact factor" catch-alls.

## Step 3 — Fill the terms

For each term: pull the real value where data exists, elicit estimates from the user where they know their product, and only then assume — labeled, with the reasoning stated. Never present an invented value as data; on this path a fabricated number is worse than a blank.

Done when every term has a value tagged **data**, **user estimate**, or **assumed + reasoning**.

## Step 4 — Compute the point estimates

Run the arithmetic per KPI, shown step by step so a reviewer can recompute it. Sanity-check each result against a known reference — last quarter's movement, a comparable launch — and flag any estimate that fails the smell test rather than adjusting it silently.

Done when each KPI has a point estimate with visible arithmetic and a stated sanity check.

## Step 5 — Run the sensitivity

Take the terms tagged *assumed* and swing each across a plausible low–high range; recompute. Report each KPI as a range, and name the one term that moves the result most — that term is what the meeting should argue about, and what's worth measuring first.

Done when each KPI shows low/point/high, and the single highest-leverage assumption is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-impact-model-{feature-slug}.md`. Never hand-build the path.

The doc holds: the KPIs and definitions, each equation, the term table with source tags, the point estimates with arithmetic and sanity checks, and the sensitivity ranges with the highest-leverage assumption.
