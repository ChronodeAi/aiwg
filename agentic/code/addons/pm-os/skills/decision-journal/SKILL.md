---
name: decision-journal
description: >-
  Use when a decision is about to be made and needs to go *on the record* — expected outcomes with probabilities, assumptions with base rates, quit conditions, and a review date — so the future review judges the process, not the hindsight. Also /decisions Step 3, taking the causal map and classification as input. Not for auditing a past decision (`decision-audit`) or classifying reversibility (`two-way-door`).
---

# Write the decision journal entry

A journal entry puts the decision *on the record* before the outcome arrives: what was expected, at what odds, resting on which assumptions, with quit conditions armed and a review date set. Written after the fact it's a story; written before, it's the only honest benchmark the future review gets.

Inside `/decisions` this is Step 3: the causal map and classification from Steps 1–2 come in; the journal entry draft carries forward.

## Step 1 — Fix the decision on the page

Write the decision as one committed sentence — what we are doing, by when — plus the alternatives rejected (with one line on why each lost) and who owns the call. A decision without named rejected alternatives will be remembered as inevitable. When arriving from `/decisions`, the decision must address the root cause named in the causal map, not a symptom — say which cause it targets.

Done when the decision is one sentence, at least one rejected alternative is named, and the owner is a person.

## Step 2 — List expected outcomes with probabilities

List 3–5 outcomes from best to worst, each observable ("churn drops below 3% by Q2," not "it goes well"), each with a probability — and the probabilities sum to 100%. The numbers must be the user's own estimates, elicited, not invented for them; push back once if everything clusters at comfortable midpoints.

Done when every outcome is observable, the probabilities are the user's, and they sum to 100%.

## Step 3 — Name the assumptions and their base rates

List the 3–5 assumptions that break the decision if false. For each, hunt a base rate: how often does this kind of thing work out — industry numbers, past attempts here, comparable launches? An assumption with no findable base rate gets flagged "gut only" rather than dressed in a plausible-sounding statistic.

Done when every assumption carries a base rate with its source, or an explicit gut-only flag.

## Step 4 — Arm the quit conditions

Write 2–3 conditions that would trigger abandoning or materially changing the decision — each a metric, a threshold, and a check date. Let the reversibility classification set the tightness: a one-way-door decision needs earlier, stricter triggers; a two-way-door can run lighter with a later first check. "If it's not working" is not a quit condition; "if activation is under 20% on March 1" is. These are decided now, while nobody is defending sunk costs.

Done when every quit condition has metric, threshold, and check date.

## Step 5 — Set the review and leave the results blank

Add an **Actual Results** section, deliberately empty, and set the review date matched to when the Step 2 outcomes become observable. At review, results get compared against the recorded probabilities and assumptions — the entry exists so that comparison judges the process, not the luck. Note where the journal lives so the review can find it.

Done when the results section is explicitly blank, the review date is set, and the journal's location is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-decision-journal-{decision-slug}.md`. Never hand-build the path.

The doc holds: the decision with rejected alternatives and owner, the outcomes with probabilities, the assumptions with base rates, the quit conditions, the empty results section with its review date.
