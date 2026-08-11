---
name: metric-drop
description: >-
  Use when a metric fell and nobody knows why — confirming the drop is real before investigating it, decomposing it into drivers, dating the *break*, segmenting the culprit, and leaving with ranked testable hypotheses rather than a theory. Not for defining the metric and its guardrails before work starts (`success-metric`), instrumenting the events a diagnosis would need (`tracking-schema`), or reviewing a finished experiment's writeup (`feature-writeup`).
---

# Diagnose why a metric dropped

Never stop at "it dropped." Every run ends naming which driver, which segment, when it broke, and what would confirm the cause. Take the simplest explanation the evidence supports, and label every conclusion High, Medium, or Low confidence.

## Step 1 — Gather the inputs

Get the metric's definition and formula, the baseline and current values with the window, the comparison periods available, the tables and key fields, the dimensions worth segmenting on, and any known events (releases, promos, incidents, price changes, seasonality). Ask only for what's missing; where the schema is unknown, ask for the minimum fields and proceed in pseudocode.

Done when the formula is written as an equation and the drop is stated as baseline → current with a percentage and a date range.

## Step 2 — Confirm the drop is real

Recompute the metric from raw events rather than a dashboard, for the analysed period, the prior period, and the same period last year. Then rule out the artifacts: missing ingestion, schema changes, bot traffic, tracking changes, timezone shifts, and one-off outliers. Check seasonality and promo effects against the same window last year.

Done when a period → numerator → denominator → completeness table exists and the verdict is one of: real drop, measurement artifact, or baseline skew — with the reason.

## Step 3 — Decompose into two or three drivers

Derive drivers that multiply or add into the metric straight from its formula (Revenue = traffic × conversion × AOV; AOV = price × units per order). Quantify each driver's change over the same windows, then attribute each one's contribution to the total drop — percentage contribution for multiplicative metrics, delta decomposition for additive.

Done when there is a driver tree and a table of driver → baseline → current → % change → contribution, with the top culprit named.

## Step 4 — Date the break

Trend each driver daily or weekly over at least four to eight weeks — long enough to see what normal looked like. For each, identify when the shift started and whether it was a step change or a gradual slide. A step change points at a release or an incident; a slide points at mix shift or competitive erosion.

Done when every driver has a break date, a pattern (step or gradual), and a list of releases, promos, or outages that landed near that date.

## Step 5 — Segment the culprit driver

Cut the top driver by device, channel, geo, browser, app version, product category, and new versus returning. Rank segments by `impact = segment volume × segment metric delta` — a large delta in a tiny segment explains nothing.

Done when there is an impact-ranked segment table and a stated call: one segment explains most of the drop, or the drop is broad-based.

## Step 6 — Compare a broken segment against a stable one

Pick one segment where the metric held and one where it fell, matched on volume where possible. Compare upstream funnel steps, latency, error rates, user behaviour, and mix shifts between them.

Done when a side-by-side table exists and the three to five most discriminative differences are listed with numbers.

## Step 7 — Convert findings into testable hypotheses

Turn the observations into one to three hypotheses that each predict a specific measurable signature. For each: the hypothesis, the evidence so far, what it predicts, the exact query or breakdown that tests it, what would confirm it, what would refute it, and who runs it. Then list immediate mitigations, the next data to pull, and any rollback or experiment worth considering.

Done when every hypothesis carries both a confirm condition and a refute condition, and each has an owner.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-metric-drop-{metric-slug}.md`. Never hand-build the path.

The doc holds: the metric formula and the drop, the reality verdict, the driver tree with contributions, break dates, the impact-ranked segments, the good-versus-bad comparison, and the ranked hypotheses with confirm/refute tests, owners, and confidence labels.
