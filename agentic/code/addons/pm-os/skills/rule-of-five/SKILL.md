---
name: rule-of-five
description: >-
  Use when five observations are all the budget or the calendar allows and the median still has to be bounded — a 93.75% confidence interval from the smallest and largest of five *random* samples, with the randomness check that makes the number real. Also /measure Step 5, sampling the uncertainties the value-of-information pass marked worth measuring. Not for estimating a quantity with no samples available at all (`fermi-decomposition`), deciding whether the sample is worth collecting (`value-of-information`), or powering an experiment for significance (`experiment-design`).
---

# Bound a median with five random samples

The rule: there is a 93.75% chance the population median falls between the smallest and largest values in any random sample of 5. It holds because the median can only sit outside that range if all five land above it (0.5⁵ = 3.125%) or all five below (another 3.125%) — 6.25% total, so 93.75% inside. No distribution assumption, no sample-size calculation.

## Step 1 — Define the population exactly

Write what is being sampled and what variable is being read off each sample. "Commute times for the 500 employees at the Chicago office", not "how long people commute". The most common way this rule produces a wrong answer is a population defined loosely enough that the sample quietly comes from a different one.

Done when the population is a countable set a stranger could enumerate, and the variable is one measurable number per member.

## Step 2 — Draw five at random, or stop

Randomness is the whole guarantee. Use a random ID generator, a systematic every-Nth pick, or names from a hat. Convenience picks (the first five you can reach), volunteers, and "only recent" or "only local" selections break the 93.75% and leave you with five anecdotes.

**When random sampling isn't possible, this skill does not apply.** Say so and route to `fermi-decomposition` for an estimate instead of reporting a number the sampling can't support.

Done when five specific members are selected with the selection method named, or the session has routed elsewhere because randomness was unavailable.

## Step 3 — Measure and take min and max

Record all five values with their sample IDs. The smallest and the largest are the interval — no averaging, no dropping outliers. An outlier that widens the range is doing its job.

Done when five labelled values are recorded and the minimum and maximum are identified.

## Step 4 — State the result as a range, with its confidence

Report it in one sentence: "I am 93.75% confident the median [population] is between [min] and [max]." Three failures to avoid: reporting the average of the five as "the median", quoting the bounds without the confidence level (the level is the whole value proposition), and adding decimal places the method never earned.

Done when the conclusion is one sentence containing the population, both bounds, and the 93.75%.

## Step 5 — Decide whether the range is good enough

The rule replaces "I have no idea" with a bounded claim. Whether that is enough is a decision question, not a statistics question. Ask three things:

- Is this range narrower than the uncertainty you had an hour ago? Then it was progress regardless of width.
- Can you make the decision anywhere inside this range? Then stop measuring.
- Is the cost of being wrong bigger than the cost of more samples? Then collect more — 8 samples give 99.2%, 10 give 99.8%, and the range tightens as it grows.

Done when the user has stated whether they can decide on this range, and either stopped or named the next sampling step.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-sample-{population-slug}.md`. Never hand-build the path.

The doc holds: the population and variable, the selection method, the five labelled values, the interval with its confidence sentence, the limits that apply (median only, wide range, sampling assumptions), and the decision verdict.
