---
name: parity-vs-differentiation
description: >-
  Use when someone says "competitor X just shipped Y — we need it" and the PM must call it: match, differentiate, leapfrog, or skip. The hinge is whether the feature is *table stakes* — proven by lost deals and churn, not by its existence. Not for a full competitor teardown (`netmba-competitor-analysis`), building moats (`moats`), or counter-positioning strategy (`disruption-what-ifs`).
---

# Call match, differentiate, leapfrog, or skip

## Step 1 — Capture the request and our strategy

Get: the competitor feature being pointed at, who's asking, and what triggered the ask — a lost deal, a customer question, a demo, a launch tweet. Then get our product strategy in one or two sentences; without it, "does this fit our strategy" has no referent.

Done when feature, requester, trigger, and the strategy line are all captured.

## Step 2 — Learn what the competitor actually built

Go past the requester's summary: read the competitor's docs, changelog, pricing page, and user reviews. Establish what it does, who it's for, and why *they* built it — their strategy, which is not ours. WebSearch and WebFetch are fair game here.

Done when the description would survive a competitor PM reading it, and their likely reason for building it is stated.

## Step 3 — Classify with evidence

Four classes: **table stakes** (we demonstrably lose deals or users without it), **valuable** (real user need, worth having on its merits), **non-essential** (nice, not driving decisions), **distraction** (serves their strategy, works against ours). The evidence bar: win/loss notes, churn reasons, support asks, user interviews. "The competitor has it" and "sales mentioned it once" don't clear it — if no evidence exists either way, say so and name the cheapest way to get it.

Done when the class is assigned with named evidence, or the missing evidence and how to get it is named instead.

## Step 4 — Pick the move

The move follows the class:

- **Match** (table stakes) — copy the capability, not their UX; meet the expectation in our product's idiom.
- **Differentiate** (valuable, and our users' context differs) — serve the same need our way; include the one-line answer sales gives when asked "do you have Y?"
- **Leapfrog** (valuable, and we hold an advantage they can't easily copy) — only with a feasibility story; a leapfrog without one is a match that ships late.
- **Skip** (non-essential or distraction) — name what we do instead, and the same sales one-liner; a silent gap reads as neglect.

Done when the move matches the Step 3 class, and any differentiate/skip includes the sales one-liner.

## Step 5 — Set the reversal trigger

Name the countable event that would change the call: "three enterprise losses in a quarter naming this feature," "it appears in 10% of churn reasons." Competitive calls rot; the trigger is what keeps this one honest without standing re-litigation.

Done when the trigger is a countable threshold, not "if it becomes a problem."

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-parity-vs-differentiation-{feature-slug}.md`. Never hand-build the path.

The doc holds: the request and trigger, what the competitor built and why, the classification with evidence, the move with its one-liner, the reversal trigger.
