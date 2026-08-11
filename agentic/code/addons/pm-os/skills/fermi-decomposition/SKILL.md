---
name: fermi-decomposition
description: >-
  Use when a number is needed and no data exists to look it up — market size, annual cost of a problem, how many users a change reaches — broken into factors that multiply or add, each carrying a 90% range so the *uncertainty* survives to the answer. Also /measure Step 2, decomposing the observables the clarification chain produced. Not for turning a vague intangible into observables first (`clarification-chain`), bounding a median from a handful of real samples (`rule-of-five`), or a funnel-based estimate of one feature's impact (`impact-sizing`).
---

# Estimate an unknown quantity by decomposition

## Step 1 — State the target quantity precisely

Pin what is being estimated, in what units, over what period. "Piano tuners in Chicago" becomes "piano tuners actively earning a living in the Chicago metro this year". "Cost of turnover" becomes "direct plus indirect cost per departure, annualized". Vague targets produce ranges nobody can act on.

Done when the target is one phrase carrying a unit and a time period.

## Step 2 — Choose a decomposition path

Break the target into factors that multiply (or add, for cost stacks) to reach it. Three paths, in order of preference:

- **Direct** — volume × density × conversion. Best when the user knows the constants.
- **Comparison** — anchor to a known quantity ("about the same as X, adjusted for Y"). Use when the constants are unavailable.
- **Iterative** — split into smaller pieces until each is guessable.

Check the user's domain knowledge before committing to a path. A direct path that needs a constant they don't have is a dead end; switch to comparison rather than making the constant up.

Done when the decomposition is written as one equation, and every factor in it is something the user can put a number on.

## Step 3 — Put a 90% range on each factor

For each factor, get a central estimate plus a low and a high the user would bet on at 9:1 odds. Push back on narrow ranges — most people are overconfident, and a range that feels comfortable is usually too tight. Ask what specific scenario would drive the factor to each extreme.

Done when every factor has central, low, and high, and the user has defended at least one range against the 9:1 bet.

## Step 4 — Combine and rank the uncertainty

Multiply the centrals for the point estimate. Multiply all the lows together and all the highs together for the range bounds (add them instead for additive decompositions). Then find which factor is driving the width: the one whose own low-to-high ratio is largest contributes most of the total uncertainty. That factor is what to go measure next.

Done when there is a central estimate, a low–high range, and a named single factor contributing the most uncertainty.

## Step 5 — Sanity-check the order of magnitude

Ask whether the answer is even plausible against a known comparable, and what would have to be true for it to be 10× higher or lower. When the number feels wrong, check in this order: are any ranges too narrow, are the units consistent through the equation, is a factor missing, does it square with base rates for similar quantities.

Done when the estimate has survived a comparison to at least one known reference quantity, or the decomposition has been revised and recombined.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-estimate-{target-slug}.md`. Never hand-build the path.

The doc holds: the target with its units, the decomposition equation, each factor's central and 90% bounds, the combined estimate and range, the factor to measure next, and the sanity check it survived.
