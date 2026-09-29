---
name: measure
aliases: [measure-what-matters]
description: Turn vague intangibles into quantified decision inputs by chaining clarification, decomposition, value-of-information analysis, and small-sample measurement into a single structured workflow. Use when defining KPIs, deciding what to measure, or designing ROI analysis on intangibles.
---

# /measure — Measure What Matters

Walk the user through a 6-step measurement workflow. Steps 1, 2, 4, and 5 invoke skills from `skills/`. Steps 3 and 6 are inline conversational steps. Pass the output of each step as input to the next. Confirm with the user before advancing unless they request end-to-end.

---

## Before starting

Surface the most relevant frameworks for this workflow. Scan these Knowledge files and note 3–5 that apply to the user's measurement problem:

- `knowledge/Metrics/` — north star examples, metric definitions, measurement patterns
- `knowledge/Frameworks/validation/` — frameworks for testing assumptions and validating hypotheses
- `knowledge/Prioritization/` — scan tag metadata for frameworks matching ROI analysis, trade-off quantification

Present the relevant framework names (not full content) to the user before Step 1. One line each: name + when to use. Ask which, if any, they want applied during the workflow.

---

## Step 1: Define the intangible as observable quantities

**Skill:** `clarification-chain`
**Folder:** `skills/clarification-chain/SKILL.md`

Read and invoke this skill. Goal: convert the user's vague concept ("quality", "engagement", "security") into concrete, observable, measurable quantities using the three-link chain: detectable → amount → measurement method.

**Output to carry forward:** List of observable metrics (input indicators + output indicators) with measurement methods.

---

## Step 2: Decompose the quantity into estimable components

**Skill:** `fermi-decomposition`
**Folder:** `skills/fermi-decomposition/SKILL.md`

Invoke this skill using the observables from Step 1. Goal: for each key metric identified, break it into a multiplicative or additive decomposition of estimable factors. Identify which factors the user can estimate now and which need data.

**Output to carry forward:** Decomposition table with factors, central estimates, and 90% CI ranges for each.

---

## Step 3: Calibrate uncertainty — assign 90% confidence intervals

This is an inline conversational step (no separate skill).

For each factor from Step 2, guide the user through calibrating a 90% confidence interval:

1. **Anchor:** Ask the user for their best guess (central estimate)
2. **Stretch:** Ask "What's the highest this could plausibly be?" and "What's the lowest?"
3. **Challenge:** Push back if the range is suspiciously narrow — "Would you bet $1,000 at 9:1 odds that the true value falls in this range?"
4. **Record:** Capture lower bound, central estimate, upper bound for each factor

**Calibration tips to share with the user:**
- Most people are overconfident — their 90% CIs are too narrow
- If you'd be "surprised" by a value outside your range, widen it
- Think of specific scenarios that would push the value to each extreme

**Output to carry forward:** All factors with calibrated 90% CIs in a structured table.

---

## Step 4: Calculate the value of reducing each uncertainty

**Skill:** `value-of-information`
**Folder:** `skills/value-of-information/SKILL.md`

Invoke this skill using the calibrated factors from Step 3. Goal: for each uncertain factor, calculate the Expected Value of Information (EVI) to determine which uncertainties are worth measuring. This prevents wasting effort on variables that wouldn't change the decision even if you knew them perfectly.

**Output to carry forward:** Factors ranked by EVI, with MEASURE / DON'T MEASURE recommendations for each.

---

## Step 5: Collect small samples for high-EVI variables

**Skill:** `rule-of-five`
**Folder:** `skills/rule-of-five/SKILL.md`

Invoke this skill for each factor marked MEASURE in Step 4. Goal: design a sampling plan using the Rule of Five — 5 random observations give a 93.75% confidence interval for the median. Guide the user on what to sample, how to ensure randomness, and how to interpret the results.

If the user cannot sample immediately, help them design the sampling plan for later execution and record what data they need to collect.

**Output to carry forward:** Narrowed ranges for high-EVI variables (or a sampling plan to execute).

---

## Step 6: Update the decision model

This is an inline synthesis step (no separate skill).

Feed the narrowed ranges from Step 5 back into the decomposition from Step 2:

1. **Recalculate:** Update the combined estimate using new ranges
2. **Compare:** Show before vs. after — how much did uncertainty shrink?
3. **Decide:** Is the remaining uncertainty small enough to act?
   - If yes → recommend the decision and state confidence level
   - If no → identify the next highest-EVI variable and loop back to Step 5
4. **Document:** Capture the full measurement chain, decision rationale, and remaining uncertainties

**Output:** Final measurement analysis with decision recommendation.

---

## Save output

Offer to save the full measurement analysis. **Resolve the destination — never hand-build it from `📂 Context/Work/.current`:** run `bash bin/memory/list-active-projects.sh --json`. If exactly one project resolves `ok`, use its `project_path`. If more than one is active, ask which this belongs to (AGENTS.md → How to Use Project State and Save Artifacts), then `bash bin/memory/resolve-project.sh --project {slug} --json`. If none, ask "Which project does this belong to? (or type `new`)". Save to `{project_path}/YYMMDD-measurement-title.md`.

The saved document should include:
- The original intangible and its clarification chain
- The decomposition model with all factors
- Before/after confidence intervals
- EVI analysis showing which variables were worth measuring
- Final decision recommendation with stated confidence
- Remaining uncertainties and what would change the decision
