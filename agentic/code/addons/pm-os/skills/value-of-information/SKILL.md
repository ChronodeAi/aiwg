---
name: value-of-information
description: >-
  Use when the question is measure-more versus decide-now and the research spend needs a number — the *ceiling* any information could be worth, the value of one specific proposed measurement, and a MEASURE / DON'T MEASURE verdict against its cost. Also /measure Step 4, ranking which of the decomposed uncertainties to reduce first. Not for producing the estimate itself (`fermi-decomposition`), collecting the sample once measuring is justified (`rule-of-five`), or classifying how reversible the decision is (`two-way-door`).
---

# Price the value of reducing an uncertainty

Information has economic value only when it changes a decision. If the same choice gets made whatever the number turns out to be, the measurement is worth zero — check that before anything else.

## Step 1 — Fix the decision, the uncertainty, and the threshold

Get four things: the decision being made, the one quantity it hinges on, the current 90% confidence interval for that quantity, and the threshold that flips the decision. Then get the loss per unit of being on the wrong side of the threshold.

If the decision is already locked — budget committed, announcement made — the value is zero and no arithmetic will change that. Look for a live operational sub-decision instead ("how much inventory", not "whether to launch") and run this on that.

Done when the decision, the 90% bounds, the threshold, and the loss per unit are all written down, and the decision is confirmed to still be open.

## Step 2 — Locate the threshold inside the range

Compute the relative threshold: `RT = (threshold − low bound) ÷ (high bound − low bound)`. Then read the Expected Opportunity Loss Factor off Hubbard's curve, interpolating between rows:

| RT | 0.00 | 0.10 | 0.25 | 0.50 | 0.75 | 0.90 | 1.00 |
|---|---|---|---|---|---|---|---|
| **EOLF** | 0 | 20 | 40 | 50 | 40 | 20 | 0 |

EOLF peaks when the threshold sits mid-range — that is where you are least sure which side you'll land on, and therefore where information is worth most. A threshold at either bound means you already know the answer.

Done when RT and EOLF are both computed and the user can say why the EOLF is high or low for this decision.

## Step 3 — Compute the ceiling

`EVPI = (EOLF ÷ 1000) × loss per unit × (high bound − low bound)`.

This is what perfect knowledge would be worth. No measurement can beat it, so any quote above this number is refused on arithmetic alone.

Done when EVPI is a dollar figure the user has seen compared against the cost of the research they were considering.

## Step 4 — Value the specific measurement proposed

Real measurements narrow a range, they don't eliminate it. Ask what bounds the proposed study would plausibly leave behind, then recompute RT, EOLF, and the same formula on those narrower bounds to get the expected loss remaining after measuring. `EVI = EVPI − that remaining loss`. Measure only when EVI exceeds the measurement's cost.

Resist two shortcuts: treating a wrong decision as one fixed cost regardless of how wrong (the EOLF curve exists because being slightly wrong costs less), and assuming the study removes all uncertainty (that gives EVPI, not EVI).

Done when EVI, the measurement's cost, and an explicit MEASURE or DON'T MEASURE verdict with the net gain are all stated.

## Step 5 — Rank the remaining uncertainties

List the next two or three things that could be measured for this decision and rank them by EVI-to-cost ratio. Highest ratio gets measured first. Cheap partial information usually beats an expensive comprehensive study.

Done when the candidate measurements are ranked by ratio and the user knows which one to commission first.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-voi-{decision-slug}.md`. Never hand-build the path.

The doc holds: the decision and its threshold, the 90% bounds with RT and EOLF, the EVPI ceiling, the proposed measurement's cost and EVI with the verdict, and the ranked list of what to measure next.
