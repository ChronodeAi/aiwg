---
name: feature-writeup
description: >-
  Use when a shipped feature's results writeup is drafted and needs review before it circulates — checking whether the effect is real, whether confounders were ruled out, whether segment results are cherry-picked, and whether the recommendation actually *follows* from the numbers. Not for designing the experiment before it runs (`experiment-design`), diagnosing an unexplained fall in a live metric (`metric-drop`), or estimating a feature's impact before it's built (`impact-sizing`).
---

# Review a feature results writeup

Review the draft as the skeptical reader it will meet — the engineer who built it, the peer whose feature lost the slot, the VP who has to fund the next one. A writeup that survives them is one where every claim traces to a number and every number carries its uncertainty.

## Step 1 — Get the draft and the decision it serves

Ask for the writeup, and for what happens next: ship to everyone, roll back, iterate, or extend the test. The review is calibrated to that decision — a rollback recommendation needs less statistical strength than a permanent ship does.

Done when the draft is in hand and the decision it is meant to trigger is named in one sentence.

## Step 2 — Check whether the effect is real

Work through the statistics before the story:

- Was the primary metric declared before launch, or picked after seeing results?
- Is the effect distinguishable from noise, and is the confidence interval reported rather than a bare point estimate?
- Did the test run its planned duration, or stop when it looked good? Peeking inflates false positives.
- Do the exposure counts match the intended split, and did guardrail metrics hold?

Done when the primary effect has a verdict — real, indistinguishable from noise, or inconclusive — with the specific evidence gap named for anything short of real.

## Step 3 — Hunt confounders and selection effects

Name what else changed during the window: a marketing push, a seasonal peak, a concurrent release, an outage, a pricing change. Check whether assignment was genuinely random and whether any population was excluded partway. Then check the segment analysis for the cherry-pick pattern — a flat overall result rescued by one subgroup that was not specified in advance.

Done when every plausible confounder is listed with whether the draft ruled it out, and any post-hoc segment claim is flagged as exploratory.

## Step 4 — Test whether the recommendation follows

Read the conclusion against the evidence above it. Three failures recur: a recommendation stronger than the data supports, a statistically real effect too small to matter commercially, and an insight with no stated action. Ask what the writeup would have said had the result been the opposite — if the recommendation is unchanged, the analysis was decoration.

Done when the recommendation is graded as supported, overclaimed, or unsupported, with the sentence that earned the grade quoted.

## Step 5 — Deliver feedback, then the rewrite

Give prioritized feedback first: what the draft does well, then the issues in order of how much they threaten the conclusion. Then supply a rewritten version following the structure that survives scrutiny — hypothesis and pre-declared metric, method and exposure, results with intervals, segments marked confirmatory or exploratory, confounders addressed, business impact, and a recommendation matched to the evidence strength. Where a number is missing, use a clearly labelled placeholder and name what has to be pulled to fill it.

Done when every issue raised in Steps 2–4 is either fixed in the rewrite or carried as an explicit open question, and no placeholder is left unlabelled.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-results-review-{feature-slug}.md`. Never hand-build the path.

The doc holds: the decision at stake, the prioritized feedback, the reality verdict on the primary effect, the confounder list, the recommendation grade, and the rewritten writeup with its open questions.
